/**
 * The benchmarks, checked as programs.
 *
 * A benchmark that silently stops computing the right thing is worse than no benchmark: it looks
 * like a very fast result. Every row of every report — interpreted, compiled, optimized,
 * hand-written — is checked against the expected output, and the hand-written baselines are
 * additionally checked to be valid SSA, since nothing else verifies code that no pass produced.
 *
 * The report itself is produced once and reused. Running the corpus is the slow part, and it does
 * not depend on which assertion is looking at it.
 */

import { describe, expect, test } from "vitest";
import { report, work } from "../bench/report.ts";
import { BASELINES, baselineModule, BASELINE_ENTRY } from "../bench/baselines.ts";
import { verifySSASafe } from "../../../src/ssa/verify.ts";
import { schemeOps } from "../ir.ts";

const REPORTS = report();

describe("every benchmark row computes the right thing", () => {
  for (const r of REPORTS) {
    test(`${r.name}: every row prints ${r.expected.join(", ")}`, () => {
      expect(r.rows).toHaveLength(4);
      for (const row of r.rows) expect(row.output).toEqual([...r.expected]);
    });
  }
});

describe("the report says what it claims", () => {
  test("every benchmark has one row per question", () => {
    for (const r of REPORTS) {
      expect(r.rows.map((row) => row.label)).toEqual([
        "interpreted",
        "compiled",
        "optimized",
        "hand-written",
      ]);
    }
  });

  test("optimizing never costs instructions", () => {
    for (const r of REPORTS) {
      const plain = r.rows.find((row) => row.label === "compiled")!;
      const optimized = r.rows.find((row) => row.label === "optimized")!;
      expect(optimized.instructions).toBeLessThanOrEqual(plain.instructions);
    }
  });

  test("the hand-written baseline is valid SSA", () => {
    // Nothing else checks it: no pass produced it, so no pass verified it. A baseline with a
    // missing phi would still run and still print the right number for these programs, and would
    // be measuring the wrong thing.
    for (const b of BASELINES) {
      const m = baselineModule(b.name);
      for (const [name, fn] of m) {
        const result = verifySSASafe(fn, schemeOps);
        expect({ benchmark: b.name, fn: name, errors: result.errors }).toEqual({
          benchmark: b.name,
          fn: name,
          errors: [],
        });
      }
    }
  });

  test("the hand-written entry point exists in every baseline", () => {
    for (const b of BASELINES) expect(baselineModule(b.name).has(BASELINE_ENTRY)).toBe(true);
  });
});

describe("the report states which way each comparison went", () => {
  // A ratio with no stated direction gets read the wrong way. The first version of the report
  // labelled a division "optimized/hand-written" while dividing the other way round, which turned
  // the worst result in the corpus into the best-looking one.
  test("fewer instructions is reported as fewer", () => {
    expect(work(1000, 500)).toBe("2.00x fewer instructions");
  });

  test("more instructions is reported as more", () => {
    expect(work(1000, 2000)).toBe("2.00x more instructions");
  });

  test("a difference too small to be one is not reported as a difference", () => {
    expect(work(600_000, 600_001)).toBe("the same");
  });

  test("the corpus's worst result reads as a loss", () => {
    const mapFold = REPORTS.find((r) => r.name === "map-fold")!;
    const optimized = mapFold.rows.find((r) => r.label === "optimized")!;
    const handwritten = mapFold.rows.find((r) => r.label === "hand-written")!;
    expect(work(handwritten.instructions, optimized.instructions)).toMatch(/more instructions/);
  });
});

describe("where the compiler stands", () => {
  // Not a threshold — a record. If one of these moves, it moved because something changed, and the
  // number in the report is what says whether that was an improvement.
  const row = (name: string, label: string) =>
    REPORTS.find((x) => x.name === name)!.rows.find((r) => r.label === label)!;

  /** `optimized / hand-written`: 1 means the compiler matched the C shape, 4 means it did 4× the work. */
  const ratio = (name: string): number =>
    (row(name, "optimized").instructions as number) / (row(name, "hand-written").instructions as number);

  test("a tree-recursive program compiles to what a C programmer would write", () => {
    // fib has no loop to convert and no allocation to remove; the only thing between the two rows
    // would be a difference in how the calls are expressed.
    expect(ratio("fib")).toBeGreaterThan(0.99);
    expect(ratio("fib")).toBeLessThan(1.01);
  });

  test("a tail-recursive loop compiles to the same loop a C programmer would write", () => {
    expect(ratio("loop-sum")).toBeGreaterThan(0.99);
    expect(ratio("loop-sum")).toBeLessThan(1.01);
  });

  test("allocation-heavy functional code still costs several times the C shape", () => {
    // The honest negative result, and a smaller one than it was: deforestation removed the mapped
    // list and inlined both functions into the loop, which took this from 6.46x to about 3.2x. What
    // is left is the list the *source* asked `build` for — a C programmer would have summed 1..n
    // without building anything, and that is a different algorithm, not a missing optimization.
    expect(ratio("map-fold")).toBeGreaterThan(3);
    expect(ratio("map-fold")).toBeLessThan(4);
  });

  test("writing the same function in CPS costs instructions and a closure per step", () => {
    // This is why the compiler is direct-style. The baseline for cpstak is direct-style tak, which
    // is what a C programmer writes for the same function.
    const cps = row("cpstak", "optimized");
    const direct = row("cpstak", "hand-written");
    expect(cps.instructions).toBeGreaterThan(direct.instructions * 1.4);
    expect(cps.allocs).toBeGreaterThan(40_000);
    expect(direct.allocs).toBe(0);
  });

  test("an interpreter written in the language compiles to what a hand-written one costs", () => {
    // The interesting positive result: tag dispatch and car/cdr chains are not something the
    // compiler makes worse.
    expect(ratio("mini-eval")).toBeGreaterThan(0.9);
    expect(ratio("mini-eval")).toBeLessThan(1.1);
  });
});
