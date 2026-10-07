/**
 * `let` becomes an immediately applied `lambda`.
 *
 *   (let ((a x) (b y)) body)  =>  ((lambda (a b) body) x y)
 *
 * The bindings are parallel in both forms, so this is a pure reshaping. It is also the last sugar
 * pass: what comes out is the core language — `int`, `bool`, `void`, `var`, `lambda`, `app`, `if`.
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { S7, S8, type S8_Expr } from "../langs/chain.ts";

const spec = pass({
  from: S7,
  to: S8,
  rules: {
    Expr: {
      Let: (n, rec): S8_Expr => ({
        type: "App",
        func: {
          type: "Lambda",
          params: n.bindings.map((b) => b.name),
          body: rec(n.body),
        },
        args: n.bindings.map((b) => rec(b.value)),
      }),
    },
  },
});

export const desugarLet = buildWalker(spec).run;
export const desugarLetSpec = spec;
