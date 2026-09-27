/**
 * (cond [c1 e1] [c2 e2] ... [else e])  →  (if c1 e1 (if c2 e2 e))
 *
 * 右嵌套。没有 else 的话最里层补 (void)。
 *
 * 这条最有意思的地方：handler 在递归进子节点**之外**，还要从后往前把分支串起来 ——
 * 所以 rec 是在循环里被调的，而不是在返回的字面量里。框架不管这个，只看结果。
 */

import type { NodeOf } from "../../src/lang.ts";
import { pass } from "../../src/pass.ts";
import { L2 } from "../langs/L2.lang.ts";
import { L3 } from "../langs/L3.lang.ts";

type OutExpr = NodeOf<typeof L3, "Expr">;

export const removeCond = pass({
  from: L2,
  to: L3,
  rules: {
    Expr: {
      Cond: (n, rec): OutExpr => {
        let acc: OutExpr = n.else !== undefined ? rec(n.else) : { type: "Void" };
        for (let i = n.clauses.length - 1; i >= 0; i--) {
          const clause = n.clauses[i]!;
          acc = {
            type: "If",
            cond: rec(clause.test),
            then: rec(clause.body),
            alt: acc,
          };
        }
        return acc;
      },
    },
  },
});
