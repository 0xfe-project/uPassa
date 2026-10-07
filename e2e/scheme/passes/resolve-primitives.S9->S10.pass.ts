/**
 * Known operator names become `prim` nodes, with their arity made explicit.
 *
 * `(+ a b)` and `(f a b)` look identical in the source; the difference is only in what `+` means.
 * Resolving that here means every later pass — and the lowering — sees one node for "a primitive
 * operation" instead of re-deciding it.
 *
 * Resolving `+` is also deciding what `(+ x)` means, so the variable-arity forms are settled here
 * rather than left for the IR to choke on. An operator that is given an arity it has no meaning for
 * is an error with the form in the message, not a `prim` node that fails later somewhere else.
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

export class OperatorArityError extends Error {}

const int = (value: number): S10_Expr => ({ type: "Int", value });

/**
 * Rewrite a known operator's operands into the shape its IR op expects.
 *
 * Returns `undefined` when the operator has no such arity, so the caller can report the source form.
 */
function operands(op: string, args: readonly S10_Expr[]): S10_Expr[] | undefined {
  switch (op) {
    case "add":
    case "mul": {
      const identity = op === "add" ? 0 : 1;
      if (args.length === 0) return [int(identity)];
      if (args.length === 1) return [int(identity), args[0]!];
      return args.length === 2 ? [...args] : undefined;
    }
    case "sub":
      // `(- x)` is negation. It is a different source construct from subtraction, and this is where
      // that is decided — the IR has one subtraction and no unary form.
      if (args.length === 1) return [int(0), args[0]!];
      return args.length === 2 ? [...args] : undefined;
    case "div":
    case "mod":
    case "lt":
    case "le":
    case "gt":
    case "ge":
    case "num-eq":
    case "cons":
      return args.length === 2 ? [...args] : undefined;
    case "null?":
    case "car":
    case "cdr":
      return args.length === 1 ? [...args] : undefined;
    default:
      return [...args];
  }
}

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
            const args = operands(
              op,
              n.args.map((a) => rec(a)),
            );
            if (args === undefined) {
              throw new OperatorArityError(`${fn.name} cannot be applied to ${n.args.length} argument(s)`);
            }
            return { type: "Prim", op, args };
          }
        }
        return { type: "App", func: rec(n.func), args: n.args.map((a) => rec(a)) };
      },
    },
  },
});

export const resolvePrimitives = buildWalker(spec).run;
export const resolvePrimitivesSpec = spec;
