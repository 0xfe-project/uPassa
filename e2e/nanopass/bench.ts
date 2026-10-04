/**
 * Performance benchmarks for the nanopass layer
 *
 * Verifies that pass execution scales linearly with input size.
 * Uses log-log slope fitting: linear = 1.00, quadratic = 2.00.
 *
 * Run: node --expose-gc e2e/nanopass/bench.ts
 */

import { runPipeline } from "./pipeline.js";
import { deepNestedLet, wideArithmetic } from "./fixtures.js";
import type { L0_Expr } from "./languages.js";

/**
 * Measure execution time (best of N runs) in milliseconds.
 */
function best(fn: () => void, runs = 5): number {
  let bestTime = Infinity;
  for (let i = 0; i < runs; i++) {
    if (typeof globalThis.gc === "function") globalThis.gc();
    const start = performance.now();
    fn();
    const elapsed = performance.now() - start;
    if (elapsed < bestTime) bestTime = elapsed;
  }
  return bestTime;
}

/**
 * Fit log-log slope from (size, time) samples.
 * slope ≈ 1 means linear, ≈ 2 means quadratic.
 */
function fitSlope(samples: Array<{ n: number; t: number }>): number {
  const xs = samples.map((s) => Math.log(s.n));
  const ys = samples.map((s) => Math.log(s.t));
  const n = xs.length;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY);
    den += (xs[i]! - meanX) ** 2;
  }

  return den === 0 ? 0 : num / den;
}

interface BenchResult {
  name: string;
  slope: number;
  samples: Array<{ n: number; t: number }>;
  linear: boolean;
}

/**
 * Run a benchmark: build the input once (outside timing), then time the pipeline.
 */
function benchmark(
  name: string,
  makeInput: (n: number) => L0_Expr,
  sizes = [100, 200, 400, 800],
): BenchResult {
  const samples: Array<{ n: number; t: number }> = [];

  for (const n of sizes) {
    const input = makeInput(n);
    const t = best(() => runPipeline(input));
    samples.push({ n, t });
  }

  const slope = fitSlope(samples);
  return { name, slope, samples, linear: slope < 1.25 };
}

function formatResult(r: BenchResult): string {
  const times = r.samples.map((s) => `${s.n}:${s.t.toFixed(2)}ms`).join("  ");
  const verdict = r.linear ? "linear" : "SUPERLINEAR";
  return `  ${r.name.padEnd(24)} slope=${r.slope.toFixed(2)}  [${verdict}]  ${times}`;
}

export function runBenchmarks(): { results: BenchResult[]; allLinear: boolean } {
  console.log("Nanopass benchmarks (log-log slope; linear = 1.00)");

  const results = [
    benchmark("deep-nested-let", (n) => deepNestedLet(n)),
    benchmark("wide-arithmetic", (n) => wideArithmetic(n)),
  ];

  for (const r of results) {
    console.log(formatResult(r));
  }

  const allLinear = results.every((r) => r.linear);
  console.log(allLinear ? "  all linear" : "  SUPERLINEAR DETECTED");

  return { results, allLinear };
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const { allLinear } = runBenchmarks();
  process.exitCode = allLinear ? 0 : 1;
}
