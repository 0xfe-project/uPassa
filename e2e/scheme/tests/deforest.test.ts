/**
 * Deforestation: a producer consumed by a consumer becomes one loop.
 *
 * Three things are checked, and the third is the one that matters.
 *
 * 1. The rewrite fires where it should, and the intermediate list really is gone — measured by the
 *    allocation count, which is the whole point of the pass.
 * 2. It does not fire where it should not: `build` is a producer of a list, but its emptiness test
 *    is `(= n 0)` rather than `(null? xs)`, so it is not traversing the same thing `fold` is.
 * 3. It does not fire when doing so would reorder the program's output. Fusing interleaves two
 *    traversals; if both functions do something observable, that is a different program.
 */

import { describe, expect, test } from "vitest";
import { runSource } from "../run.ts";
import { BENCHMARKS } from "../bench/programs.ts";

const MAP_FOLD = BENCHMARKS.find((b) => b.name === "map-fold")!.source;

/** The producer and consumer shapes, with the two functions spelled out. */
const shapes = (mapFn: string, foldFn: string, build: string): string => `
(define (map f xs) (if (null? xs) () (cons (f (car xs)) (map f (cdr xs)))))
(define (fold f acc xs) (if (null? xs) acc (fold f (f acc (car xs)) (cdr xs))))
${build}
(print (fold ${foldFn} 0 (map ${mapFn} (cons 1 (cons 2 (cons 3 ()))))))`;

const LIST = "()";

describe("deforestation removes the intermediate list", () => {
  test("the mapped list is never built", () => {
    const withFusion = runSource(MAP_FOLD, [], {});
    const without = runSource(MAP_FOLD, [], { without: ["deforest"] });
    // `build 300` is 300 conses either way. The mapped list is 300 more that only exist without
    // the rewrite.
    expect(without.stats.allocs - withFusion.stats.allocs).toBe(300);
  });

  test("and it is faster for it", () => {
    const withFusion = runSource(MAP_FOLD, [], { optimize: true });
    const without = runSource(MAP_FOLD, [], { optimize: true, without: ["deforest"] });
    expect(withFusion.stats.instructions).toBeLessThan(without.stats.instructions);
  });

  test("the answer is unchanged", () => {
    const withFusion = runSource(MAP_FOLD, [], { optimize: true });
    const without = runSource(MAP_FOLD, [], { optimize: true, without: ["deforest"] });
    expect(withFusion.output).toEqual(without.output);
    expect(withFusion.output).toEqual(["9045050"]);
  });

  test("a producer that does not agree on how to walk is left alone", () => {
    // `build` produces a list, but its emptiness test is `(= n 0)` and its step is `(- n 1)`.
    // Fusing it with `fold` — which tests `(null? xs)` and steps by `cdr` — would be fusing two
    // different traversals.
    const source = `
(define (build n) (if (= n 0) () (cons n (build (- n 1)))))
(define (fold f acc xs) (if (null? xs) acc (fold f (f acc (car xs)) (cdr xs))))
(print (fold (lambda (a b) (+ a b)) 0 (build 5)))`;
    const fused = runSource(source, [], {});
    const plain = runSource(source, [], { without: ["deforest"] });
    expect(fused.output).toEqual(plain.output);
    expect(fused.stats.instructions).toBe(plain.stats.instructions);
  });
});

describe("the effect condition", () => {
  test("a pure consumer fuses, and the answer is the same", () => {
    const source = shapes("(lambda (x) (* x x))", "(lambda (a b) (+ a b))", LIST);
    expect(runSource(source, [], {}).output).toEqual(runSource(source, [], { without: ["deforest"] }).output);
    expect(runSource(source, [], {}).output).toEqual(["14"]);
  });

  test("an effectful consumer does not fuse, because fusing would reorder the output", () => {
    // The mapped function prints and the combining function prints. Unfused, every print from the
    // map happens before any print from the fold. Fused, they interleave. Two different programs.
    const source = `
(define (map f xs) (if (null? xs) () (cons (f (car xs)) (map f (cdr xs)))))
(define (fold f acc xs) (if (null? xs) acc (fold f (f acc (car xs)) (cdr xs))))
(define (p x) (print x))
(print (fold (lambda (a b) (p a)) 0 (map (lambda (x) (p x)) (cons 1 (cons 2 ())))))`;

    const withoutDeforest = runSource(source, [], { without: ["deforest"] });
    const withDeforest = runSource(source, [], {});
    expect(withDeforest.output).toEqual(withoutDeforest.output);
    // The order the unfused program produces, which is the order the source implies.
    expect(withoutDeforest.output).toEqual(["1", "2", "0", "#<void>", "#<void>"]);
  });

  test("a pure producer is enough to make it safe even when the consumer is not", () => {
    // Only one of the two has effects, so the effects still happen once per element in element
    // order — the interleaving does not change what is observed.
    const source = `
(define (map f xs) (if (null? xs) () (cons (f (car xs)) (map f (cdr xs)))))
(define (fold f acc xs) (if (null? xs) acc (fold f (f acc (car xs)) (cdr xs))))
(define (p x) (print x))
(print (fold (lambda (a b) (p a)) 0 (map (lambda (x) (* x x)) (cons 1 (cons 2 ())))))`;
    const withFusion = runSource(source, [], {});
    const without = runSource(source, [], { without: ["deforest"] });
    expect(withFusion.output).toEqual(without.output);
  });

  test("the whole corpus is unaffected", () => {
    for (const b of BENCHMARKS) {
      const withFusion = runSource(b.source, [], { optimize: true });
      const without = runSource(b.source, [], { optimize: true, without: ["deforest"] });
      expect({ benchmark: b.name, output: withFusion.output }).toEqual({
        benchmark: b.name,
        output: without.output,
      });
    }
  });
});
