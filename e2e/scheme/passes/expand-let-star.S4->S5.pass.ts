/**
 * `let*` becomes nested `let`.
 *
 * The difference between them is scoping: `let*` bindings see the ones before them, `let` bindings
 * do not. Nesting one `let` per binding gives exactly that.
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { S4, S5, type S5_Expr } from "../langs/chain.ts";

const spec = pass({
  from: S4,
  to: S5,
  rules: {
    Expr: {
      LetStar: (n, rec): S5_Expr => {
        // Build from the inside out: the last binding is the innermost `let`.
        let body = rec(n.body);
        for (let i = n.bindings.length - 1; i >= 0; i--) {
          const b = n.bindings[i]!;
          body = {
            type: "Let",
            bindings: [{ type: "Binding", name: b.name, value: rec(b.value) }],
            body,
          };
        }
        return body;
      },
    },
  },
});

export const expandLetStar = buildWalker(spec).run;
export const expandLetStarSpec = spec;
