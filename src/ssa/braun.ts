/**
 * Braun et al.'s SSA construction.
 *
 * "Simple and Efficient Construction of Static Single Assignment Form"
 * https://pp.info.uni-karlsruhe.de/uploads/publikationen/braun13cc.pdf
 *
 * Phi nodes are placed lazily while renaming, so dominance frontiers never have to be computed.
 *
 * ── Shape
 *
 * One shape in, the same shape out: `SSAFunction<T>`. Operands are **variable names** on the way in
 * and **SSA value names** on the way out; the framework does not distinguish them, it just renames.
 *
 *   toSSA(fn, ops): SSAFunction<T> -> SSAFunction<T>
 *
 * The framework reads and rewrites operands of your nodes through `SSAOps<T>`. Its own nodes (phi,
 * jump, branch, ret, unreachable) it handles itself.
 *
 * ── What the framework assumes
 *
 * - Every node has a `type` field, and none of your tags collide with the reserved ones.
 * - Instructions are **ordered**. This is what makes `x = 1; x = 2` in one block two different SSA
 *   values, and what makes `x = x + 1` read the old `x`. A block is not a set of assignments.
 * - A read that no definition reaches stands for itself. That is how function parameters and
 *   globals pass through: the framework does not model either.
 *
 * ── Names
 *
 * Fresh names are `%0`, `%1`, ... The framework reserves the `%` prefix. It seeds its counter from
 * the names already present in the function, so it will not collide with yours even if you use `%`.
 */

import type {
  SSAFunction,
  BasicBlock,
  Instruction,
  Terminator,
  ValueId,
  BlockId,
  PhiNode,
  SSAOps,
} from "./ir.ts";
import {
  isPhi,
  isBranch,
  isRet,
  isJump,
  isUnreachable,
  getSuccessors,
  defOf,
  usesOf,
  terminatorUses,
  rewriteUses,
  rewriteTerminatorUses,
} from "./ir.ts";

export class BraunError extends Error {}

/** A node that can read a value: an instruction or a terminator. */
type Use<T> = { kind: "inst"; node: Instruction<T> } | { kind: "term"; node: Terminator<T> };

export function toSSA<T>(fn: SSAFunction<T>, ops: SSAOps<T>): SSAFunction<T> {
  return new Braun<T>(fn, ops).run();
}

class Braun<T> {
  private readonly fn: SSAFunction<T>;
  private readonly ops: SSAOps<T>;

  /** Edges, computed from terminators (the blocks' own fields are written back from these). */
  private readonly succs = new Map<BlockId, BlockId[]>();
  private readonly preds = new Map<BlockId, BlockId[]>();

  private readonly sealed = new Set<BlockId>();
  private readonly processed = new Set<BlockId>();

  /** block -> variable -> the value that reads of `variable` resolve to at this point in the block */
  private readonly blockDefs = new Map<BlockId, Map<ValueId, ValueId>>();

  /** block -> variable -> phi still awaiting operands, because the block is not sealed yet */
  private readonly incomplete = new Map<BlockId, Map<ValueId, PhiNode>>();

  /** block -> phis created for it, in creation order. Prepended to the instruction list at the end. */
  private readonly phis = new Map<BlockId, PhiNode[]>();

  /** Which block each phi lives in, so a removed phi can be dropped from that block's list. */
  private readonly phiBlock = new Map<PhiNode, BlockId>();

  /** value -> nodes that read it. Needed to rewire uses when a trivial phi is deleted. */
  private readonly users = new Map<ValueId, Use<T>[]>();

  /** Names already present, so generated names cannot collide. */
  private readonly taken = new Set<ValueId>();
  private counter = 0;

  constructor(fn: SSAFunction<T>, ops: SSAOps<T>) {
    this.fn = fn;
    this.ops = ops;
    this.collectNames();
    this.buildEdges();
  }

  // ───────────────────────── Setup ─────────────────────────

  private collectNames(): void {
    for (const block of this.fn.blocks.values()) {
      for (const inst of block.instructions) {
        const d = defOf(inst, this.ops);
        if (d !== undefined) this.taken.add(d);
        for (const u of usesOf(inst, this.ops)) this.taken.add(u);
      }
      for (const u of terminatorUses(block.terminator, this.ops)) this.taken.add(u);
    }
  }

  private freshName(): ValueId {
    for (;;) {
      const name = `%${this.counter++}`;
      if (!this.taken.has(name)) {
        this.taken.add(name);
        return name;
      }
    }
  }

  /**
   * Derive the edges from terminators, and write them back onto the blocks.
   *
   * Terminators are the source of truth: a block's `predecessors`/`successors` fields are an
   * artifact of the graph, not an input. Recomputing them means the caller does not have to keep
   * them consistent, and they cannot go stale.
   */
  private buildEdges(): void {
    for (const block of this.fn.blocks.values()) {
      const succs = getSuccessors(block.terminator, this.ops);
      this.succs.set(block.id, succs);
      if (!this.preds.has(block.id)) this.preds.set(block.id, []);
    }
    for (const block of this.fn.blocks.values()) {
      for (const s of this.succs.get(block.id) ?? []) {
        const list = this.preds.get(s);
        if (list === undefined) {
          throw new BraunError(`block ${block.id} jumps to ${s}, which does not exist`);
        }
        list.push(block.id);
      }
    }
    for (const block of this.fn.blocks.values()) {
      block.successors = [...(this.succs.get(block.id) ?? [])];
      block.predecessors = [...(this.preds.get(block.id) ?? [])];
    }
  }

  /** Reverse postorder from the entry, over reachable blocks. */
  private computeRPO(): BlockId[] {
    const visited = new Set<BlockId>();
    const post: BlockId[] = [];
    const stack: Array<{ id: BlockId; i: number }> = [{ id: this.fn.entry, i: 0 }];
    visited.add(this.fn.entry);

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const succs = this.succs.get(top.id) ?? [];
      if (top.i < succs.length) {
        const next = succs[top.i++]!;
        if (!visited.has(next) && this.fn.blocks.has(next)) {
          visited.add(next);
          stack.push({ id: next, i: 0 });
        }
      } else {
        post.push(top.id);
        stack.pop();
      }
    }

    return post.reverse();
  }

  // ───────────────────────── Driver ─────────────────────────

  run(): SSAFunction<T> {
    if (!this.fn.blocks.has(this.fn.entry)) {
      throw new BraunError(`entry block ${this.fn.entry} does not exist`);
    }

    // Walk in reverse postorder. Seal a block as soon as every predecessor has been processed —
    // sealing early is what keeps the algorithm from creating phis it does not need.
    const rpo = this.computeRPO();
    for (const id of rpo) {
      this.processBlock(id);
      this.processed.add(id);
      const preds = this.preds.get(id) ?? [];
      if (preds.every((p) => this.processed.has(p))) this.sealBlock(id);
    }

    // Anything still unsealed (a back edge from a block we reached later, say).
    for (const id of rpo) {
      if (!this.sealed.has(id)) this.sealBlock(id);
    }

    // Phis are required to come first in a block; collect them now rather than splicing as we go.
    for (const [id, phis] of this.phis) {
      if (phis.length === 0) continue;
      const block = this.fn.blocks.get(id);
      if (block) block.instructions = [...phis, ...block.instructions];
    }

    return this.fn;
  }

  private processBlock(id: BlockId): void {
    const block = this.fn.blocks.get(id);
    if (!block) return;

    for (const inst of block.instructions) {
      if (isPhi(inst)) continue; // ours; already consistent
      this.renameInstruction(inst, id);
    }

    this.renameTerminator(block, id);
  }

  /**
   * Rename one instruction's operands, then its destination.
   *
   * Order matters. For `x = x + 1` the read of `x` must resolve to the version from *before* this
   * instruction, so every read is rewritten first and only then is the destination renamed.
   */
  private renameInstruction(inst: Instruction<T>, block: BlockId): void {
    // Snapshot: rewriting changes the node, so reading uses while rewriting would be a moving target.
    const reads = [...usesOf(inst, this.ops)];
    for (const v of reads) {
      const renamed = this.readVariable(v, block);
      if (renamed !== v) rewriteUses(inst, this.ops, v, renamed);
    }
    for (const v of usesOf(inst, this.ops)) this.addUser(v, { kind: "inst", node: inst });

    const defined = defOf(inst, this.ops);
    if (defined === undefined) return;

    const fresh = this.freshName();
    this.ops.setDef(inst as T, fresh);
    this.writeVariable(defined, block, fresh);
  }

  private renameTerminator(block: BasicBlock<T>, id: BlockId): void {
    const term = block.terminator;
    const reads = [...terminatorUses(term, this.ops)];
    for (const v of reads) {
      const renamed = this.readVariable(v, id);
      if (renamed !== v) rewriteTerminatorUses(term, this.ops, v, renamed);
    }
    for (const v of terminatorUses(term, this.ops)) this.addUser(v, { kind: "term", node: term });
  }

  // ───────────────────────── Renaming ─────────────────────────

  private readVariable(variable: ValueId, block: BlockId): ValueId {
    const local = this.blockDefs.get(block)?.get(variable);
    if (local !== undefined) return local;
    return this.readVariableRecursive(variable, block);
  }

  private readVariableRecursive(variable: ValueId, block: BlockId): ValueId {
    const preds = this.preds.get(block) ?? [];
    let value: ValueId;

    if (!this.sealed.has(block)) {
      // Not all predecessors are known yet, so the phi's operands cannot be filled in. Create it
      // incomplete; sealing will complete it.
      value = this.addIncompletePhi(variable, block);
    } else if (preds.length === 1) {
      // A single predecessor needs no phi — just read through.
      value = this.readVariable(variable, preds[0]!);
    } else if (preds.length === 0) {
      // No definition reaches this block along any path, so the name stands for itself.
      // This is how parameters and globals pass through; the framework models neither.
      value = variable;
    } else {
      value = this.addPhi(variable, block);
    }

    this.writeVariable(variable, block, value);
    return value;
  }

  private writeVariable(variable: ValueId, block: BlockId, value: ValueId): void {
    let defs = this.blockDefs.get(block);
    if (defs === undefined) {
      defs = new Map();
      this.blockDefs.set(block, defs);
    }
    defs.set(variable, value);
  }

  private addPhi(variable: ValueId, block: BlockId): ValueId {
    const phi: PhiNode = { type: "phi", dest: this.freshName(), incoming: [] };
    this.recordPhi(block, phi);
    this.fillPhi(phi, variable, block);
    return this.tryRemoveTrivialPhi(phi) ?? phi.dest;
  }

  private addIncompletePhi(variable: ValueId, block: BlockId): ValueId {
    const phi: PhiNode = { type: "phi", dest: this.freshName(), incoming: [] };
    this.recordPhi(block, phi);

    let byVariable = this.incomplete.get(block);
    if (byVariable === undefined) {
      byVariable = new Map();
      this.incomplete.set(block, byVariable);
    }
    byVariable.set(variable, phi);

    return phi.dest;
  }

  private fillPhi(phi: PhiNode, variable: ValueId, block: BlockId): void {
    for (const pred of this.preds.get(block) ?? []) {
      const value = this.readVariable(variable, pred);
      phi.incoming.push([pred, value]);
      this.addUser(value, { kind: "inst", node: phi });
    }
  }

  private sealBlock(block: BlockId): void {
    const byVariable = this.incomplete.get(block);
    if (byVariable !== undefined) {
      for (const [variable, phi] of byVariable) {
        this.fillPhi(phi, variable, block);
        this.tryRemoveTrivialPhi(phi);
      }
      this.incomplete.delete(block);
    }
    this.sealed.add(block);
  }

  private recordPhi(block: BlockId, phi: PhiNode): void {
    let list = this.phis.get(block);
    if (list === undefined) {
      list = [];
      this.phis.set(block, list);
    }
    list.push(phi);
    this.phiBlock.set(phi, block);
  }

  // ───────────────────────── Trivial phis ─────────────────────────

  /**
   * A phi whose operands are all the same value (self-references ignored) is a no-op. Rewire its
   * uses to that value and delete it.
   *
   * Returns the replacement if the phi was removed, `undefined` otherwise.
   */
  private tryRemoveTrivialPhi(phi: PhiNode): ValueId | undefined {
    let same: ValueId | undefined;
    for (const [, value] of phi.incoming) {
      if (value === phi.dest) continue; // self-reference
      if (same === undefined) same = value;
      else if (value !== same) return undefined; // two genuinely different values
    }
    // Every operand is the phi itself (or there are none): nothing to replace it with.
    if (same === undefined) return undefined;

    const readers = this.users.get(phi.dest) ?? [];
    for (const use of readers) {
      if (use.kind === "inst") rewriteUses(use.node, this.ops, phi.dest, same);
      else rewriteTerminatorUses(use.node, this.ops, phi.dest, same);
      this.addUser(same, use);
    }
    this.users.delete(phi.dest);

    // Drop the phi from its block.
    const block = this.phiBlock.get(phi);
    if (block !== undefined) {
      const list = this.phis.get(block);
      if (list) {
        const at = list.indexOf(phi);
        if (at >= 0) list.splice(at, 1);
      }
      this.phiBlock.delete(phi);
    }

    // A reader that is itself a phi may have just become trivial.
    for (const use of readers) {
      if (use.kind === "inst" && isPhi(use.node)) {
        const reader = use.node;
        if (this.phiBlock.has(reader)) this.tryRemoveTrivialPhi(reader);
      }
    }

    return same;
  }

  // ───────────────────────── Uses ─────────────────────────

  private addUser(value: ValueId, use: Use<T>): void {
    let list = this.users.get(value);
    if (list === undefined) {
      list = [];
      this.users.set(value, list);
    }
    // Rewriting an operand is idempotent, so a duplicate entry is harmless; but keeping the list
    // free of them keeps the trivial-phi rewire linear.
    for (const existing of list) {
      if (existing.node === use.node && existing.kind === use.kind) return;
    }
    list.push(use);
  }
}
