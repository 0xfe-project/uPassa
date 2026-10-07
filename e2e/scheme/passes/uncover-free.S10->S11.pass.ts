/**
 * Each lambda records the variables it captures from enclosing scopes.
 *
 * This is what closure conversion needs: the set of values to put in the closure. Computing it here
 * — as its own pass, before anything is converted — means closure conversion is a pure reshaping
 * with no analysis in it.
 *
 * Top-level names are **not** captures. A reference to a top-level function from inside a lambda is
 * a global reference, and a closure that captured it would have to capture itself — the definition
 * is not bound yet at the point the closure is built. Excluding them is what makes a self-recursive
 * function liftable.
 *
 * A lambda's body is analysed with a fresh set, and what the body captured (minus the lambda's own
 * parameters) is what the lambda contributes to its enclosing scope. The set is mutated rather than
 * copied as it flows through the children: the threading model visits siblings in order, so
 * accumulating in place is exactly the union, and copying at every variable would be quadratic.
 */

import { pass, sig, buildWalker } from "../../../src/nanopass/index.ts";
import { S10, S11, type S10_Expr, type S11_Expr, type S11_Program } from "../langs/chain.ts";

interface Ctx {
  /** Free variables seen so far in the scope being analysed. Swapped per lambda. */
  free: Set<string>;
  /** Names bound at the top level. A reference to one of these is not a capture. */
  globals: Set<string>;
}

const spec = pass({
  from: S10,
  to: S11,
  sig: sig({ free: new Set<string>(), globals: new Set<string>() } satisfies Ctx),
  init: (): [Ctx] => [{ free: new Set(), globals: new Set() }],
  rules: {
    Program: {
      Program: (n, rec, c): readonly [S11_Program, Ctx] => {
        for (const d of n.defs) c.globals.add(d.name);
        const defs = n.defs.map((d) => rec(d, c)[0]);
        const body = n.body.map((e) => rec(e, c)[0]);
        return [{ type: "Program", defs, body } as S11_Program, c];
      },
    },

    Expr: {
      Var: (n, rec, c): readonly [S11_Expr, Ctx] => {
        c.free.add(n.name);
        return [n as unknown as S11_Expr, c];
      },

      Let: (n, rec, c): readonly [S11_Expr, Ctx] => {
        const [value] = rec(n.value, c);
        const [body] = rec(n.body, c);
        // The name is bound here, so whatever used it is not a capture. Forgetting this makes a
        // local look free, and closure conversion then carries it into the closure's frame — a
        // variable that is no longer bound anywhere by the time the body runs.
        c.free.delete(n.name);
        return [{ type: "Let", name: n.name, value, body }, c];
      },

      Lambda: (n, rec, c): readonly [S11_Expr, Ctx] => {
        const outer = c.free;
        const inner = new Set<string>();
        c.free = inner;
        const [body] = rec(n.body as S10_Expr, c);
        c.free = outer;

        const params = new Set(n.params);
        const captured = [...inner].filter((name) => !params.has(name) && !c.globals.has(name));

        // The lambda contributes its captures to whatever encloses it.
        for (const name of captured) outer.add(name);

        return [{ type: "Lambda", params: n.params, body, free: captured }, c];
      },
    },
  },
});

export const uncoverFree = buildWalker(spec).run;
export const uncoverFreeSpec = spec;
