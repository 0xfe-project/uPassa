/**
 * neg-elim: T1 -> T2. Drop Neg, expressing it as subtraction from zero.
 *
 * (neg x)  =>  (- 0 x)
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { T1, T2, type T2_Expr } from "../langs/toy.lang.ts";

const spec = pass({
  from: T1,
  to: T2,
  rules: {
    Expr: {
      Neg: (n, rec): T2_Expr => ({
        type: "Sub",
        left: { type: "Int", value: 0 },
        right: rec(n.operand),
      }),
    },
  },
});

export const negElim = buildWalker(spec).run;
export const negElimSpec = spec;
