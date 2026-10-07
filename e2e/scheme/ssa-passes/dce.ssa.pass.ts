/**
 * Dead code elimination.
 *
 * Two things are removed: blocks nothing reaches, and instructions whose result nothing reads.
 *
 * Liveness is a fixpoint, not one sweep. Removing an instruction can make the instructions feeding
 * it dead in turn, and the reader may be in a block already visited.
 *
 * An instruction is kept if it has an effect or if its result is live. Allocation counts as an
 * effect-free computation: a `cons` nobody reads allocates a value that nothing can observe, and
 * dropping it is exactly what the benchmarks are measuring.
 */

import { ssaPass } from "../../../src/ssa/pass.ts";
import { defOf, getSuccessors, terminatorUses, usesOf } from "../../../src/ssa/ir.ts";
import type { BlockId, ValueId } from "../../../src/ssa/ir.ts";
import { isPure, schemeOps, type SchemeNode } from "../ir.ts";

export const dcePass = ssaPass<SchemeNode>({
  name: "dce",
  run: (fn) => {
    // ── Unreachable blocks ──
    const reachable = new Set<BlockId>();
    const stack: BlockId[] = [fn.entry];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      const block = fn.blocks.get(id);
      if (block === undefined) continue;
      reachable.add(id);
      for (const s of getSuccessors(block.terminator, schemeOps)) stack.push(s);
    }

    let blocksRemoved = 0;
    for (const id of [...fn.blocks.keys()]) {
      if (!reachable.has(id)) {
        fn.blocks.delete(id);
        blocksRemoved++;
      }
    }

    // ── Live values ──
    const live = new Set<ValueId>();

    // A terminator always runs, so everything it reads is live.
    for (const block of fn.blocks.values()) {
      for (const v of terminatorUses(block.terminator, schemeOps)) live.add(v);
    }

    for (;;) {
      let changed = false;
      for (const block of fn.blocks.values()) {
        for (const inst of block.instructions) {
          const dest = defOf(inst, schemeOps);
          const kept = !isPure(inst) || (dest !== undefined && live.has(dest));
          if (!kept) continue;
          for (const v of usesOf(inst, schemeOps)) {
            if (!live.has(v)) {
              live.add(v);
              changed = true;
            }
          }
        }
      }
      if (!changed) break;
    }

    let removed = 0;
    for (const block of fn.blocks.values()) {
      const kept = block.instructions.filter((inst) => {
        const dest = defOf(inst, schemeOps);
        if (!isPure(inst)) return true;
        if (dest === undefined) return true;
        if (live.has(dest)) return true;
        removed++;
        return false;
      });
      block.instructions = kept;
    }

    return {
      changed: removed > 0 || blocksRemoved > 0,
      stats: { instructions: removed, blocks: blocksRemoved },
    };
  },
});
