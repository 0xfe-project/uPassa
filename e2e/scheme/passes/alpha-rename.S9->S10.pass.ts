/**
 * Every binder gets a name that is unique in the whole program.
 *
 * Without this, two different variables can share a name (an inner `x` shadowing an outer one), and
 * every later pass that reasons about names — free-variable analysis, closure conversion — has to
 * redo the scope analysis. Doing it once means they can treat a name as an identity.
 *
 * Top-level definitions keep their names: they are already unique, and renaming them would have to
 * be consistent across every function that refers to them for no gain.
 *
 * A scope map and a counter are threaded through `sig`. Both are per-run: a module-level counter
 * would carry over into the next run and nothing would say so.
 */

import { pass, sig, buildWalker } from "../../../src/nanopass/index.ts";
import { S9, S10, type S10_Expr } from "../langs/chain.ts";

interface Ctx {
  /** Source name -> unique name, innermost binding wins. */
  scope: Map<string, string>;
  /** Next unique suffix. */
  n: number;
}

const spec = pass({
  from: S9,
  to: S10,
  sig: sig({ scope: new Map<string, string>(), n: 0 } satisfies Ctx),
  init: (): [Ctx] => [{ scope: new Map(), n: 0 }],
  rules: {
    Expr: {
      Var: (n, rec, c): readonly [S10_Expr, Ctx] => {
        const renamed = c.scope.get(n.name);
        return [renamed === undefined ? n : { type: "Var", name: renamed }, c];
      },

      Lambda: (n, rec, c): readonly [S10_Expr, Ctx] => {
        // A copy, so the outer scope is untouched when this lambda ends. Threading the *outer*
        // scope back out is what keeps siblings independent.
        const inner = new Map(c.scope);
        const params = n.params.map((p) => {
          const unique = `v${c.n++}`;
          inner.set(p, unique);
          return unique;
        });
        const [body, innerCtx] = rec(n.body, { scope: inner, n: c.n });
        return [
          { type: "Lambda", params, body },
          { scope: c.scope, n: innerCtx.n },
        ];
      },
    },
  },
});

export const alphaRename = buildWalker(spec).run;
export const alphaRenameSpec = spec;
