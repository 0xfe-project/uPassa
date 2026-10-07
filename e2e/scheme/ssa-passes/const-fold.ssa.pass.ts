/**
 * Constant folding.
 *
 * A `prim` whose operands are all constants is computed at compile time. The pass runs to a
 * fixpoint rather than once over the blocks in order: folding `(+ 1 2)` turns it into a constant,
 * which can make the instruction that reads it foldable in turn, and the reader may be in a block
 * that was already visited.
 *
 * Only `prim` is folded. `car` and `cdr` of a known `cons` would fold too, but that is a different
 * rewrite — it removes an allocation — and it belongs with the passes that reason about allocation
 * rather than here.
 */

import { ssaPass } from "../../../src/ssa/pass.ts";
import type { ValueId } from "../../../src/ssa/ir.ts";
import type { PrimOp, SchemeNode } from "../ir.ts";

/** The value of a folded primitive, or `undefined` when the operands do not allow one. */
function evaluate(op: PrimOp, args: readonly (number | boolean)[]): number | boolean | undefined {
  if (op === "null?") return undefined; // its operand is not a number, so it is not folded here

  const [a, b] = args;
  if (typeof a !== "number" || typeof b !== "number") return undefined;

  switch (op) {
    case "add":
      return a + b;
    case "sub":
      return a - b;
    case "mul":
      return a * b;
    case "div":
      return b === 0 ? undefined : Math.trunc(a / b);
    case "mod":
      return b === 0 ? undefined : a % b;
    case "lt":
      return a < b;
    case "le":
      return a <= b;
    case "gt":
      return a > b;
    case "ge":
      return a >= b;
    case "num-eq":
      return a === b;
  }
}

export const constFoldPass = ssaPass<SchemeNode>({
  name: "const-fold",
  run: (fn) => {
    /** value -> the constant it is known to hold. */
    const known = new Map<ValueId, number | boolean>();

    for (const block of fn.blocks.values()) {
      for (const inst of block.instructions) {
        if (inst.type === "const") known.set(inst.dest, inst.value);
      }
    }

    let folded = 0;
    for (;;) {
      let changed = false;
      for (const block of fn.blocks.values()) {
        for (let i = 0; i < block.instructions.length; i++) {
          const inst = block.instructions[i]!;
          if (inst.type !== "prim") continue;

          const args = inst.args.map((a) => known.get(a));
          if (args.some((a) => a === undefined)) continue;

          const value = evaluate(inst.op, args as (number | boolean)[]);
          if (value === undefined) continue;

          // The destination name is kept: it is single-assignment, and every reader still refers
          // to it. Reusing it is what makes the rewrite invisible to everything else.
          block.instructions[i] = { type: "const", dest: inst.dest, value };
          known.set(inst.dest, value);
          folded++;
          changed = true;
        }
      }
      if (!changed) break;
    }

    return { changed: folded > 0, stats: { folded } };
  },
});
