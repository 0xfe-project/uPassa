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
  /**
   * What the program prints, worked out from the source by hand.
   *
   * This is the oracle. There is no second evaluator to compare against — the interpreter runs the
   * lowered SSA — so the expected values have to be independent of everything the compiler does.
   */
  readonly expected: readonly string[];
}

export const PROGRAMS: readonly Fixture[] = [
  {
    name: "minimal",
    covers: "a definition and a call, nothing else",
    source: `
(define (one) 1)
(print (one))`,
    expected: ["1"],
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
    // a=3 b=4: x=7, y=12, z=-5, w=5.  (when (> 5 0)) prints 5; (unless (< 5 0)) prints
    // (or (and #t #t) (not #f)) = #t; the cond falls through to (else w) with w=5 -> 12? no:
    // z is -5 so the second clause (< z 0) matches and yields y = 12.
    expected: ["5", "#t", "12"],
  },
  {
    name: "closure",
    covers: "a lambda returned from a function, capturing a parameter",
    source: `
(define (adder n) (lambda (x) (+ x n)))
(define (twice f v) (f (f v)))
(print ((adder 10) 5))
(print (twice (lambda (x) (* x 2)) 3))`,
    // ((adder 10) 5) = 15; (twice (lambda (x) (* x 2)) 3) = 12
    expected: ["15", "12"],
  },
  {
    name: "nested-capture",
    covers: "a lambda inside a lambda that captures from both",
    source: `
(define (outer a)
  (lambda (b)
    (lambda (c) (+ (+ a b) c))))
(print (((outer 1) 2) 3))`,
    expected: ["6"],
  },
  {
    name: "self-recursion",
    covers: "a self-recursive function that must not capture itself",
    source: `
(define (count n acc)
  (if (= n 0) acc (count (- n 1) (+ acc 1))))
(print (count 10 0))`,
    expected: ["10"],
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
    // 5 + 4 + 3 + 2 + 1 + 0
    expected: ["10"],
  },
  {
    name: "global-value",
    covers: "a top-level binding that is not a function, read from inside a function",
    source: `
(define k 7)
(define (add-k x) (+ x k))
(print (add-k 1))`,
    expected: ["8"],
  },
  {
    name: "deep-if",
    covers: "nested ifs where only some branches are in tail position",
    source: `
(define (classify n)
  (if (< n 0)
      (if (= n -1) (minus-one) (negative))
      (if (= n 0) (zero) (positive))))
(define (minus-one) 1)
(define (negative) 2)
(define (zero) 3)
(define (positive) 4)
(print (classify -1))
(print (classify 5))`,
    expected: ["1", "4"],
  },
  {
    name: "if-value",
    covers: "an if used as a value, so its result has to be merged from two blocks",
    source: `
(define (pick c a b) (+ (if c a b) (if c b a)))
(print (pick #t 1 2))
(print (pick #f 1 2))`,
    // (pick #t 1 2) = (+ 1 2) = 3; (pick #f 1 2) = (+ 2 1) = 3
    expected: ["3", "3"],
  },
  {
    name: "lists",
    covers: "cons, car, cdr, null? and the empty list",
    source: `
(define (len xs)
  (if (null? xs) 0 (+ 1 (len (cdr xs)))))
(define (sum xs)
  (if (null? xs) 0 (+ (car xs) (sum (cdr xs)))))
(define xs (cons 1 (cons 2 (cons 3 ()))))
(print (len xs))
(print (sum xs))
(print (null? xs))
(print (null? ()))`,
    expected: ["3", "6", "#f", "#t"],
  },
  {
    name: "deep-tail-recursion",
    covers: "a tail call that must not grow the stack",
    source: `
(define (count-up i n)
  (if (= i n) i (count-up (+ i 1) n)))
(print (count-up 0 100000))`,
    expected: ["100000"],
  },
  {
    name: "mutual-recursion",
    covers: "two functions calling each other in tail position",
    source: `
(define (even? n) (if (= n 0) #t (odd? (- n 1))))
(define (odd? n) (if (= n 0) #f (even? (- n 1))))
(print (even? 10))
(print (odd? 10))`,
    expected: ["#t", "#f"],
  },
];
