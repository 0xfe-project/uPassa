/**
 * One-armed `if` becomes a two-armed one, with `void` in the missing branch.
 *
 * After this every `if` has the same shape, so every later pass has one case to handle.
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { S5, S6, type S6_Expr } from "../langs/chain.ts";

const spec = pass({
  from: S5,
  to: S6,
  rules: {
    Expr: {
      IfAlt: (n, rec): S6_Expr => ({
        type: "If",
        cond: rec(n.cond),
        then: rec(n.then),
        alt: { type: "Void" },
      }),
    },
  },
});

export const removeIfAlt = buildWalker(spec).run;
export const removeIfAltSpec = spec;
