/**
 * n-ary `begin` becomes nested `let`.
 *
 * `(begin a b c)` evaluates `a` then `b` then `c` and yields `c`. Binding each discarded expression
 * to an ignored name preserves that order.
 *
 * `let` is still present at this layer on purpose: `begin` has to disappear *before* `let` does,
 * or there would be nothing left to express sequencing with.
 *
 * The ignore name is the reserved `$ignore` rather than a fresh name. Nothing ever reads it, so it
 * does not need to be unique — and shadowing a name nobody reads cannot change anything.
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { S6, S7, type S7_Expr } from "../langs/chain.ts";

const IGNORE = "$ignore";

const spec = pass({
  from: S6,
  to: S7,
  rules: {
    Expr: {
      Begin: (n, rec): S7_Expr => {
        const exprs = n.exprs;
        if (exprs.length === 0) return { type: "Void" };

        let body = rec(exprs[exprs.length - 1]!);
        for (let i = exprs.length - 2; i >= 0; i--) {
          body = {
            type: "Let",
            bindings: [{ type: "Binding", name: IGNORE, value: rec(exprs[i]!) }],
            body,
          };
        }
        return body;
      },
    },
  },
});

export const normalizeBegin = buildWalker(spec).run;
export const normalizeBeginSpec = spec;
