/**
 * The benchmarks, checked as programs.
 *
 * A benchmark that silently stops computing the right thing is worse than no benchmark: it looks
 * like a very fast result. Every row of every report — unoptimized, optimized, hand-written — is
 * checked against the expected output, and the hand-written baselines are additionally checked to
 * be valid SSA, since nothing else verifies code that no pass produced.
 *
 * The report itself is produced once and reused. Running the corpus is the slow part, and it does
 * not depend on which assertion is looking at it.
 */

import { describe, expect, test } from "vitest";
import { report } from "../bench/report.ts";
import { BASELINES, baselineModule, BASELINE_ENTRY } from "../bench/baselines.ts";
import { verifySSASafe } from "../../../src/ssa/verify.ts";
import { schemeOps } from "../ir.ts";

const REPORTS = report();

describe("every benchmark row computes the right thing", () => {
  for (const r of REPORTS) {
    test(`${r.name}: all three rows print ${r.expected.join(", ")}`, () => {
      expect(r.rows).toHaveLength(3);
      for (const row of r.rows) expect(row.output).toEqual([...r.expected]);
    });
  }
});

describe("the report says what it claims", () => {
  test("every benchmark has an unoptimized, an optimized and a hand-written row", () => {
    for (const r of REPORTS) {
      expect(r.rows.map((row) => row.label)).toEqual(["unoptimized", "optimized", "hand-written"]);
    }
  });

  test("optimizing never costs instructions", () => {
    for (const r of REPORTS) {
      const plain = r.rows.find((row) => row.label === "unoptimized")!;
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
    // The honest negative result: building an intermediate list and calling a closure per element
    // is work the C-shaped version does not do, and no amount of SSA optimization removes it.
    expect(ratio("map-fold")).toBeGreaterThan(4);
  });
});
