/**
 * `(define (f x) e)` becomes `(define f (lambda (x) e))`.
 *
 * After this there is one shape of definition, so every later pass has one case to handle instead
 * of two.
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { S0, S1, type S1_Expr } from "../langs/chain.ts";

const spec = pass({
  from: S0,
  to: S1,
  rules: {
    Def: {
      DefFun: (n, rec) => ({
        type: "DefVal",
        name: n.name,
        value: { type: "Lambda", params: n.params, body: rec(n.body) },
      }),
    },
  },
});

export const desugarDefFun = buildWalker(spec).run;
export const desugarDefFunSpec = spec;
