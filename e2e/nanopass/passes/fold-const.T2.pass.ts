/**
 * fold-const: T2 -> T2. Fold subtraction of two literals.
 *
 * (- 7 3)  =>  4
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { T2, type T2_Expr } from "../langs/toy.lang.ts";

const spec = pass({
  from: T2,
  to: T2,
  rules: {
    Expr: {
      Sub: (n, rec): T2_Expr => {
        const left = rec(n.left);
        const right = rec(n.right);
        if (left.type === "Int" && right.type === "Int") {
          return { type: "Int", value: left.value - right.value };
        }
        return { type: "Sub", left, right };
      },
    },
  },
});

export const foldConst = buildWalker(spec).run;
export const foldConstSpec = spec;
