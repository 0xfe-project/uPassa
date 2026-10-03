/**
 * (if c t)  →  (if c t (void))
 *
 * nanopass 手册里那个例子。这条之后 Lcore 就没有一臂 if 了。
 */

import type { NodeOf } from "../../src/nanopass/lang.ts";
import { pass } from "../../src/nanopass/pass.ts";
import { L5 } from "../langs/L5.lang.ts";
import { L6 } from "../langs/L6.lang.ts";

type OutExpr = NodeOf<typeof L6, "Expr">;

export const removeOneArmedIf = pass({
  from: L5,
  to: L6,
  rules: {
    Expr: {
      IfAlt: (n, rec): OutExpr => ({
        type: "If",
        cond: rec(n.cond),
        then: rec(n.then),
        alt: { type: "Void" },
      }),
    },
  },
});
