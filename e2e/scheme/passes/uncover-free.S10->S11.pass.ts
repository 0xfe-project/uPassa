/**
 * Each lambda records the variables it captures from enclosing scopes.
 *
 * This is what closure conversion needs: the set of values to put in the closure. Computing it here
 * — as its own pass, before anything is converted — means closure conversion is a pure reshaping
 * with no analysis in it.
 *
 * The extra value is the set of free variables seen so far. It is **mutated** rather than copied as
 * it flows through the children: the threading model already visits siblings in order, so
 * accumulating in place is exactly the union, and copying at every variable would be quadratic.
 *
 * A lambda starts a fresh set for its body, then contributes `body's free variables minus its own
 * parameters` to the enclosing set.
 */

import { pass, sig, buildWalker } from "../../../src/nanopass/index.ts";
import { S10, S11, type S10_Expr, type S11_Expr } from "../langs/chain.ts";

const spec = pass({
  from: S10,
  to: S11,
  sig: sig(new Set<string>()),
  init: (): [Set<string>] => [new Set<string>()],
  rules: {
    Expr: {
      Var: (n, rec, free): readonly [S11_Expr, Set<string>] => {
        free.add(n.name);
        return [n as unknown as S11_Expr, free];
      },

      Lambda: (n, rec, free): readonly [S11_Expr, Set<string>] => {
        // A fresh set for the body: what the body captures is decided without the enclosing
        // accumulation mixed in.
        const inner = new Set<string>();
        const [body] = rec(n.body as S10_Expr, inner);

        const params = new Set(n.params);
        const captured = [...inner].filter((name) => !params.has(name));

        // The lambda itself contributes its captures to whatever encloses it.
        for (const name of captured) free.add(name);

        return [{ type: "Lambda", params: n.params, body, free: captured }, free];
      },
    },
  },
});

export const uncoverFree = buildWalker(spec).run;
export const uncoverFreeSpec = spec;
