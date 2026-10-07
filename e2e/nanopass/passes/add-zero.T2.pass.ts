/**
 * add-zero: T2 -> T2. Drop adding zero.
 *
 * (+ x 0)  =>  x
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { T2, type T2_Expr } from "../langs/toy.lang.ts";

const spec = pass({
  from: T2,
  to: T2,
  rules: {
    Expr: {
      Add: (n, rec): T2_Expr => {
        const left = rec(n.left);
        const right = rec(n.right);
        if (right.type === "Int" && right.value === 0) return left;
        if (left.type === "Int" && left.value === 0) return right;
        return { type: "Add", left, right };
      },
    },
  },
});

export const addZero = buildWalker(spec).run;
export const addZeroSpec = spec;
