/**
 * Known operator names become `prim` nodes.
 *
 * `(+ a b)` and `(f a b)` look identical in the source; the difference is only in what `+` means.
 * Resolving that here means every later pass — and the lowering — sees one node for "a primitive
 * operation" instead of re-deciding it.
 *
 * Operator names are reserved: a program cannot shadow `+` with a local binding. That is a real
 * restriction, and it is deliberate — the alternative is scope analysis before every application.
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { S9, S10, type S10_Expr } from "../langs/chain.ts";

/** Source name -> IR op. Names not in here stay ordinary applications. */
export const PRIMITIVE_OPS: Readonly<Record<string, string>> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  modulo: "mod",
  "<": "lt",
  "<=": "le",
  ">": "gt",
  ">=": "ge",
  "=": "num-eq",
  "null?": "null?",
};

/** Primitives that are not arithmetic; the lowering maps them to their own IR nodes. */
export const NON_PRIM_OPS: Readonly<Record<string, string>> = {
  cons: "cons",
  car: "car",
  cdr: "cdr",
};

const spec = pass({
  from: S9,
  to: S10,
  rules: {
    Expr: {
      App: (n, rec): S10_Expr => {
        const fn = n.func;
        if (fn.type === "Var") {
          const op = PRIMITIVE_OPS[fn.name] ?? NON_PRIM_OPS[fn.name];
          if (op !== undefined) {
            return { type: "Prim", op, args: n.args.map((a) => rec(a)) };
          }
        }
        return { type: "App", func: rec(n.func), args: n.args.map((a) => rec(a)) };
      },
    },
  },
});

export const resolvePrimitives = buildWalker(spec).run;
export const resolvePrimitivesSpec = spec;
