/**
 * Surface syntax to S0.
 *
 * The reader produces s-expressions; this turns them into the language the first pass expects.
 * Keeping the two apart means the reader stays a reader — it does not need to know what `let*` is —
 * and this step is where "which form is which" lives, in one place.
 *
 * Recognised forms: `define` (both shapes), `lambda`, `if`, `let`, `let*`, `cond`, `and`, `or`,
 * `not`, `when`, `unless`, `begin`. Everything else that looks like a call is an application, so
 * `+` is just a variable here; a later pass resolves the known operator names.
 */

import { read, isList, isSymbol, items, ReadError, print, type SExpr } from "./reader.ts";
import type { S0_Program, S0_Expr, S0_Def } from "./langs/chain.ts";

export class SurfaceError extends Error {}

const RESERVED = new Set([
  "define",
  "lambda",
  "if",
  "let",
  "let*",
  "cond",
  "and",
  "or",
  "not",
  "when",
  "unless",
  "begin",
]);

function fail(message: string, form: SExpr): never {
  throw new SurfaceError(`${message}: ${print(form)}`);
}

/** A symbol in head position, or undefined. */
function head(e: SExpr): string | undefined {
  if (!isList(e)) return undefined;
  const first = e.items[0];
  return first !== undefined && isSymbol(first) ? first.name : undefined;
}

/** The parameters of a `lambda` or `define` header. */
function params(form: SExpr): string[] {
  if (!isList(form)) fail("expected a parameter list", form);
  return form.items.map((p) => (isSymbol(p) ? p.name : fail("parameter must be a symbol", p)));
}

/** A `let`-style binding list: `((a x) (b y))`. */
function bindings(form: SExpr): Array<{ type: "Binding"; name: string; value: S0_Expr }> {
  if (!isList(form)) fail("expected a binding list", form);
  return form.items.map((b) => {
    if (!isList(b) || b.items.length !== 2) fail("binding must be (name value)", b);
    const name = b.items[0]!;
    if (!isSymbol(name)) fail("binding name must be a symbol", name);
    return { type: "Binding" as const, name: name.name, value: toExpr(b.items[1]!) };
  });
}

/** Wrap several expressions in a `begin`; a single one stays as it is. */
function sequence(exprs: SExpr[]): S0_Expr {
  if (exprs.length === 0) return { type: "Void" } as unknown as S0_Expr;
  if (exprs.length === 1) return toExpr(exprs[0]!);
  return { type: "Begin", exprs: exprs.map(toExpr) };
}

/** Convert one expression. */
export function toExpr(e: SExpr): S0_Expr {
  switch (e.kind) {
    case "int":
      return { type: "Int", value: e.value };
    case "bool":
      return { type: "Bool", value: e.value };
    case "symbol":
      return { type: "Var", name: e.name };
    case "list":
      break;
  }

  // `e` is a list from here on.
  const form: Extract<SExpr, { kind: "list" }> = e;
  const op = head(form);
  const args = form.items.slice(1);

  switch (op) {
    case "lambda":
      return { type: "Lambda", params: params(args[0]!), body: sequence(args.slice(1)) };

    case "if": {
      if (args.length === 2) return { type: "IfAlt", cond: toExpr(args[0]!), then: toExpr(args[1]!) };
      if (args.length === 3) {
        return { type: "If", cond: toExpr(args[0]!), then: toExpr(args[1]!), alt: toExpr(args[2]!) };
      }
      return fail("if takes 2 or 3 arguments", form);
    }

    case "let":
      return { type: "Let", bindings: bindings(args[0]!), body: sequence(args.slice(1)) };

    case "let*":
      return { type: "LetStar", bindings: bindings(args[0]!), body: sequence(args.slice(1)) };

    case "cond": {
      const clauses = args.map((c) => {
        if (!isList(c) || c.items.length < 1) fail("cond clause must be (test body...)", c);
        return {
          type: "Clause" as const,
          test: toExpr(c.items[0]!),
          body: sequence(c.items.slice(1)),
        };
      });
      return { type: "Cond", clauses };
    }

    case "and":
      return { type: "And", args: args.map(toExpr) };

    case "or":
      return { type: "Or", args: args.map(toExpr) };

    case "not":
      if (args.length !== 1) fail("not takes one argument", form);
      return { type: "Not", arg: toExpr(args[0]!) };

    case "when":
      if (args.length < 1) fail("when needs a test", form);
      return { type: "When", cond: toExpr(args[0]!), body: sequence(args.slice(1)) };

    case "unless":
      if (args.length < 1) fail("unless needs a test", form);
      return { type: "Unless", cond: toExpr(args[0]!), body: sequence(args.slice(1)) };

    case "begin":
      return { type: "Begin", exprs: args.map(toExpr) };

    default:
      // Not a special form: an application. `op` being a reserved name here means it was used in a
      // shape we do not support (e.g. `(define ...)` in expression position), which is worth saying.
      if (op !== undefined && RESERVED.has(op)) fail(`${op} is not valid in this position`, form);
      return { type: "App", func: toExpr(form.items[0]!), args: args.map(toExpr) };
  }
}

/** Convert one top-level form. */
function toDef(e: SExpr): S0_Def {
  if (!isList(e)) fail("expected a top-level definition", e);
  if (head(e) !== "define") fail("only define may appear at the top level", e);

  const target = e.items[1];
  if (target === undefined) fail("define needs a name", e);

  if (isList(target)) {
    // (define (f x y) body...)
    const name = target.items[0];
    if (name === undefined || !isSymbol(name)) fail("define needs a function name", target);
    return {
      type: "DefFun",
      name: name.name,
      params: params({ kind: "list", items: target.items.slice(1) }),
      body: sequence(e.items.slice(2)),
    };
  }

  // (define f value)
  if (!isSymbol(target)) fail("define needs a name", target);
  const value = e.items[2];
  if (value === undefined) fail("define needs a value", e);
  return { type: "DefVal", name: target.name, value: toExpr(value) };
}

/** A whole program: leading definitions, then the expressions to evaluate. */
export function toProgram(forms: SExpr[]): S0_Program {
  const defs: S0_Def[] = [];
  const body: S0_Expr[] = [];
  let seenBody = false;

  for (const form of forms) {
    if (head(form) === "define") {
      if (seenBody) fail("definitions must come before other expressions", form);
      defs.push(toDef(form));
    } else {
      seenBody = true;
      body.push(toExpr(form));
    }
  }

  return { type: "Program", defs, body };
}

/** Read source and convert it in one step. */
export function parse(source: string): S0_Program {
  return toProgram(read(source));
}

export { ReadError };
