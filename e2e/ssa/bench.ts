/**
 * Performance benchmarks for the SSA layer
 *
 * Verifies that the framework algorithms scale reasonably:
 * - Braun SSA construction
 * - Dominator tree construction
 * - Pass execution
 *
 * Run: node --expose-gc e2e/ssa/bench.ts
 */

import { buildDomTree } from "../../src/ssa/analysis/domtree.js";
import { buildUseDefChains } from "../../src/ssa/analysis/usedef.js";
import { detectLoops } from "../../src/ssa/analysis/loops.js";
import { runPipeline } from "./pipeline.js";
import type { SSAFunction, BasicBlock } from "../../src/ssa/ir.js";
import type { TestInstr } from "./passes.js";

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

/**
 * Build a chain of N basic blocks: b0 -> b1 -> ... -> bN -> ret
 * Each block has a few instructions.
 */
function makeChain(n: number): SSAFunction<TestInstr> {
  const blocks = new Map<string, BasicBlock<TestInstr>>();

  for (let i = 0; i < n; i++) {
    const id = `b${i}`;
    const isLast = i === n - 1;
    blocks.set(id, {
      id,
      instructions: [
        { type: "const", dest: `c${i}`, value: i },
        { type: "add", dest: `s${i}`, left: `c${i}`, right: `c${i}` },
      ],
      terminator: isLast ? { type: "ret", value: `s${i}` } : { type: "jump", target: `b${i + 1}` },
      predecessors: i === 0 ? [] : [`b${i - 1}`],
      successors: isLast ? [] : [`b${i + 1}`],
    });
  }

  return { id: "chain", entry: "b0", blocks };
}

interface BenchResult {
  name: string;
  slope: number;
  samples: Array<{ n: number; t: number }>;
}

function benchmark(
  name: string,
  makeInput: (n: number) => SSAFunction<TestInstr>,
  fn: (func: SSAFunction<TestInstr>) => void,
  sizes = [100, 200, 400, 800],
): BenchResult {
  const samples: Array<{ n: number; t: number }> = [];

  for (const n of sizes) {
    const t = best(() => {
      const input = makeInput(n);
      fn(input);
    });
    samples.push({ n, t });
  }

  return { name, slope: fitSlope(samples), samples };
}

function formatResult(r: BenchResult): string {
  const times = r.samples.map((s) => `${s.n}:${s.t.toFixed(3)}ms`).join("  ");
  return `  ${r.name.padEnd(24)} slope=${r.slope.toFixed(2)}  ${times}`;
}

export function runBenchmarks(): BenchResult[] {
  console.log("SSA benchmarks (log-log slope; linear = 1.00)");

  const results = [
    benchmark("domtree", makeChain, (f) => buildDomTree(f)),
    benchmark("usedef", makeChain, (f) => buildUseDefChains(f)),
    benchmark("loops", makeChain, (f) => {
      const dom = buildDomTree(f);
      detectLoops(f, dom);
    }),
    benchmark("pass-pipeline", makeChain, (f) => runPipeline(f)),
  ];

  for (const r of results) {
    console.log(formatResult(r));
  }

  return results;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runBenchmarks();
}
