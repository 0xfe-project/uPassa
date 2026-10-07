/**
 * A `let` with n bindings becomes n nested `let`s with one binding each.
 *
 *   (let ((a x) (b y)) body)  =>  (let a x (let b y body))
 *
 * The bindings were parallel; the nested form is sequential, so this is only sound because
 * alpha-rename has already run: `y` cannot refer to `a`, because nothing else is called `a`. That
 * is the whole reason for the ordering, and it is why this pass does no renaming of its own.
 *
 * The point of the flattening is that the core language ends up with one binder per node. Every
 * later pass — and the lowering — then has one shape to handle instead of two.
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { S8, S9, type S9_Expr } from "../langs/chain.ts";

const spec = pass({
  from: S8,
  to: S9,
  rules: {
    Expr: {
      Let: (n, rec): S9_Expr => {
        let body = rec(n.body);
        // Innermost last: the first binding ends up outermost, which is the order the values are
        // evaluated in.
        for (let i = n.bindings.length - 1; i >= 0; i--) {
          const b = n.bindings[i]!;
          body = { type: "Let", name: b.name, value: rec(b.value), body };
        }
        return body;
      },
    },

    // `Binding` only ever appears inside a `Let`, and every `Let` is handled above, so this is
    // unreachable. The walker needs a rule for it anyway — it cannot know a production is
    // unreachable — and throwing is better than generating an identity for a node that has no
    // counterpart in S9.
    Binding: {
      Binding: (): never => {
        throw new Error("normalize-let: a Binding reached the walker; every Let should be handled");
      },
    },
  },
});

export const normalizeLet = buildWalker(spec).run;
export const normalizeLetSpec = spec;
