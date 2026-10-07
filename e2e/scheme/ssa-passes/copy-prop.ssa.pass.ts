/**
 * Copy propagation.
 *
 * The lowering names a value that is produced in both arms of an `if` by copying it into one
 * variable, and the SSA construction turns each of those copies into a real instruction. Once the
 * phi is in place the copies have done their job and only rename a value, so every read of the
 * destination can read the source instead.
 *
 * The rewrite is collected first and applied second. Applying it as the copies are found would
 * depend on the order blocks happen to be visited in, and a read in a block visited before the copy
 * that defines it would be missed.
 */

import { ssaPass } from "../../../src/ssa/pass.ts";
import { rewriteUses, rewriteTerminatorUses, usesOf, terminatorUses } from "../../../src/ssa/ir.ts";
import type { ValueId } from "../../../src/ssa/ir.ts";
import { isCopy, schemeOps, type SchemeNode } from "../ir.ts";

export const copyPropPass = ssaPass<SchemeNode>({
  name: "copy-prop",
  run: (fn) => {
    // copy destination -> what it is a copy of, with chains followed.
    const alias = new Map<ValueId, ValueId>();

    const resolve = (v: ValueId): ValueId => {
      let cur = v;
      const seen = new Set<ValueId>([cur]);
      for (;;) {
        const next = alias.get(cur);
        if (next === undefined || seen.has(next)) return cur;
        seen.add(next);
        cur = next;
      }
    };

    for (const block of fn.blocks.values()) {
      for (const inst of block.instructions) {
        if (isCopy(inst)) alias.set(inst.dest, resolve(inst.src));
      }
    }

    if (alias.size === 0) return { changed: false };

    let changed = false;
    for (const block of fn.blocks.values()) {
      for (const inst of block.instructions) {
        for (const v of [...usesOf(inst, schemeOps)]) {
          const to = resolve(v);
          if (to !== v) {
            rewriteUses(inst, schemeOps, v, to);
            changed = true;
          }
        }
      }
      const term = block.terminator;
      for (const v of [...terminatorUses(term, schemeOps)]) {
        const to = resolve(v);
        if (to !== v) {
          rewriteTerminatorUses(term, schemeOps, v, to);
          changed = true;
        }
      }
    }

    // The copies have no readers left, so they go. `usesOf` and `rewriteUses` already cover phi
    // operands, so nothing is left pointing at a removed name.
    for (const block of fn.blocks.values()) {
      block.instructions = block.instructions.filter((inst) => {
        if (!isCopy(inst)) return true;
        changed = true;
        return false;
      });
    }

    return { changed, stats: { copies: alias.size } };
  },
});
