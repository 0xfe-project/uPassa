/**
 * Mark the expressions whose value is the function's result.
 *
 * The distinction only matters for calls: a call in tail position can be a jump rather than a
 * return, which is what makes a tail-recursive program run in constant stack. Everything else is
 * marked too, so the lowering has one rule instead of re-deriving tail position from the shape.
 *
 * Tail positions are: a function's body, the last expression of the program, and — once inside a
 * tail position — both branches of an `if`. Nothing else.
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { S13, S14, type S14_Program, type S14_Expr } from "../langs/chain.ts";

/**
 * Wrap `e` as a tail expression.
 *
 * Two nodes are not wrapped, because they have no value of their own — what is in tail position is
 * something inside them:
 *
 * - `if` — each branch. Wrapping the `if` and stopping there would lose the branches.
 * - `let` — the body. The bound value is not in tail position; the body is.
 *
 * Missing the `let` case makes a function whose body ends in a `let` lose its tail call, which
 * shows up as a stack that grows where it should not.
 */
function tail(e: S14_Expr): S14_Expr {
  if (e.type === "If") {
    return { type: "If", cond: e.cond, then: tail(e.then), alt: tail(e.alt) };
  }
  if (e.type === "Let") {
    return { type: "Let", name: e.name, value: e.value, body: tail(e.body) };
  }
  if (e.type === "Tail") return e;
  return { type: "Tail", expr: e };
}

const spec = pass({
  from: S13,
  to: S14,
  rules: {
    Program: {
      Program: (n, rec): S14_Program => ({
        type: "Program",
        defs: n.defs.map((d) => rec(d)),
        body: n.body.map((e, i) => (i === n.body.length - 1 ? tail(rec(e)) : rec(e))),
      }),
    },
    Def: {
      DefFun: (n, rec) => ({
        type: "DefFun",
        name: n.name,
        params: n.params,
        body: tail(rec(n.body)),
      }),
    },
  },
});

export const markTail = buildWalker(spec).run;
export const markTailSpec = spec;
