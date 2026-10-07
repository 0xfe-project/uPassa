/**
 * The benchmark corpus.
 *
 * Chosen to be the shapes that decide whether functional code runs like C: direct recursion, a
 * tail-recursive loop, traversal of a heap-allocated list, a closure called in a loop, and an
 * algorithm that allocates as it works. Every one of them has a hand-written C-style equivalent in
 * `baseline.ts`, which is what makes the comparison a comparison rather than a number on its own.
 *
 * Each program prints one number. The expected value is worked out by hand so a benchmark that
 * silently stops computing the right thing fails instead of looking fast.
 */

export interface Benchmark {
  readonly name: string;
  /** What this program is here to measure. */
  readonly measures: string;
  readonly source: string;
  /** What the program prints, worked out by hand from the source. */
  readonly expected: readonly string[];
  /**
   * What the hand-written row is, when it is not simply the same program in C style.
   *
   * `cpstak` needs one: the same function in direct style is what a C programmer writes, and the
   * whole point of the benchmark is what writing it in CPS costs.
   */
  readonly baselineNote?: string;
}

export const BENCHMARKS: readonly Benchmark[] = [
  {
    name: "fib",
    measures: "tree recursion: two non-tail calls per step, no allocation",
    source: `
(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))
(print (fib 22))`,
    expected: ["17711"],
  },
  {
    name: "loop-sum",
    measures: "a tail-recursive loop: arithmetic with no allocation",
    source: `
(define (sum-to n acc) (if (= n 0) acc (sum-to (- n 1) (+ acc n))))
(print (sum-to 100000 0))`,
    expected: ["5000050000"],
  },
  {
    name: "list-sum",
    measures: "traversing a heap-allocated list: car/cdr with no allocation in the loop",
    source: `
(define (build n) (if (= n 0) () (cons n (build (- n 1)))))
(define (sum-list xs acc) (if (null? xs) acc (sum-list (cdr xs) (+ acc (car xs)))))
(print (sum-list (build 500) 0))`,
    expected: ["125250"],
  },
  {
    name: "map-fold",
    measures: "a closure called once per element: allocation in the loop",
    source: `
(define (build n) (if (= n 0) () (cons n (build (- n 1)))))
(define (map f xs) (if (null? xs) () (cons (f (car xs)) (map f (cdr xs)))))
(define (fold f acc xs) (if (null? xs) acc (fold f (f acc (car xs)) (cdr xs))))
(print (fold (lambda (a b) (+ a b)) 0 (map (lambda (x) (* x x)) (build 300))))`,
    expected: ["9045050"],
  },
  {
    name: "closures",
    measures: "building and calling closures in a loop: one allocation per call",
    source: `
(define (adder n) (lambda (x) (+ x n)))
(define (apply-n f n acc) (if (= n 0) acc (apply-n f (- n 1) (f acc))))
(print (apply-n (adder 3) 100000 0))`,
    expected: ["300000"],
  },
  {
    name: "tak",
    measures: "three recursive calls per step, one of them in tail position",
    source: `
(define (tak x y z)
  (if (< y x)
      (tak (tak (- x 1) y z) (tak (- y 1) z x) (tak (- z 1) x y))
      z))
(print (tak 18 12 6))`,
    expected: ["7"],
  },
  {
    name: "cpstak",
    measures: "the same function in CPS: one continuation closure per step",
    baselineNote: "direct-style tak, which is what a C programmer writes for this function",
    source: `
(define (cpstak x y z k)
  (if (< y x)
      (cpstak (- x 1) y z
              (lambda (a)
                (cpstak (- y 1) z x
                        (lambda (b)
                          (cpstak (- z 1) x y
                                  (lambda (c) (cpstak a b c k)))))))
      (k z)))
(define (tak-cps x y z) (cpstak x y z (lambda (v) v)))
(print (tak-cps 18 12 6))`,
    expected: ["7"],
  },
  {
    name: "mini-eval",
    measures: "an interpreter for a tiny language: tag dispatch, car/cdr chains, recursion",
    baselineNote: "the same evaluator with direct calls, and the environment hoisted out of the loop",
    source: `
(define (mkvar i) (cons 1 (cons i ())))
(define (mkadd a b) (cons 2 (cons a (cons b ()))))
(define (mkmul a b) (cons 3 (cons a (cons b ()))))
(define (build n)
  (if (= n 0)
      (mkvar 1)
      (if (= (modulo n 2) 0)
          (mkadd (build (- n 1)) (build (- n 1)))
          (mkmul (build (- n 1)) (build (- n 1))))))
(define (lookup i env)
  (if (null? env) 0 (if (= i (car (car env))) (cdr (car env)) (lookup i (cdr env)))))
(define (ev e env)
  (if (= (car e) 0)
      (car (cdr e))
      (if (= (car e) 1)
          (lookup (car (cdr e)) env)
          (if (= (car e) 2)
              (modulo (+ (ev (car (cdr e)) env) (ev (car (cdr (cdr e))) env)) 1000003)
              (modulo (* (ev (car (cdr e)) env) (ev (car (cdr (cdr e))) env)) 1000003)))))
(define expr (build 10))
(define env (cons (cons 1 3) ()))
(define (repeat n acc) (if (= n 0) acc (repeat (- n 1) (+ acc (ev expr env)))))
(print (repeat 20 0))`,
    expected: ["2955960"],
  },
  {
    name: "insertion-sort",
    measures: "an algorithm that allocates as it works: sort a list by insertion",
    // Two numbers, because a sum cannot tell a sorted list from an unsorted one. The weighted sum
    // `sum(a[i] * i)` depends on the order, so it fails if the sort silently stops sorting.
    source: `
(define (build n) (if (= n 0) () (cons (modulo (* n 37) 100) (build (- n 1)))))
(define (insert x xs)
  (if (null? xs)
      (cons x ())
      (if (<= x (car xs))
          (cons x xs)
          (cons (car xs) (insert x (cdr xs))))))
(define (sort xs) (if (null? xs) () (insert (car xs) (sort (cdr xs)))))
(define (sum-list xs acc) (if (null? xs) acc (sum-list (cdr xs) (+ acc (car xs)))))
(define (weighted xs i acc)
  (if (null? xs) acc (weighted (cdr xs) (+ i 1) (+ acc (* (car xs) i)))))
(define sorted (sort (build 120)))
(print (sum-list sorted 0))
(print (weighted sorted 0 0))`,
    expected: ["5920", "471701"],
  },
];
