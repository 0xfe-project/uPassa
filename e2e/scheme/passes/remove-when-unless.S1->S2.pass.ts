/**
 * `when` and `unless` become `if`.
 *
 * The missing branch is `void`, which is what these forms evaluate to when the test fails.
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { S1, S2, type S2_Expr } from "../langs/chain.ts";

const spec = pass({
  from: S1,
  to: S2,
  rules: {
    Expr: {
      When: (n, rec): S2_Expr => ({
        type: "If",
        cond: rec(n.cond),
        then: rec(n.body),
        alt: { type: "Void" },
      }),
      Unless: (n, rec): S2_Expr => ({
        type: "If",
        cond: rec(n.cond),
        then: { type: "Void" },
        alt: rec(n.body),
      }),
    },
  },
});

export const removeWhenUnless = buildWalker(spec).run;
export const removeWhenUnlessSpec = spec;
