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
