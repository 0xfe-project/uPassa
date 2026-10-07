/**
 * Toy language chain for testing the nanopass framework itself.
 *
 * Deliberately small, but each layer is a real rewrite, and the layers differ in ways that
 * matter to the framework: cross-language vs same-language passes, and a list field.
 *
 *   T0  Int | Var | Add | Sub | Neg | Begin | Seq
 *    |  begin-elim      (cross-language: Begin removed)
 *   T1  Int | Var | Add | Sub | Neg | Seq
 *    |  neg-elim        (cross-language: Neg removed)
 *   T2  Int | Var | Add | Sub | Seq
 *    |  fold-const      (same language)
 *    |  add-zero        (same language)
 *   T2
 */

import { language, derive, list, type Nodes } from "../../../src/nanopass/index.ts";

/**
 * T0: the starting language.
 */
export const T0 = language({
  id: "T0",
  entry: "Expr",
  rules: {
    Expr: {
      Int: { value: "number" },
      Var: { name: "string" },
      Add: { left: "Expr", right: "Expr" },
      Sub: { left: "Expr", right: "Expr" },
      Neg: { operand: "Expr" },
      Begin: { body: "Expr" },
      Seq: { exprs: list("Expr") },
    },
  },
});

/** T1: Begin is gone. */
export const T1 = derive({ id: "T1", base: T0, remove: ["Begin"] });

/** T2: Neg is gone too. */
export const T2 = derive({ id: "T2", base: T1, remove: ["Neg"] });

export type T0_Expr = Nodes<typeof T0>;
export type T1_Expr = Nodes<typeof T1>;
export type T2_Expr = Nodes<typeof T2>;
