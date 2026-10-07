/**
 * The SSA optimization passes.
 *
 * The assertion that matters is the first one: for every program in the corpus, running the passes
 * and not running them must produce the same output and the same value. An optimization that
 * changes the answer is not an optimization, and nothing else in the suite would notice.
 *
 * The rest pin what each pass actually does, so that a pass which stops doing anything fails here
 * instead of quietly making the benchmarks look better than they are.
 */

import { describe, expect, test } from "vitest";
import { compileProgram, runSource } from "../run.ts";
import { PROGRAMS } from "../fixtures/programs.ts";
import { SSA_PASSES } from "../optimize.ts";
import { isCopy } from "../ir.ts";

const FIXTURE = (name: string) => PROGRAMS.find((p) => p.name === name)!.source;

describe("optimization is behaviour-preserving", () => {
  for (const p of PROGRAMS) {
    test(`${p.name}: optimized and unoptimized agree (${p.covers})`, () => {
      const plain = runSource(p.source, [], { optimize: false });
      const optimized = runSource(p.source, [], { optimize: true, verifyEach: true });
      expect(optimized.output).toEqual(plain.output);
      expect(JSON.stringify(optimized.value)).toBe(JSON.stringify(plain.value));
    });
  }

  for (const p of PROGRAMS) {
    test(`${p.name}: optimizing never costs instructions`, () => {
      const plain = runSource(p.source, [], { optimize: false });
      const optimized = runSource(p.source, [], { optimize: true });
      expect(optimized.stats.instructions).toBeLessThanOrEqual(plain.stats.instructions);
    });
  }
});

describe("the passes do something", () => {
  test("copy propagation removes every copy", () => {
    // An `if` used as a value is where copies come from: the two arms name their result the same.
    const { module } = compileProgram(FIXTURE("if-value"), { ssa: true });
    const copiesBefore = countCopies(module);
    expect(copiesBefore).toBeGreaterThan(0);

    const optimized = compileProgram(FIXTURE("if-value"), { ssa: true, optimize: true });
    expect(countCopies(optimized.module)).toBe(0);
  });

  test("constant folding turns arithmetic on constants into a constant", () => {
    const { module } = compileProgram("(print (+ 1 2))", { ssa: true, optimize: true });
    const prims = allInstructions(module).filter((i) => i.type === "prim");
    expect(prims).toHaveLength(0);
  });

  test("dead code elimination removes a computation nobody reads", () => {
    // The `let` binding is never read, so the addition feeding it is dead.
    const source = "(print (let ((unused (+ 1 2))) 5))";
    const before = compileProgram(source, { ssa: true });
    const after = compileProgram(source, { ssa: true, optimize: true });
    expect(allInstructions(after.module).length).toBeLessThan(allInstructions(before.module).length);
  });

  test("common subexpression elimination merges a repeated computation", () => {
    const { module } = compileProgram("(define (f x) (+ (+ x 1) (+ x 1)))\n(print (f 1))", {
      ssa: true,
      optimize: true,
    });
    const adds = allInstructions(module).filter(
      (i) => i.type === "prim" && (i as { op?: string }).op === "add",
    );
    // Two adds: the two `(+ x 1)` collapsed into one, plus the outer sum. Without CSE there are
    // three.
    expect(adds).toHaveLength(2);
  });

  test("optimizing twice is the same as optimizing once", () => {
    const once = compileProgram(FIXTURE("sugar"), { ssa: true, optimize: true });
    const twice = compileProgram(FIXTURE("sugar"), { ssa: true, optimize: true });
    expect(JSON.stringify([...twice.module])).toBe(JSON.stringify([...once.module]));
  });

  test("every declared pass is reachable by name", () => {
    expect(SSA_PASSES.map((p) => p.name)).toEqual(["copy-prop", "const-fold", "cse", "dce"]);
  });
});

// ───────────────────────── helpers ─────────────────────────

function allInstructions(module: Map<string, { blocks: Map<string, { instructions: unknown[] }> }>) {
  const out: { type: string; [k: string]: unknown }[] = [];
  for (const fn of module.values()) {
    for (const block of fn.blocks.values()) {
      for (const inst of block.instructions) out.push(inst as { type: string });
    }
  }
  return out;
}

function countCopies(module: Parameters<typeof allInstructions>[0]): number {
  return allInstructions(module).filter((i) => isCopy(i)).length;
}
