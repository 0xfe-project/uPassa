/**
 * Every binder gets a name that is unique in the whole program.
 *
 * Without this, two different variables can share a name (an inner `x` shadowing an outer one), and
 * every later pass that reasons about names — free-variable analysis, closure conversion, and
 * `normalize-let`'s nesting — has to redo the scope analysis. Doing it once means a name is an
 * identity.
 *
 * Top-level definitions keep their names: they are already unique, and renaming them would have to
 * be consistent across every function that refers to them for no gain.
 *
 * A `let`'s bindings are parallel, so a binding's *value* is renamed in the **outer** scope and only
 * the body sees the new names. Getting that backwards would turn `(let ((a x) (b a)) e)` into a
 * reference to the `a` being bound, which is a different program.
 *
 * A scope map and a counter are threaded through `sig`. Both are per-run: a module-level counter
 * would carry over into the next run and nothing would say so.
 */

import { pass, sig, buildWalker } from "../../../src/nanopass/index.ts";
import { S7, S8, type S8_Expr, type S8_Binding } from "../langs/chain.ts";

interface Ctx {
  /** Source name -> unique name, innermost binding wins. */
  scope: Map<string, string>;
  /** Next unique suffix. */
  n: number;
}

const spec = pass({
  from: S7,
  to: S8,
  sig: sig({ scope: new Map<string, string>(), n: 0 } satisfies Ctx),
  init: (): [Ctx] => [{ scope: new Map(), n: 0 }],
  rules: {
    Expr: {
      Var: (n, rec, c): readonly [S8_Expr, Ctx] => {
        const renamed = c.scope.get(n.name);
        return [renamed === undefined ? n : { type: "Var", name: renamed }, c];
      },

      Lambda: (n, rec, c): readonly [S8_Expr, Ctx] => {
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

      Let: (n, rec, c): readonly [S8_Expr, Ctx] => {
        const inner = new Map(c.scope);
        const bindings: S8_Binding[] = n.bindings.map((b) => {
          const unique = `v${c.n++}`;
          // The value is renamed before the new name is in scope — that is what makes the bindings
          // parallel rather than sequential.
          const [value] = rec(b.value, c);
          inner.set(b.name, unique);
          return { type: "Binding", name: unique, value };
        });
        const [body, innerCtx] = rec(n.body, { scope: inner, n: c.n });
        return [
          { type: "Let", bindings, body },
          { scope: c.scope, n: innerCtx.n },
        ];
      },
    },
  },
});

export const alphaRename = buildWalker(spec).run;
export const alphaRenameSpec = spec;
