/**
 * The recorded function bodies become top-level definitions.
 *
 * A top-level `(define (f x) ...)` arrives here as `(define f (make-closure "fn0" ()))` — a closure
 * with nothing captured, which is just a code pointer under a name. Lifting gives the body back its
 * proper name: `fn0` becomes `f`, and the binding disappears.
 *
 * Bodies that no top-level binding names — closures returned from a function, say — keep their
 * generated label and become definitions under it. That is what makes them reachable at all: after
 * this pass there is no nesting left, so a function can only be referred to by name.
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { S12, S13, type S13_Program, type S13_Def } from "../langs/chain.ts";

const spec = pass({
  from: S12,
  to: S13,
  rules: {
    Program: {
      Program: (n, rec): S13_Program => {
        const pending = new Map(n.fns.map((f) => [f.name, f]));
        const defs: S13_Def[] = [];

        for (const d of n.defs) {
          // A top-level binding of a capture-free closure is a named function.
          if (d.type === "DefVal" && d.value.type === "MakeClosure" && d.value.free.length === 0) {
            const body = pending.get(d.value.fn);
            if (body !== undefined) {
              pending.delete(d.value.fn);
              defs.push({
                type: "DefFun",
                name: d.name,
                params: body.params,
                body: rec(body.body),
              });
              continue;
            }
          }
          defs.push(rec(d));
        }

        // Whatever is left keeps its label. Sorted so the output does not depend on Map iteration
        // order — an unstable order would make the generated code churn between runs.
        for (const label of [...pending.keys()].sort()) {
          const body = pending.get(label)!;
          defs.push({ type: "DefFun", name: label, params: body.params, body: rec(body.body) });
        }

        return { type: "Program", defs, body: n.body.map((e) => rec(e)) };
      },
    },
  },
});

export const liftLambdas = buildWalker(spec).run;
export const liftLambdasSpec = spec;
