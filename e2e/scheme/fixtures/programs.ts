/**
 * Programs the pipeline is checked against.
 *
 * Not benchmarks — these are chosen to reach every construct the chain has a pass for, so that a
 * pass which is wrong somewhere shows up here rather than in whichever benchmark happens to hit it.
 * Each entry says what it is for.
 */

export interface Fixture {
  readonly name: string;
  /** What construct this program exists to exercise. */
  readonly covers: string;
  readonly source: string;
}

export const PROGRAMS: readonly Fixture[] = [
  {
    name: "minimal",
    covers: "a definition and a call, nothing else",
    source: `
(define (one) 1)
(print (one))`,
  },
  {
    name: "sugar",
    covers: "let, let*, cond, and, or, not, when, unless, begin",
    source: `
(define (f a b)
  (let ((x (+ a b))
        (y (* a b)))
    (let* ((z (- x y))
           (w (if (> z 0) z (- z))))
      (begin
        (when (> w 0) (print w))
        (unless (< w 0) (print (or (and (> x 0) (> y 0)) (not (= z 0)))))
        (cond ((= z 0) x)
              ((< z 0) y)
              (else w))))))
(print (f 3 4))`,
  },
  {
    name: "closure",
    covers: "a lambda returned from a function, capturing a parameter",
    source: `
(define (adder n) (lambda (x) (+ x n)))
(define (twice f v) (f (f v)))
(print ((adder 10) 5))
(print (twice (lambda (x) (* x 2)) 3))`,
  },
  {
    name: "nested-capture",
    covers: "a lambda inside a lambda that captures from both",
    source: `
(define (outer a)
  (lambda (b)
    (lambda (c) (+ (+ a b) c))))
(print (((outer 1) 2) 3))`,
  },
  {
    name: "self-recursion",
    covers: "a self-recursive function that must not capture itself",
    source: `
(define (count n acc)
  (if (= n 0) acc (count (- n 1) (+ acc 1))))
(print (count 10 0))`,
  },
  {
    name: "tail-in-let",
    covers: "a tail call in the body of a let, and in both branches of an if",
    source: `
(define (loop n acc)
  (if (= n 0)
      acc
      (let ((next (- n 1)))
        (loop next (+ acc next)))))
(print (loop 5 0))`,
  },
  {
    name: "global-value",
    covers: "a top-level binding that is not a function, read from inside a function",
    source: `
(define k 7)
(define (add-k x) (+ x k))
(print (add-k 1))`,
  },
  {
    name: "deep-if",
    covers: "nested ifs where only some branches are in tail position",
    source: `
(define (classify n)
  (if (< n 0)
      (if (= n -1) (quote-neg-one) (quote-neg))
      (if (= n 0) (quote-zero) (quote-pos))))
(define (quote-neg-one) 1)
(define (quote-neg) 2)
(define (quote-zero) 3)
(define (quote-pos) 4)
(print (classify -1))
(print (classify 5))`,
  },
];
