/**
 * Common subexpression elimination, within a block.
 *
 * Two instructions that compute the same thing from the same operands produce the same value, so
 * the second one's readers can read the first one's result instead.
 *
 * The table is cleared at every instruction with an effect. A `call` can write a global, so a
 * `global-ref` before it and one after it are not the same value — and a `print` can run arbitrary
 * code for the same reason. Clearing is the conservative reading and it costs little: the
 * expressions worth eliminating in this IR are arithmetic, and they sit together.
 *
 * `make-closure` is deliberately not a candidate. Two closures with the same code and the same
 * captures are observationally equivalent *here*, because nothing compares identity — but that is a
 * fact about this IR rather than about closures, and merging them is an optimization about
 * allocation, not about common subexpressions.
 */

import { ssaPass } from "../../../src/ssa/pass.ts";
import { defOf, rewriteUses, rewriteTerminatorUses, usesOf, terminatorUses } from "../../../src/ssa/ir.ts";
import type { ValueId } from "../../../src/ssa/ir.ts";
import { isPure, schemeOps, type SchemeNode } from "../ir.ts";

/** A key that is equal exactly when two instructions compute the same value. */
function key(inst: { type: string; [k: string]: unknown }, uses: readonly ValueId[]): string | undefined {
  switch (inst.type) {
    case "prim":
      return `prim:${inst.op}:${uses.join(",")}`;
    case "car":
    case "cdr":
      return `${inst.type}:${uses.join(",")}`;
    case "func-ref":
      return `func-ref:${inst.fn}`;
    case "const":
      return `const:${typeof inst.value}:${String(inst.value)}`;
    case "nil":
      return "nil";
    case "void":
      return "void";
    default:
      return undefined;
  }
}

export const csePass = ssaPass<SchemeNode>({
  name: "cse",
  run: (fn) => {
    let replaced = 0;

    for (const block of fn.blocks.values()) {
      // key -> the value that already holds this computation, in this block.
      const available = new Map<string, ValueId>();

      for (const inst of block.instructions) {
        if (inst.type === "phi") continue;

        if (!isPure(inst)) {
          // It may have changed something the table is based on.
          available.clear();
          continue;
        }

        const dest = defOf(inst, schemeOps);
        if (dest === undefined) continue;

        const uses = usesOf(inst, schemeOps);
        const k = key(inst, uses);
        if (k === undefined) continue;

        const existing = available.get(k);
        if (existing === undefined) {
          available.set(k, dest);
          continue;
        }

        // Everything that read `dest` reads `existing` from now on, and `dest` is left with no
        // readers for DCE to remove. The instruction itself stays: removing it here would mean
        // rewriting the block's own list while walking it.
        for (const other of block.instructions) {
          for (const v of [...usesOf(other, schemeOps)]) {
            if (v === dest) rewriteUses(other, schemeOps, dest, existing);
          }
        }
        for (const v of [...terminatorUses(block.terminator, schemeOps)]) {
          if (v === dest) rewriteTerminatorUses(block.terminator, schemeOps, dest, existing);
        }
        replaced++;
      }
    }

    return { changed: replaced > 0, stats: { replaced } };
  },
});
