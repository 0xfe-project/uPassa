/**
 * A self tail call becomes a jump to the top of the function.
 *
 *     f(p0, p1) { ...; tailcall f(a, b) }        f(p0, p1) { ...; p0 = a; p1 = b; jump top }
 *
 * This runs **before** the SSA construction, not after, and that is the whole reason it is a
 * separate file from the passes in `ssa-passes/`. The rewrite introduces assignments to the frame
 * slots — the same names the caller's arguments arrive in — and an assignment to a name that
 * already has a value is precisely what SSA forbids. The construction is what turns those two
 * definitions into a phi. Doing it after would mean hand-writing the phi, and hand-written phis are
 * what produced the bug this pipeline already had once.
 *
 * ── Why the header moves
 *
 * A new block is inserted in front of the old entry, so the loop header has the preheader as one
 * predecessor and the back edge as the other. Without it the header would have only the back edge,
 * and the value the caller passed in would be lost: the phi would have a single operand and be
 * removed as trivial. The preheader has no predecessors, and a read in a block nothing enters
 * stands for itself — so `p0` reaches the phi as `p0`, which is exactly the incoming argument.
 *
 * Only *self* calls are converted. A mutual tail call is not a loop over one function's frame, and
 * the interpreter already runs any tail call in constant stack, so nothing is lost by leaving it.
 */

import type { BasicBlock, BlockId, SSAFunction, ValueId } from "../../src/ssa/ir.ts";
import { defOf } from "../../src/ssa/ir.ts";
import { schemeOps, type SchemeNode } from "./ir.ts";

/** Convert every self tail call in `fn` in place. Returns how many were converted. */
export function convertSelfTailCalls(fn: SSAFunction<SchemeNode>): number {
  const header = fn.blocks.get(fn.entry);
  if (header === undefined) return 0;

  // Where each value in this function is defined, so a callee can be traced back to a `func-ref`.
  const defs = new Map<ValueId, { type: string; [k: string]: unknown }>();
  for (const block of fn.blocks.values()) {
    for (const inst of block.instructions) {
      const d = defOf(inst, schemeOps);
      if (d !== undefined) defs.set(d, inst as { type: string });
    }
  }

  const selfCalls: BasicBlock<SchemeNode>[] = [];
  for (const block of fn.blocks.values()) {
    const term = block.terminator;
    if (term.type !== "tailcall") continue;
    const def = defs.get(term.callee);
    if (def === undefined || def.type !== "func-ref" || def.fn !== fn.id) continue;
    selfCalls.push(block);
  }

  if (selfCalls.length === 0) return 0;

  const preheader: BasicBlock<SchemeNode> = {
    id: freshBlockId(fn),
    instructions: [],
    terminator: { type: "jump", target: header.id },
    predecessors: [],
    successors: [header.id],
  };
  fn.blocks.set(preheader.id, preheader);
  fn.entry = preheader.id;
  header.predecessors = [...header.predecessors, preheader.id];

  for (const block of selfCalls) {
    const term = block.terminator as { type: "tailcall"; callee: ValueId; args: ValueId[] };

    // The arguments are read before any of the slots are written, so `(loop (- n 1) (+ acc 1))`
    // cannot have the second argument see the new `n`. Copies are appended in order and the reads
    // are of the pre-loop values, which is the same thing.
    block.instructions.push(
      ...term.args.map((arg, i) => ({ type: "copy" as const, dest: `p${i}`, src: arg })),
    );

    block.terminator = { type: "jump", target: header.id };
    block.successors = [header.id];
    header.predecessors = [...header.predecessors, block.id];
  }

  return selfCalls.length;
}

/** A block id that is not taken. `$` marks it as the compiler's. */
function freshBlockId(fn: SSAFunction<SchemeNode>): BlockId {
  for (let i = 0; ; i++) {
    const id = `$preheader${i}`;
    if (!fn.blocks.has(id)) return id;
  }
}
