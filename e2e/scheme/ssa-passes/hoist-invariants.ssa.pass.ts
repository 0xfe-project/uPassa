/**
 * Loop-invariant code motion.
 *
 * An instruction inside a loop whose operands are all defined outside it computes the same thing
 * every iteration, so it can run once in the preheader instead.
 *
 * What is hoisted is deliberately narrow: pure computation — constants, `prim`, `car`, `cdr`,
 * `func-ref`. Allocating instructions (`cons`, `make-closure`) are left alone. Hoisting an
 * allocation out of a loop is a real optimization, but it is an optimization *about allocation*
 * rather than about redundancy, and folding the two together would make the allocation numbers
 * impossible to attribute to either.
 *
 * `global-ref` is left alone too, and for a different reason: a call anywhere in the loop can write
 * a global, so a value read before the call and one read after it are not the same value.
 *
 * Uses the framework's dominator-tree and loop analyses. A loop is a natural loop — a back edge to a
 * block that dominates its source — which is exactly the shape the self tail call conversion
 * produces.
 */

import { ssaPass } from "../../../src/ssa/pass.ts";
import { defOf, usesOf } from "../../../src/ssa/ir.ts";
import type { BasicBlock, BlockId, ValueId } from "../../../src/ssa/ir.ts";
import type { Loop } from "../../../src/ssa/analysis/loops.ts";
import { isPure, schemeOps, type SchemeNode } from "../ir.ts";

/** Instructions worth moving: pure, and not an allocation. */
function hoistable(inst: { type: string }): boolean {
  switch (inst.type) {
    case "const":
    case "void":
    case "nil":
    case "func-ref":
    case "prim":
    case "car":
    case "cdr":
    case "copy":
      return true;
    default:
      return false;
  }
}

export const hoistInvariantsPass = ssaPass<SchemeNode>({
  name: "hoist-invariants",
  requires: ["domtree", "loops"],
  // Instructions move between blocks; no block is added, removed or reconnected.
  invalidates: [],
  run: (fn, analyses) => {
    const loopInfo = analyses.loops;
    if (loopInfo === undefined || loopInfo.loops.size === 0) return { changed: false };

    let hoisted = 0;

    for (const loop of loopInfo.loops.values()) {
      const preheader = findPreheader(fn, loop);
      if (preheader === undefined) continue;

      // Every value defined outside the loop is invariant by definition.
      const invariant = new Set<ValueId>();
      for (const block of fn.blocks.values()) {
        if (loop.blocks.has(block.id)) continue;
        for (const inst of block.instructions) {
          const d = defOf(inst, schemeOps);
          if (d !== undefined) invariant.add(d);
        }
      }

      // Repeat until nothing new becomes invariant: hoisting one instruction can make the one
      // that reads it invariant in turn. Appending in the order they become invariant keeps the
      // preheader in an order where every definition precedes its uses.
      const moved: SchemeNode[] = [];
      for (;;) {
        let progress = false;
        for (const blockId of loop.blocks) {
          const block = fn.blocks.get(blockId);
          if (block === undefined) continue;
          const remaining: typeof block.instructions = [];
          for (const inst of block.instructions) {
            const d = defOf(inst, schemeOps);
            if (
              d !== undefined &&
              hoistable(inst) &&
              isPure(inst) &&
              usesOf(inst, schemeOps).every((u) => invariant.has(u))
            ) {
              invariant.add(d);
              moved.push(inst as SchemeNode);
              progress = true;
            } else {
              remaining.push(inst);
            }
          }
          block.instructions = remaining;
        }
        if (!progress) break;
      }

      if (moved.length > 0) {
        preheader.instructions.push(...moved);
        hoisted += moved.length;
      }
    }

    return { changed: hoisted > 0, stats: { hoisted } };
  },
});

/**
 * The block the loop's invariant code should run in.
 *
 * The preheader has to dominate the header and be outside the loop. The shape the loop conversion
 * produces always has one: a block that is not in the loop, jumps to the header, and goes nowhere
 * else. When there is no such block the loop is skipped rather than given a new one — inserting a
 * block means rewriting every edge into the header, and getting that wrong is worse than not
 * hoisting.
 */
function findPreheader(
  fn: { blocks: Map<BlockId, BasicBlock<SchemeNode>> },
  loop: Loop,
): BasicBlock<SchemeNode> | undefined {
  const header = fn.blocks.get(loop.header);
  if (header === undefined) return undefined;

  for (const predId of header.predecessors) {
    if (loop.blocks.has(predId)) continue;
    const pred = fn.blocks.get(predId);
    if (pred === undefined) continue;
    const term = pred.terminator;
    if (term.type !== "jump" || term.target !== loop.header) continue;
    if (pred.successors.length !== 1) continue;
    return pred;
  }
  return undefined;
}
