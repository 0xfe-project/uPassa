/**
 * Common subexpression elimination, within a block.
 *
 * Two instructions in the same block that compute the same thing from the same operands produce the
 * same value, so the second one's readers can read the first one's result instead. The first
 * dominates the second, so this is always safe.
 *
 * The replacements are collected per block and applied to the **whole function**. Rewriting only
 * the block that found the duplicate leaves the readers in other blocks pointing at the old name,
 * which keeps it live — so DCE cannot remove the instruction, and the next round finds the same
 * duplicate again and reports a change it already made. A pass that reports the same change forever
 * is a pipeline that never reaches a fixpoint.
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
    /** value -> what it is known to equal, built up block by block. */
    const alias = new Map<ValueId, ValueId>();

    for (const block of fn.blocks.values()) {
      // key -> the value that already holds this computation, in this block.
      const available = new Map<string, ValueId>();

      for (const inst of block.instructions) {
        if (inst.type === "phi") continue;

        if (!isPure(inst)) {
          available.clear();
          continue;
        }

        const dest = defOf(inst, schemeOps);
        if (dest === undefined) continue;

        const k = key(inst, usesOf(inst, schemeOps));
        if (k === undefined) continue;

        const existing = available.get(k);
        if (existing === undefined) {
          available.set(k, dest);
          continue;
        }

        alias.set(dest, resolve(alias, existing));
      }
    }

    if (alias.size === 0) return { changed: false };

    for (const block of fn.blocks.values()) {
      for (const inst of block.instructions) {
        for (const v of [...usesOf(inst, schemeOps)]) {
          const to = resolve(alias, v);
          if (to !== v) rewriteUses(inst, schemeOps, v, to);
        }
      }
      for (const v of [...terminatorUses(block.terminator, schemeOps)]) {
        const to = resolve(alias, v);
        if (to !== v) rewriteTerminatorUses(block.terminator, schemeOps, v, to);
      }
    }

    return { changed: true, stats: { replaced: alias.size } };
  },
});

/** Follow a chain of replacements to the value that is actually computed. */
function resolve(alias: ReadonlyMap<ValueId, ValueId>, v: ValueId): ValueId {
  let cur = v;
  const seen = new Set<ValueId>([cur]);
  for (;;) {
    const next = alias.get(cur);
    if (next === undefined || seen.has(next)) return cur;
    seen.add(next);
    cur = next;
  }
}
