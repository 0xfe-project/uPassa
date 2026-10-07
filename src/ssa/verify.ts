/**
 * SSA invariant verifier.
 *
 * Checks that a function is well-formed SSA:
 * - every value is defined exactly once
 * - every use has a definition
 * - definitions dominate their uses (phi operands may come from the predecessor edge)
 * - phis sit at merge points, and their operands match the predecessors
 * - block edges agree with the terminators
 *
 * Run it after every pass. A pass that produces a well-formed tree but invalid SSA is the kind of
 * bug that otherwise surfaces three passes later as a wrong answer.
 *
 * Generic over `T`: it sees your operands through `SSAOps<T>`, so it checks your instructions too.
 */

import type { SSAFunction, BasicBlock, Instruction, Terminator, ValueId, BlockId, SSAOps } from "./ir.ts";
import {
  isPhi,
  isJump,
  isBranch,
  isRet,
  isUnreachable,
  getSuccessors,
  defOf,
  usesOf,
  terminatorUses,
} from "./ir.ts";
import type { DomTree } from "./analysis/domtree.ts";
import { buildDomTree, dominates } from "./analysis/domtree.ts";

export class SSAVerifyError extends Error {
  public readonly details: { errors: string[] } | undefined;

  constructor(message: string, details?: { errors: string[] }) {
    super(message);
    this.details = details;
  }
}

export interface VerifyResult {
  valid: boolean;
  errors: string[];
}

/** Everything the checks need, threaded through so each helper does not re-derive it. */
interface Ctx<T> {
  func: SSAFunction<T>;
  ops: SSAOps<T>;
  errors: string[];
  /** block -> successor block ids, derived from terminators. */
  succs: Map<BlockId, BlockId[]>;
  /** block -> predecessor block ids, derived from terminators. */
  preds: Map<BlockId, BlockId[]>;
}

/** Verify a function. Throws `SSAVerifyError` listing every problem found. */
export function verifySSA<T>(func: SSAFunction<T>, ops: SSAOps<T>): void {
  const errors: string[] = [];

  try {
    const { succs, preds } = deriveEdges(func, ops);
    const ctx: Ctx<T> = { func, ops, errors, succs, preds };

    checkReachability(ctx);
    checkUniqueDefs(ctx);
    checkPhiOperandsDefined(ctx);
    const domTree = buildDomTree(func);
    checkDominance(ctx, domTree);
    checkPhiPlacement(ctx);
    checkEdgesMatchTerminators(ctx);
    checkControlFlow(ctx);
  } catch (e) {
    errors.push(`internal verifier error: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (errors.length > 0) {
    throw new SSAVerifyError(
      `SSA verification failed for function ${func.id}:\n${errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n")}`,
      { errors },
    );
  }
}

/** Verify without throwing. */
export function verifySSASafe<T>(func: SSAFunction<T>, ops: SSAOps<T>): VerifyResult {
  try {
    verifySSA(func, ops);
    return { valid: true, errors: [] };
  } catch (e) {
    if (e instanceof SSAVerifyError) {
      return { valid: false, errors: e.details ? e.details.errors : [e.message] };
    }
    return { valid: false, errors: [String(e)] };
  }
}

/** Edges come from terminators. They are the source of truth; the block fields are derived. */
function deriveEdges<T>(
  func: SSAFunction<T>,
  ops: SSAOps<T>,
): { succs: Map<BlockId, BlockId[]>; preds: Map<BlockId, BlockId[]> } {
  const succs = new Map<BlockId, BlockId[]>();
  const preds = new Map<BlockId, BlockId[]>();

  for (const block of func.blocks.values()) {
    succs.set(block.id, getSuccessors(block.terminator, ops));
    preds.set(block.id, []);
  }
  for (const block of func.blocks.values()) {
    for (const s of succs.get(block.id) ?? []) {
      preds.get(s)?.push(block.id);
    }
  }
  return { succs, preds };
}

function checkReachability<T>(ctx: Ctx<T>): void {
  const { func, errors, succs } = ctx;
  const reachable = new Set<BlockId>([func.entry]);
  const queue: BlockId[] = [func.entry];

  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const s of succs.get(id) ?? []) {
      if (!reachable.has(s) && func.blocks.has(s)) {
        reachable.add(s);
        queue.push(s);
      }
    }
  }

  for (const id of func.blocks.keys()) {
    if (!reachable.has(id)) errors.push(`block ${id} is unreachable from the entry`);
  }
}

function checkUniqueDefs<T>(ctx: Ctx<T>): void {
  const { func, ops, errors } = ctx;
  const defs = new Map<ValueId, { block: BlockId; at: number }>();

  for (const [blockId, block] of func.blocks) {
    for (let i = 0; i < block.instructions.length; i++) {
      const inst = block.instructions[i]!;
      const defined = defOf(inst, ops);
      if (defined === undefined) continue;

      const prev = defs.get(defined);
      if (prev) {
        errors.push(`value ${defined} is defined twice: ${prev.block}:${prev.at} and ${blockId}:${i}`);
      } else {
        defs.set(defined, { block: blockId, at: i });
      }
    }
  }
}

/**
 * Check that every phi operand is defined somewhere in the function.
 *
 * Ordinary operands are allowed to name a value the function never defines — that is a parameter or
 * a global, and the framework models neither, so it cannot tell one from a typo. Reporting those
 * would make the verifier unusable without a declaration mechanism the framework does not have.
 *
 * A phi is different. A phi merges the values reaching it along different edges, so an operand that
 * nothing defines means the merge is broken. (A phi over a free name would have the same operand on
 * every edge, and would already have been dropped as trivial.)
 */
function checkPhiOperandsDefined<T>(ctx: Ctx<T>): void {
  const { func, ops, errors } = ctx;

  const defined = new Set<ValueId>();
  for (const block of func.blocks.values()) {
    for (const inst of block.instructions) {
      const d = defOf(inst, ops);
      if (d !== undefined) defined.add(d);
    }
  }

  for (const [blockId, block] of func.blocks) {
    for (const inst of block.instructions) {
      if (!isPhi(inst)) continue;
      for (const [predBlock, value] of inst.incoming) {
        if (!defined.has(value)) {
          errors.push(`phi in ${blockId} takes ${value} from ${predBlock}, but nothing defines ${value}`);
        }
      }
    }
  }
}

function checkDominance<T>(ctx: Ctx<T>, domTree: DomTree): void {
  const { func, ops, errors } = ctx;

  const defBlock = new Map<ValueId, BlockId>();
  for (const [blockId, block] of func.blocks) {
    for (const inst of block.instructions) {
      const d = defOf(inst, ops);
      if (d !== undefined) defBlock.set(d, blockId);
    }
  }

  for (const [blockId, block] of func.blocks) {
    for (const inst of block.instructions) {
      // A phi's operand is available at the *end of the predecessor edge*, not in the phi's own
      // block, so the dominance requirement is on the predecessor.
      if (isPhi(inst)) {
        for (const [predBlock, value] of inst.incoming) {
          const from = defBlock.get(value);
          if (from !== undefined && !dominates(domTree, from, predBlock)) {
            errors.push(
              `definition of ${value} in ${from} does not dominate the ${predBlock} edge into phi in ${blockId}`,
            );
          }
        }
        continue;
      }

      for (const use of usesOf(inst, ops)) {
        const from = defBlock.get(use);
        if (from !== undefined && !dominates(domTree, from, blockId)) {
          errors.push(`definition of ${use} in ${from} does not dominate its use in ${blockId}`);
        }
      }
    }

    for (const use of terminatorUses(block.terminator, ops)) {
      const from = defBlock.get(use);
      if (from !== undefined && !dominates(domTree, from, blockId)) {
        errors.push(`definition of ${use} in ${from} does not dominate ${blockId}'s terminator`);
      }
    }
  }
}

function checkPhiPlacement<T>(ctx: Ctx<T>): void {
  const { func, errors, preds } = ctx;

  for (const [blockId, block] of func.blocks) {
    let seenNonPhi = false;

    for (const inst of block.instructions) {
      if (!isPhi(inst)) {
        seenNonPhi = true;
        continue;
      }

      if (seenNonPhi) errors.push(`phi in ${blockId} appears after a non-phi instruction`);

      const blockPreds = new Set(preds.get(blockId) ?? []);
      if (blockPreds.size < 2) {
        errors.push(`phi in ${blockId} but the block has ${blockPreds.size} predecessor(s)`);
      }

      const seen = new Set<BlockId>();
      for (const [predBlock] of inst.incoming) {
        if (seen.has(predBlock)) {
          errors.push(`phi in ${blockId} has two operands from predecessor ${predBlock}`);
        }
        seen.add(predBlock);
        if (!blockPreds.has(predBlock)) {
          errors.push(`phi in ${blockId} has an operand from ${predBlock}, which is not a predecessor`);
        }
      }
      for (const p of blockPreds) {
        if (!seen.has(p)) errors.push(`phi in ${blockId} is missing an operand from predecessor ${p}`);
      }
    }
  }
}

function checkEdgesMatchTerminators<T>(ctx: Ctx<T>): void {
  const { func, errors, succs, preds } = ctx;

  if (!func.blocks.has(func.entry)) {
    errors.push(`entry block ${func.entry} does not exist`);
  }

  for (const [blockId, block] of func.blocks) {
    const derivedSuccs = succs.get(blockId) ?? [];
    const actualSuccs = block.successors;
    if (actualSuccs.length !== derivedSuccs.length || actualSuccs.some((s, i) => s !== derivedSuccs[i])) {
      errors.push(
        `block ${blockId}'s successors [${actualSuccs.join(", ")}] do not match its terminator's [${derivedSuccs.join(", ")}]`,
      );
    }

    const derivedPreds = preds.get(blockId) ?? [];
    const actualPreds = block.predecessors;
    if (actualPreds.length !== derivedPreds.length || actualPreds.some((p, i) => p !== derivedPreds[i])) {
      errors.push(
        `block ${blockId}'s predecessors [${actualPreds.join(", ")}] do not match its edges [${derivedPreds.join(", ")}]`,
      );
    }
  }
}

function checkControlFlow<T>(ctx: Ctx<T>): void {
  const { func, ops, errors } = ctx;

  for (const [blockId, block] of func.blocks) {
    const term = block.terminator;
    const derived = getSuccessors(term, ops);

    if (isJump(term) || isBranch(term) || isRet(term) || isUnreachable(term)) {
      const expected = isJump(term) ? 1 : isBranch(term) ? 2 : 0;
      if (derived.length !== expected) {
        errors.push(`block ${blockId}: ${term.type} implies ${expected} successors, got ${derived.length}`);
      }
      continue;
    }

    // A user terminator: we can only check what the ops tell us, and only if they tell us anything.
    if (ops.successors === undefined && derived.length !== 0) {
      errors.push(
        `block ${blockId} has a custom terminator with successors, but SSAOps.successors is not defined`,
      );
    }
  }
}
