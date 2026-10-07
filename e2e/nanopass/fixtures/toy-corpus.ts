/**
 * A corpus of T0 trees, generated exhaustively up to a depth bound.
 *
 * Exhaustive rather than sampled: for a language this small, every shape up to depth 3 fits
 * comfortably, and "all shapes" is a much stronger claim than "some shapes".
 */

import type { T0_Expr } from "../langs/toy.lang.ts";

const leaf = (): T0_Expr[] => [
  { type: "Int", value: 3 },
  { type: "Var", name: "x" },
];

/** Every T0 tree of nesting depth <= `depth`. */
export function allTrees(depth: number): T0_Expr[] {
  if (depth <= 0) return leaf();

  const sub = allTrees(depth - 1);
  const out: T0_Expr[] = [...leaf()];

  for (const l of sub) {
    for (const r of sub) {
      out.push({ type: "Add", left: l, right: r });
      out.push({ type: "Sub", left: l, right: r });
    }
  }
  for (const x of sub) {
    out.push({ type: "Neg", operand: x });
    out.push({ type: "Begin", body: x });
  }

  // Exercise the list field, including the empty list and the singleton.
  out.push({ type: "Seq", exprs: [] });
  for (const a of sub) out.push({ type: "Seq", exprs: [a] });
  for (const a of sub) for (const b of sub) out.push({ type: "Seq", exprs: [a, b] });

  return out;
}

/** The corpus used by the framework tests. */
export const CORPUS: readonly T0_Expr[] = allTrees(2);
