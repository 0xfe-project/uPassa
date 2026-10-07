/**
 * The hand-written baselines, one per benchmark.
 *
 * See `baseline.ts` for what "C-style" means and why loops are written with variables rather than
 * with phis. Each of these must print exactly what the Scheme program it stands for prints; that is
 * checked in `tests/bench.test.ts`, and without it the comparison would be between two different
 * problems.
 */

import type { SSAFunction } from "../../../src/ssa/ir.ts";
import { fn, module, type Blk } from "./baseline.ts";
import { optimizeModule } from "../optimize.ts";
import type { SchemeNode } from "../ir.ts";

/** `print(<value>)` — the only observable effect, and how every benchmark reports its answer. */
function printValue(b: Blk, value: string): void {
  b.call(b.funcRef("print"), [value]);
}

// ───────────────────────── fib ─────────────────────────

/**
 * Direct recursion, written the way it is written in C. There is no better shape for it: the two
 * calls are not in tail position and each needs its own frame.
 */
function fib(): SSAFunction<SchemeNode> {
  return fn("fib")
    .block("entry", (b) => {
      const small = b.prim("lt", "p0", b.const(2));
      b.branch(small, "base", "recurse");
    })
    .block("base", (b) => b.ret("p0"))
    .block("recurse", (b) => {
      const a = b.prim("sub", "p0", b.const(1));
      const x = b.call(b.funcRef("fib"), [a]);
      const c = b.prim("sub", "p0", b.const(2));
      const y = b.call(b.funcRef("fib"), [c]);
      b.ret(b.prim("add", x, y));
    })
    .done();
}

function fibMain(): SSAFunction<SchemeNode> {
  return fn("$main")
    .block("entry", (b) => {
      const v = b.call(b.funcRef("fib"), [b.const(22)]);
      printValue(b, v);
      b.ret();
    })
    .done();
}

// ───────────────────────── loop-sum ─────────────────────────

/**
 * The same sum, as a loop. This is the shape the compiler's own loop conversion produces, so the
 * comparison here is against the best the compiler can do for this program.
 */
function sumTo(): SSAFunction<SchemeNode> {
  return fn("sumTo")
    .block("entry", (b) => {
      b.copy("n", "p0");
      b.copy("acc", b.const(0));
      b.jump("loop");
    })
    .block("loop", (b) => {
      const done = b.prim("num-eq", "n", b.const(0));
      b.branch(done, "done", "body");
    })
    .block("done", (b) => b.ret("acc"))
    .block("body", (b) => {
      // `acc += n` before `n -= 1`: the sum is over the values the loop has seen, and reading the
      // decremented `n` would add the wrong ones.
      b.copy("acc", b.prim("add", "acc", "n"));
      b.copy("n", b.prim("sub", "n", b.const(1)));
      b.jump("loop");
    })
    .done();
}

function sumToMain(): SSAFunction<SchemeNode> {
  return fn("$main")
    .block("entry", (b) => {
      const v = b.call(b.funcRef("sumTo"), [b.const(100000)]);
      printValue(b, v);
      b.ret();
    })
    .done();
}

// ───────────────────────── list-sum ─────────────────────────

/** Build a list of `1..n` by a loop, then sum it by a loop. */
function build(): SSAFunction<SchemeNode> {
  return fn("build")
    .block("entry", (b) => {
      b.copy("n", "p0");
      b.copy("out", b.nil());
      b.jump("loop");
    })
    .block("loop", (b) => {
      const done = b.prim("num-eq", "n", b.const(0));
      b.branch(done, "done", "body");
    })
    .block("done", (b) => b.ret("out"))
    .block("body", (b) => {
      b.copy("out", b.cons("n", "out"));
      b.copy("n", b.prim("sub", "n", b.const(1)));
      b.jump("loop");
    })
    .done();
}

/**
 * The same, with `(modulo (* n 37) 100)` as the element.
 *
 * Its own function rather than a parameter: the sorting benchmark needs values that are not already
 * in order, and a benchmark whose input is sorted measures nothing.
 */
function buildScrambled(): SSAFunction<SchemeNode> {
  return fn("buildScrambled")
    .block("entry", (b) => {
      b.copy("n", "p0");
      b.copy("out", b.nil());
      b.jump("loop");
    })
    .block("loop", (b) => {
      const done = b.prim("num-eq", "n", b.const(0));
      b.branch(done, "done", "body");
    })
    .block("done", (b) => b.ret("out"))
    .block("body", (b) => {
      const v = b.prim("mod", b.prim("mul", "n", b.const(37)), b.const(100));
      b.copy("out", b.cons(v, "out"));
      b.copy("n", b.prim("sub", "n", b.const(1)));
      b.jump("loop");
    })
    .done();
}

function sumList(): SSAFunction<SchemeNode> {
  return fn("sumList")
    .block("entry", (b) => {
      b.copy("xs", "p0");
      b.copy("acc", b.const(0));
      b.jump("loop");
    })
    .block("loop", (b) => {
      const done = b.prim("null?", "xs");
      b.branch(done, "done", "body");
    })
    .block("done", (b) => b.ret("acc"))
    .block("body", (b) => {
      b.copy("acc", b.prim("add", "acc", b.car("xs")));
      b.copy("xs", b.cdr("xs"));
      b.jump("loop");
    })
    .done();
}

function listSumMain(): SSAFunction<SchemeNode> {
  return fn("$main")
    .block("entry", (b) => {
      const xs = b.call(b.funcRef("build"), [b.const(500)]);
      const v = b.call(b.funcRef("sumList"), [xs]);
      printValue(b, v);
      b.ret();
    })
    .done();
}

// ───────────────────────── map-fold ─────────────────────────

/**
 * Sum of the squares of `1..n`, in one loop.
 *
 * The Scheme version builds a list, maps a closure over it to build a second list, and folds a
 * second closure over that. A C programmer writes one loop. The difference between the two rows is
 * therefore the whole cost of the functional style for this program: an intermediate list, a second
 * list, and two calls per element instead of one addition.
 */
function sumSquares(): SSAFunction<SchemeNode> {
  return fn("sumSquares")
    .block("entry", (b) => {
      b.copy("i", "p0");
      b.copy("acc", b.const(0));
      b.jump("loop");
    })
    .block("loop", (b) => {
      const done = b.prim("num-eq", "i", b.const(0));
      b.branch(done, "done", "body");
    })
    .block("done", (b) => b.ret("acc"))
    .block("body", (b) => {
      const square = b.prim("mul", "i", "i");
      b.copy("acc", b.prim("add", "acc", square));
      b.copy("i", b.prim("sub", "i", b.const(1)));
      b.jump("loop");
    })
    .done();
}

function mapFoldMain(): SSAFunction<SchemeNode> {
  return fn("$main")
    .block("entry", (b) => {
      const v = b.call(b.funcRef("sumSquares"), [b.const(300)]);
      printValue(b, v);
      b.ret();
    })
    .done();
}

// ───────────────────────── closures ─────────────────────────

/**
 * Calling a closure in a loop.
 *
 * A closure is the only way this IR can pass a function, so the baseline has one too — built once,
 * outside the loop, and called from it. What the baseline does not have is the recursion, which is
 * what the compiler's loop conversion is measured on here.
 */
function adder(): SSAFunction<SchemeNode> {
  return fn("adder")
    .block("entry", (b) => b.ret(b.makeClosure("addN", ["p0"])))
    .done();
}

function addN(): SSAFunction<SchemeNode> {
  // Called through a closure, so the captured value arrives as f0 and the argument as p0.
  return fn("addN")
    .block("entry", (b) => b.ret(b.prim("add", "p0", "f0")))
    .done();
}

function applyN(): SSAFunction<SchemeNode> {
  return fn("applyN")
    .block("entry", (b) => {
      b.copy("f", "p0");
      b.copy("n", "p1");
      b.copy("acc", b.const(0));
      b.jump("loop");
    })
    .block("loop", (b) => {
      const done = b.prim("num-eq", "n", b.const(0));
      b.branch(done, "done", "body");
    })
    .block("done", (b) => b.ret("acc"))
    .block("body", (b) => {
      b.copy("acc", b.call("f", ["acc"]));
      b.copy("n", b.prim("sub", "n", b.const(1)));
      b.jump("loop");
    })
    .done();
}

function closuresMain(): SSAFunction<SchemeNode> {
  return fn("$main")
    .block("entry", (b) => {
      const f = b.call(b.funcRef("adder"), [b.const(3)]);
      const v = b.call(b.funcRef("applyN"), [f, b.const(100000)]);
      printValue(b, v);
      b.ret();
    })
    .done();
}

// ───────────────────────── insertion-sort ─────────────────────────

/**
 * Sorting a list of `1..n` by insertion, into a fresh list.
 *
 * There is no in-place version to write: this IR has no way to write a pair's field, so a C
 * programmer working in it would rebuild the list exactly as the Scheme version does. The
 * allocation counts therefore match, and what the comparison shows is the cost of the recursion
 * that the Scheme version uses to walk the input.
 */
function insert(): SSAFunction<SchemeNode> {
  return fn("insert")
    .block("entry", (b) => {
      b.copy("x", "p0");
      b.copy("xs", "p1");
      b.jump("loop");
    })
    .block("loop", (b) => {
      const empty = b.prim("null?", "xs");
      b.branch(empty, "append", "compare");
    })
    .block("append", (b) => b.ret(b.cons("x", b.nil())))
    .block("compare", (b) => {
      const head = b.car("xs");
      const fits = b.prim("le", "x", head);
      b.branch(fits, "here", "after");
    })
    .block("here", (b) => b.ret(b.cons("x", "xs")))
    .block("after", (b) => {
      const head = b.car("xs");
      const rest = b.cdr("xs");
      const inserted = b.call(b.funcRef("insert"), ["x", rest]);
      b.ret(b.cons(head, inserted));
    })
    .done();
}

function sort(): SSAFunction<SchemeNode> {
  return fn("sort")
    .block("entry", (b) => {
      b.copy("in", "p0");
      b.copy("out", b.nil());
      b.jump("loop");
    })
    .block("loop", (b) => {
      const done = b.prim("null?", "in");
      b.branch(done, "done", "body");
    })
    .block("done", (b) => b.ret("out"))
    .block("body", (b) => {
      const x = b.car("in");
      b.copy("out", b.call(b.funcRef("insert"), [x, "out"]));
      b.copy("in", b.cdr("in"));
      b.jump("loop");
    })
    .done();
}

function weighted(): SSAFunction<SchemeNode> {
  return fn("weighted")
    .block("entry", (b) => {
      b.copy("xs", "p0");
      b.copy("i", b.const(0));
      b.copy("acc", b.const(0));
      b.jump("loop");
    })
    .block("loop", (b) => {
      const done = b.prim("null?", "xs");
      b.branch(done, "done", "body");
    })
    .block("done", (b) => b.ret("acc"))
    .block("body", (b) => {
      const term = b.prim("mul", b.car("xs"), "i");
      b.copy("acc", b.prim("add", "acc", term));
      b.copy("i", b.prim("add", "i", b.const(1)));
      b.copy("xs", b.cdr("xs"));
      b.jump("loop");
    })
    .done();
}

function insertionSortMain(): SSAFunction<SchemeNode> {
  return fn("$main")
    .block("entry", (b) => {
      const xs = b.call(b.funcRef("buildScrambled"), [b.const(120)]);
      const sorted = b.call(b.funcRef("sort"), [xs]);
      printValue(b, b.call(b.funcRef("sumList"), [sorted]));
      printValue(b, b.call(b.funcRef("weighted"), [sorted]));
      b.ret();
    })
    .done();
}

// ───────────────────────── tak ─────────────────────────

/**
 * Three recursive calls per step, the outer one in tail position.
 *
 * The three inner calls are arguments to the outer one, so they are not tail calls and each needs
 * its own frame — this is the shape of the function, and there is no better one.
 */
function tak(): SSAFunction<SchemeNode> {
  return fn("tak")
    .block("entry", (b) => {
      const recurse = b.prim("lt", "p1", "p0");
      b.branch(recurse, "step", "base");
    })
    .block("base", (b) => b.ret("p2"))
    .block("step", (b) => {
      const a = b.call(b.funcRef("tak"), [b.prim("sub", "p0", b.const(1)), "p1", "p2"]);
      const c = b.call(b.funcRef("tak"), [b.prim("sub", "p1", b.const(1)), "p2", "p0"]);
      const d = b.call(b.funcRef("tak"), [b.prim("sub", "p2", b.const(1)), "p0", "p1"]);
      b.tailcall(b.funcRef("tak"), [a, c, d]);
    })
    .done();
}

function takMain(): SSAFunction<SchemeNode> {
  return fn("$main")
    .block("entry", (b) => {
      const v = b.call(b.funcRef("tak"), [b.const(18), b.const(12), b.const(6)]);
      printValue(b, v);
      b.ret();
    })
    .done();
}

// ───────────────────────── mini-eval ─────────────────────────

/** Build the expression tree by a loop, with `(modulo (* n 37) 100)` as the leaf tag... */
function buildExpr(): SSAFunction<SchemeNode> {
  // The tree alternates add and multiply by parity, exactly as the Scheme version does. It cannot be
  // built by a loop: attaching a child to a pair needs a way to write a pair's field, and this IR
  // has none. A C programmer working in this IR would recurse here too.
  return fn("buildExpr")
    .block("entry", (b) => {
      const root = b.call(b.funcRef("mknode"), [b.const(10)]);
      b.ret(root);
    })
    .done();
}

/** `(tag . (payload))` for a leaf, `(tag . (left right))` for an operation. */
function mknode(): SSAFunction<SchemeNode> {
  return fn("mknode")
    .block("entry", (b) => {
      const leaf = b.prim("num-eq", "p0", b.const(0));
      b.branch(leaf, "isLeaf", "isNode");
    })
    .block("isLeaf", (b) => {
      // `(mkvar 1)`, which is `(cons 1 (cons 1 ()))`.
      b.ret(b.cons(b.const(1), b.cons(b.const(1), b.nil())));
    })
    .block("isNode", (b) => {
      const even = b.prim("num-eq", b.prim("mod", "p0", b.const(2)), b.const(0));
      b.branch(even, "add", "mul");
    })
    .block("add", (b) => {
      const l = b.call(b.funcRef("mknode"), [b.prim("sub", "p0", b.const(1))]);
      const r = b.call(b.funcRef("mknode"), [b.prim("sub", "p0", b.const(1))]);
      b.ret(b.cons(b.const(2), b.cons(l, b.cons(r, b.nil()))));
    })
    .block("mul", (b) => {
      const l = b.call(b.funcRef("mknode"), [b.prim("sub", "p0", b.const(1))]);
      const r = b.call(b.funcRef("mknode"), [b.prim("sub", "p0", b.const(1))]);
      b.ret(b.cons(b.const(3), b.cons(l, b.cons(r, b.nil()))));
    })
    .done();
}

/** Look a name up in an association list, by a loop. */
function lookup(): SSAFunction<SchemeNode> {
  return fn("lookup")
    .block("entry", (b) => {
      b.copy("i", "p0");
      b.copy("env", "p1");
      b.jump("loop");
    })
    .block("loop", (b) => {
      const empty = b.prim("null?", "env");
      b.branch(empty, "missing", "check");
    })
    .block("missing", (b) => b.ret(b.const(0)))
    .block("check", (b) => {
      const pair = b.car("env");
      const hit = b.prim("num-eq", "i", b.car(pair));
      b.branch(hit, "found", "next");
    })
    .block("found", (b) => b.ret(b.cdr(b.car("env"))))
    .block("next", (b) => {
      b.copy("env", b.cdr("env"));
      b.jump("loop");
    })
    .done();
}

/** The evaluator: the same tag dispatch and the same recursion, with direct calls. */
function ev(): SSAFunction<SchemeNode> {
  return fn("ev")
    .block("entry", (b) => {
      const tag = b.car("p0");
      const isLit = b.prim("num-eq", tag, b.const(0));
      b.branch(isLit, "lit", "notLit");
    })
    .block("lit", (b) => b.ret(b.car(b.cdr("p0"))))
    .block("notLit", (b) => {
      const tag = b.car("p0");
      const isVar = b.prim("num-eq", tag, b.const(1));
      b.branch(isVar, "variable", "notVar");
    })
    .block("variable", (b) => b.ret(b.call(b.funcRef("lookup"), [b.car(b.cdr("p0")), "p1"])))
    .block("notVar", (b) => {
      const tag = b.car("p0");
      const isAdd = b.prim("num-eq", tag, b.const(2));
      b.branch(isAdd, "add", "mul");
    })
    .block("add", (b) => {
      const l = b.call(b.funcRef("ev"), [b.car(b.cdr("p0")), "p1"]);
      const r = b.call(b.funcRef("ev"), [b.car(b.cdr(b.cdr("p0"))), "p1"]);
      b.ret(b.prim("mod", b.prim("add", l, r), b.const(1000003)));
    })
    .block("mul", (b) => {
      const l = b.call(b.funcRef("ev"), [b.car(b.cdr("p0")), "p1"]);
      const r = b.call(b.funcRef("ev"), [b.car(b.cdr(b.cdr("p0"))), "p1"]);
      b.ret(b.prim("mod", b.prim("mul", l, r), b.const(1000003)));
    })
    .done();
}

/** `acc += ev(expr, env)`, twenty times, as a loop. */
function repeatEval(): SSAFunction<SchemeNode> {
  return fn("repeatEval")
    .block("entry", (b) => {
      b.copy("n", "p0");
      // The environment is built once, outside the loop. Building it inside would add an
      // allocation per iteration that the Scheme version does not do.
      b.copy("env", b.cons(b.cons(b.const(1), b.const(3)), b.nil()));
      b.copy("acc", b.const(0));
      b.jump("loop");
    })
    .block("loop", (b) => {
      const done = b.prim("num-eq", "n", b.const(0));
      b.branch(done, "done", "body");
    })
    .block("done", (b) => b.ret("acc"))
    .block("body", (b) => {
      const v = b.call(b.funcRef("ev"), ["p1", "env"]);
      b.copy("acc", b.prim("add", "acc", v));
      b.copy("n", b.prim("sub", "n", b.const(1)));
      b.jump("loop");
    })
    .done();
}

function miniEvalMain(): SSAFunction<SchemeNode> {
  return fn("$main")
    .block("entry", (b) => {
      const expr = b.call(b.funcRef("buildExpr"), []);
      const v = b.call(b.funcRef("repeatEval"), [b.const(20), expr]);
      printValue(b, v);
      b.ret();
    })
    .done();
}

// ───────────────────────── The corpus ─────────────────────────

export interface Baseline {
  readonly name: string;
  readonly functions: readonly SSAFunction<SchemeNode>[];
}

export const BASELINES: readonly Baseline[] = [
  { name: "fib", functions: [fib(), fibMain()] },
  { name: "loop-sum", functions: [sumTo(), sumToMain()] },
  { name: "list-sum", functions: [build(), sumList(), listSumMain()] },
  { name: "map-fold", functions: [sumSquares(), mapFoldMain()] },
  { name: "closures", functions: [adder(), addN(), applyN(), closuresMain()] },
  { name: "tak", functions: [tak(), takMain()] },
  // The baseline for `cpstak` is direct-style `tak`: the same function, written the way a C
  // programmer writes it. That is what the benchmark is asking — what CPS costs.
  { name: "cpstak", functions: [tak(), takMain()] },
  {
    name: "mini-eval",
    functions: [buildExpr(), mknode(), lookup(), ev(), repeatEval(), miniEvalMain()],
  },
  {
    name: "insertion-sort",
    functions: [buildScrambled(), insert(), sort(), sumList(), weighted(), insertionSortMain()],
  },
];

/**
 * The module for one baseline, with the built-ins the interpreter needs.
 *
 * The same optimization passes run over it as over compiled code. The baseline is hand-written in
 * C style, but C style still means `n = n - 1` is a copy of a subtraction, and a C compiler removes
 * those. Comparing an unoptimized baseline against optimized compiled code would measure the
 * optimizer twice and call it the cost of functional programming.
 */
export function baselineModule(name: string): Map<string, SSAFunction<SchemeNode>> {
  const b = BASELINES.find((x) => x.name === name);
  if (b === undefined) throw new Error(`no baseline named ${name}`);
  const m = module(b.functions);
  optimizeModule(m);
  return m;
}

/** The entry function every baseline module shares. */
export const BASELINE_ENTRY = "$main";
