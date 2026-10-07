/**
 * `and`, `or`, and `not` become `if`.
 *
 * `and` and `or` short-circuit, so neither can become a function call. `or` also has to evaluate
 * its operand exactly once — writing `(if x x rest)` would evaluate `x` twice — which is what the
 * `let` is for.
 *
 * The operands are walked in a loop rather than by recursing on a synthesised `(and b c)`. Same
 * result, but it keeps the threading (and the counter) explicit instead of depending on the
 * walker's inference for a node that was never in the input.
 *
 * The counter is threaded through `sig` rather than kept in a module variable. Module state
 * survives a run, so a second run would start numbering where the first stopped and nothing would
 * say so.
 */

import { pass, sig, buildWalker } from "../../../src/nanopass/index.ts";
import { S3, S4, type S4_Expr } from "../langs/chain.ts";

/** Names starting with `$` are reserved for the compiler. */
interface Counter {
  n: number;
}

const spec = pass({
  from: S3,
  to: S4,
  sig: sig({ n: 0 } satisfies Counter),
  init: (): [Counter] => [{ n: 0 }],
  rules: {
    Expr: {
      And: (n, rec, c): readonly [S4_Expr, Counter] => {
        const args = n.args;
        if (args.length === 0) return [{ type: "Bool", value: true }, c];

        const vals: S4_Expr[] = [];
        let ctx = c;
        for (const a of args) {
          const [v, next] = rec(a, ctx);
          vals.push(v);
          ctx = next;
        }

        let result = vals[vals.length - 1]!;
        for (let i = vals.length - 2; i >= 0; i--) {
          result = { type: "If", cond: vals[i]!, then: result, alt: { type: "Bool", value: false } };
        }
        return [result, ctx];
      },

      Or: (n, rec, c): readonly [S4_Expr, Counter] => {
        const args = n.args;
        if (args.length === 0) return [{ type: "Bool", value: false }, c];

        const vals: S4_Expr[] = [];
        let ctx = c;
        for (const a of args) {
          const [v, next] = rec(a, ctx);
          vals.push(v);
          ctx = next;
        }

        let result = vals[vals.length - 1]!;
        for (let i = vals.length - 2; i >= 0; i--) {
          const name = `$or${ctx.n++}`;
          result = {
            type: "Let",
            bindings: [{ type: "Binding", name, value: vals[i]! }],
            body: {
              type: "If",
              cond: { type: "Var", name },
              then: { type: "Var", name },
              alt: result,
            },
          };
        }
        return [result, ctx];
      },

      Not: (n, rec, c): readonly [S4_Expr, Counter] => {
        const [arg, next] = rec(n.arg, c);
        return [
          {
            type: "If",
            cond: arg,
            then: { type: "Bool", value: false },
            alt: { type: "Bool", value: true },
          },
          next,
        ];
      },
    },
  },
});

export const removeAndOrNot = buildWalker(spec).run;
export const removeAndOrNotSpec = spec;
