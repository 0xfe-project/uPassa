/**
 * The source interpreter, checked the way the compiler is.
 *
 * It is the baseline the compiled rows are compared against, so it has to be right for the same
 * reason: a baseline that computes something else makes every number in the report meaningless, and
 * would not otherwise be noticeable. It runs every fixture and every benchmark and must print
 * exactly what they say it should.
 *
 * The tail-call test is the one that matters most. Without a trampoline the interpreter overflows
 * the JS stack on a 100,000-iteration loop, and the compiler's advantage would read as "it can run
 * the program at all" — true, and the largest single thing compiling buys, but it would hide how
 * much work compiling saves. A baseline that cannot run the program is not a baseline.
 */

import { describe, expect, test } from "vitest";
import { parse } from "../surface.ts";
import { runTree } from "../tree-interp.ts";
import { PROGRAMS } from "../fixtures/programs.ts";
import { BENCHMARKS } from "../bench/programs.ts";

describe("the source interpreter", () => {
  for (const p of [...PROGRAMS, ...BENCHMARKS]) {
    test(`${p.name} prints what it should`, () => {
      expect(runTree(parse(p.source)).output).toEqual([...p.expected]);
    });
  }

  test("a tail-recursive loop runs without growing the JS stack", () => {
    // 100,000 levels of recursion. Without a trampoline this is a RangeError, and the compiled
    // rows' advantage would read as "it can run the program at all" — true, and the largest single
    // thing compiling buys, but it would hide how much work compiling saves.
    const source = `
(define (count-up i n) (if (= i n) i (count-up (+ i 1) n)))
(print (count-up 0 100000))`;
    const r = runTree(parse(source));
    expect(r.output).toEqual(["100000"]);

    // A frame per call, though — the interpreter cannot reuse one across a tail call, because a
    // closure here holds a reference to the frame it was created in. See the note in `apply`.
    expect(r.stats.frames).toBeGreaterThan(100_000);
  });

  test("it implements every sugar form the source language has", () => {
    // These are exactly the forms the compiler removes one at a time, and the interpreter keeps.
    const source = `
(define (f a b)
  (let ((x (+ a b)))
    (let* ((y (* x 2)))
      (begin
        (when (> y 0) (print y))
        (unless (< y 0) (print (or (and (> x 0) (> y 0)) (not (= x 0)))))
        (cond ((= x 0) 1)
              ((< x 0) 2)
              (else 3))))))
(print (f 3 4))`;
    expect(runTree(parse(source)).output).toEqual(["14", "#t", "3"]);
  });

  test("only #f is false", () => {
    // `()` is true in Scheme, and a test that treats it as false would be a different language.
    const source = "(print (if () 1 2))\n(print (if #f 1 2))\n(print (if 0 1 2))";
    expect(runTree(parse(source)).output).toEqual(["1", "2", "1"]);
  });

  test("let bindings are parallel and let* bindings are sequential", () => {
    // `(let ((a 1) (b a)) b)` cannot see the `a` being bound, so the inner `a` is the outer one.
    const parallel = "(define a 10)\n(print (let ((a 1) (b a)) b))";
    expect(runTree(parse(parallel)).output).toEqual(["10"]);

    const sequential = "(define a 10)\n(print (let* ((a 1) (b a)) b))";
    expect(runTree(parse(sequential)).output).toEqual(["1"]);
  });

  test("an unbound variable is reported, not silently zero", () => {
    expect(() => runTree(parse("(print nowhere)"))).toThrow(/unbound variable: nowhere/);
  });

  test("the counters separate the three things a program allocates", () => {
    const r = runTree(parse("(print (cons 1 (cons 2 ())))"));
    expect(r.stats.allocs).toBe(2);
    expect(r.stats.closures).toBe(0);
  });
});
