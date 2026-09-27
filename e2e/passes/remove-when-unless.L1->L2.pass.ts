/**
 * (when c e)   →  (if c e (void))
 * (unless c e) →  (if c (void) e)
 *
 * 两条规则，其余由框架重建。
 */

import type { NodeOf } from "../../src/lang.ts";
import { pass } from "../../src/pass.ts";
import { L1 } from "../langs/L1.lang.ts";
import { L2 } from "../langs/L2.lang.ts";

type OutExpr = NodeOf<typeof L2, "Expr">;

export const removeWhenUnless = pass({
  from: L1,
  to: L2,
  rules: {
    Expr: {
      When: (n, rec): OutExpr => ({
        type: "If",
        cond: rec(n.cond),
        then: rec(n.body),
        alt: { type: "Void" },
      }),
      Unless: (n, rec): OutExpr => ({
        type: "If",
        cond: rec(n.cond),
        then: { type: "Void" },
        alt: rec(n.body),
      }),
    },
  },
});
