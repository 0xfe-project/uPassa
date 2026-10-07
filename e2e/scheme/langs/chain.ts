/**
 * The micro-Scheme language chain.
 *
 * Read top to bottom: each layer differs from the one above it by exactly one construct. That is
 * the whole point — a pass that removes one thing is small enough to test on its own, and a bug in
 * it cannot hide behind a bug in another.
 *
 * ── What this language is
 *
 * Direct style, with an explicit tail marker near the end of the chain. Direct style (rather than
 * CPS) keeps the IR shaped like something a C compiler would emit, which is what the benchmarks
 * measure against.
 *
 * Deliberately absent, and why:
 *
 * - `set!`     — mutation forces assignment conversion (boxing) through the whole chain. It buys
 *                nothing for what the benchmarks measure, so it is left out rather than half-done.
 * - `letrec`   — local recursion needs either a knot-tied closure or a lifting pass that runs
 *                before closure conversion. Top-level `define` covers recursion; local loops are
 *                written as top-level helpers.
 * - named let  — same reason.
 * - varargs, `call/cc`, multiple values — out of scope.
 *
 * ── The chain
 *
 *   S0   surface: define, lambda, let, let*, cond, and, or, not, when, unless, begin, ()
 *    |   desugar-def-fun        DefFun -> DefVal holding a Lambda
 *   S1
 *    |   remove-when-unless     when/unless -> if
 *   S2
 *    |   remove-cond            cond -> nested if
 *   S3
 *    |   remove-and-or-not      and/or/not -> if, with a let for `or`'s temporary
 *   S4
 *    |   expand-let-star        let* -> nested let
 *   S5
 *    |   remove-if-alt          (if c t) -> (if c t void)
 *   S6
 *    |   normalize-begin        n-ary begin -> nested let
 *   S7
 *    |   alpha-rename           every binder gets a unique name
 *   S8
 *    |   normalize-let          n bindings -> n nested one-binding lets
 *   S9   core: int, bool, void, (), var, let, lambda, app, if, prim
 *    |   resolve-primitives     known operator names -> prim nodes
 *   S10
 *    |   uncover-free           each lambda records its free variables
 *   S11
 *    |   convert-closures       lambda -> make-closure; app -> call
 *   S12
 *    |   lift-lambdas           nested lambdas become top-level functions
 *   S13  program of top-level functions
 *    |   mark-tail              tail positions get an explicit marker
 *   S14  ready for lowering
 *
 * `let` survives to the end on purpose. Desugaring it into an applied lambda - the usual move -
 * would make closure conversion allocate a closure for every local binding, and the benchmarks are
 * about whether functional code runs like C. A `let` is a local; it stays one.
 *
 * alpha-rename runs before normalize-let because nesting a parallel `let` is only sound once no two
 * binders share a name: `(let ((a x) (b a)) e)` nests correctly only if the inner `a` cannot see the
 * outer one, and unique names are what guarantee that.
 */

import { language, derive, list, type NodeOf } from "../../../src/nanopass/index.ts";

// ───────────────────────── S0: surface ─────────────────────────

export const S0 = language({
  id: "S0",
  entry: "Program",
  rules: {
    Program: { Program: { defs: list("Def"), body: list("Expr") } },
    Def: {
      DefFun: { name: "string", params: list("string"), body: "Expr" },
      DefVal: { name: "string", value: "Expr" },
    },
    Expr: {
      Int: { value: "number" },
      Bool: { value: "boolean" },
      /** The empty list. Surface syntax, so it is here from the start. */
      Nil: {},
      Var: { name: "string" },
      Lambda: { params: list("string"), body: "Expr" },
      App: { func: "Expr", args: list("Expr") },
      If: { cond: "Expr", then: "Expr", alt: "Expr" },
      IfAlt: { cond: "Expr", then: "Expr" },
      Let: { bindings: list("Binding"), body: "Expr" },
      LetStar: { bindings: list("Binding"), body: "Expr" },
      Cond: { clauses: list("Clause") },
      And: { args: list("Expr") },
      Or: { args: list("Expr") },
      Not: { arg: "Expr" },
      When: { cond: "Expr", body: "Expr" },
      Unless: { cond: "Expr", body: "Expr" },
      Begin: { exprs: list("Expr") },
    },
    Binding: { Binding: { name: "string", value: "Expr" } },
    /** A cond clause. `else` is just a Var named "else"; the pass recognises it by name. */
    Clause: { Clause: { test: "Expr", body: "Expr" } },
  },
});

// ───────────────────────── The sugar passes ─────────────────────────

/** S1: `(define (f x) e)` is gone; only `(define f e)` remains. `void` appears — `when` needs it. */
export const S1 = derive({
  id: "S1",
  base: S0,
  remove: ["DefFun"],
  add: { Expr: { Void: {} } },
});

/** S2: `when`/`unless` are gone. */
export const S2 = derive({ id: "S2", base: S1, remove: ["When", "Unless"] });

/** S3: `cond` is gone. */
export const S3 = derive({ id: "S3", base: S2, remove: ["Cond"] });

/** S4: `and`/`or`/`not` are gone. */
export const S4 = derive({ id: "S4", base: S3, remove: ["And", "Or", "Not"] });

/** S5: `let*` is gone. */
export const S5 = derive({ id: "S5", base: S4, remove: ["LetStar"] });

/** S6: one-armed `if` is gone. */
export const S6 = derive({ id: "S6", base: S5, remove: ["IfAlt"] });

/** S7: `begin` is gone (folded into `let`). */
export const S7 = derive({ id: "S7", base: S6, remove: ["Begin"] });

/** S8: every binder has a unique name. No productions change. */
export const S8 = derive({ id: "S8", base: S7 });

/** S9: a `let` binds exactly one name. `Binding` is gone. */
export const S9 = derive({
  id: "S9",
  base: S8,
  remove: ["Let", "Binding"],
  add: { Expr: { Let: { name: "string", value: "Expr", body: "Expr" } } },
});

/** S10: operator names became `prim` nodes. */
export const S10 = derive({
  id: "S10",
  base: S9,
  add: { Expr: { Prim: { op: "string", args: list("Expr") } } },
});

/** S11: lambdas carry their free variables. */
export const S11 = derive({
  id: "S11",
  base: S10,
  remove: ["Lambda"],
  add: { Expr: { Lambda: { params: list("string"), body: "Expr", free: list("string") } } },
});

/** S12: lambdas became closures; applications became calls. Lifted bodies are collected in `fns`. */
export const S12 = derive({
  id: "S12",
  base: S11,
  remove: ["Lambda", "App"],
  add: {
    Program: { Program: { defs: list("Def"), body: list("Expr"), fns: list("FunDef") } },
    FunDef: { FunDef: { name: "string", params: list("string"), body: "Expr" } },
    Expr: {
      MakeClosure: { fn: "string", free: list("Expr") },
      Call: { fn: "Expr", args: list("Expr") },
    },
  },
});

/**
 * S13: the lifted functions are top-level, and `fns` is gone.
 *
 * `DefFun` comes back — it was removed at S1 — because a program is again a list of definitions,
 * some of which are functions. That is the honest shape for what a program is at this point.
 */
export const S13 = derive({
  id: "S13",
  base: S12,
  remove: ["Program"],
  add: {
    Program: { Program: { defs: list("Def"), body: list("Expr") } },
    Def: { DefFun: { name: "string", params: list("string"), body: "Expr" } },
  },
});

/** S14: tail positions are marked. */
export const S14 = derive({
  id: "S14",
  base: S13,
  add: { Expr: { Tail: { expr: "Expr" } } },
});

// ───────────────────────── Types ─────────────────────────

export type S0_Program = NodeOf<typeof S0, "Program">;
export type S0_Expr = NodeOf<typeof S0, "Expr">;
export type S0_Def = NodeOf<typeof S0, "Def">;

export type S1_Def = NodeOf<typeof S1, "Def">;
export type S1_Expr = NodeOf<typeof S1, "Expr">;
export type S2_Expr = NodeOf<typeof S2, "Expr">;
export type S3_Expr = NodeOf<typeof S3, "Expr">;
export type S4_Expr = NodeOf<typeof S4, "Expr">;
export type S5_Expr = NodeOf<typeof S5, "Expr">;
export type S6_Expr = NodeOf<typeof S6, "Expr">;
export type S7_Expr = NodeOf<typeof S7, "Expr">;
export type S8_Expr = NodeOf<typeof S8, "Expr">;
export type S8_Binding = NodeOf<typeof S8, "Binding">;
export type S9_Expr = NodeOf<typeof S9, "Expr">;
export type S10_Expr = NodeOf<typeof S10, "Expr">;
export type S11_Expr = NodeOf<typeof S11, "Expr">;
export type S11_Program = NodeOf<typeof S11, "Program">;
export type S12_Expr = NodeOf<typeof S12, "Expr">;
export type S12_Program = NodeOf<typeof S12, "Program">;
export type S12_FunDef = NodeOf<typeof S12, "FunDef">;
export type S13_Program = NodeOf<typeof S13, "Program">;
export type S13_Def = NodeOf<typeof S13, "Def">;
export type S13_Expr = NodeOf<typeof S13, "Expr">;
export type S14_Program = NodeOf<typeof S14, "Program">;
export type S14_Expr = NodeOf<typeof S14, "Expr">;
