/**
 * The lowering, end to end.
 *
 * These tests run real programs and check what they print. There is no second evaluator to compare
 * against — the interpreter runs the lowered SSA — so the expected values in the fixtures are worked
 * out by hand from the source. That is the only oracle available, and it is why the fixtures are
 * small and say what they cover.
 *
 * The two shapes are both exercised: with SSA construction and without. They must agree, because a
 * program that only works before the SSA construction is a program whose variables happen to be
 * single-assignment already.
 */

import { describe, expect, test } from "vitest";
import { compileProgram, runSource } from "../run.ts";
import { PROGRAMS } from "../fixtures/programs.ts";
import { LoweringError } from "../lower.ts";

describe("lowering", () => {
  for (const p of PROGRAMS) {
    test(`${p.name} prints what it should (${p.covers})`, () => {
      const r = runSource(p.source);
      expect(r.output).toEqual([...p.expected]);
    });
  }

  for (const p of PROGRAMS) {
    test(`${p.name} gives the same answer with and without SSA construction`, () => {
      const withSSA = runSource(p.source, [], { ssa: true });
      const without = runSource(p.source, [], { ssa: false });
      expect(withSSA.output).toEqual(without.output);
      expect(JSON.stringify(withSSA.value)).toBe(JSON.stringify(without.value));
    });
  }

  test("a value produced in both arms of an if is one variable, not a phi", () => {
    // The lowering must not place phis: the SSA construction skips phis it did not create, so one
    // placed here would be silently ignored and its operands left stale.
    const { lowered } = compileProgram(PROGRAMS.find((p) => p.name === "if-value")!.source, { ssa: false });
    for (const [name, fn] of lowered.functions) {
      for (const [id, block] of fn.blocks) {
        for (const inst of block.instructions) {
          expect(`${name}:${id}:${inst.type}`).not.toMatch(/phi/);
        }
      }
    }
  });

  test("a merged value appears as a copy in both arms", () => {
    const { lowered } = compileProgram(PROGRAMS.find((p) => p.name === "if-value")!.source, { ssa: false });
    const copies = new Map<string, string[]>();
    for (const [, fn] of lowered.functions) {
      for (const [id, block] of fn.blocks) {
        for (const inst of block.instructions) {
          if (inst.type !== "copy") continue;
          const dest = (inst as { dest: string }).dest;
          copies.set(dest, [...(copies.get(dest) ?? []), id]);
        }
      }
    }
    // At least one name is defined in two different blocks — that is the merge.
    const merged = [...copies.values()].filter((blocks) => blocks.length >= 2);
    expect(merged.length).toBeGreaterThanOrEqual(1);
  });

  test("tail calls do not grow the stack", () => {
    // The property is not "no calls at all" — the call to `print` is in argument position and is
    // not a tail call. It is that the number of non-tail calls does not grow with the input, which
    // is what "the stack stays flat" means. Comparing two sizes says that directly.
    const small = runSource(recursion(10));
    const big = runSource(recursion(100_000));
    expect(big.output).toEqual(["100000"]);
    expect(big.stats.calls).toBe(small.stats.calls);
    // Frames are the observable half of it: a self tail call became a loop, so the frame is reused
    // rather than rebuilt. See tests/loops.test.ts for the conversion itself.
    expect(big.stats.frames).toBe(small.stats.frames);
  });

  test("mutual tail recursion also does not grow the stack", () => {
    // A mutual call is not a loop over one frame, so the frames here are replaced rather than
    // reused — but the count still does not grow, because the replacement is constant-stack.
    const small = runSource(mutual(10), [], { loops: false });
    const big = runSource(mutual(100_000), [], { loops: false });
    expect(big.stats.calls).toBe(small.stats.calls);
  });

  test("a name that is not in scope is reported, not silently read", () => {
    expect(() => compileProgram("(print nowhere)")).toThrow(LoweringError);
  });

  test("a call in tail position becomes a tail call terminator", () => {
    const { lowered } = compileProgram("(define (f x) (g x))\n(define (g x) x)\n(print (f 1))", {
      ssa: false,
    });
    const f = lowered.functions.get("f")!;
    const terms = [...f.blocks.values()].map((b) => b.terminator.type);
    expect(terms).toContain("tailcall");
  });
});

/** The deep-tail-recursion program at a chosen size. */
function recursion(n: number): string {
  return `
(define (count-up i n) (if (= i n) i (count-up (+ i 1) n)))
(print (count-up 0 ${n}))`;
}

/** The mutual-recursion program at a chosen size. */
function mutual(n: number): string {
  return `
(define (even? n) (if (= n 0) #t (odd? (- n 1))))
(define (odd? n) (if (= n 0) #f (even? (- n 1))))
(print (even? ${n}))`;
}
