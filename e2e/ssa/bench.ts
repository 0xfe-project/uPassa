/**
 * Scaling benchmark for the SSA layer.
 *
 * The claim: the graph algorithms are linear in the number of blocks and instructions. Braun, the
 * dominator tree and the use-def chains are all graph walks, and a graph walk that is quadratic
 * means a set of all dominators, or a linear scan to find a block, or a fixed point judged by
 * comparing whole structures. All three have been in this code at one point.
 *
 * ── How to read it
 *
 * Sizes are n, 2n, 4n, 8n. The reported slope is the log-log slope from the smallest to the largest:
 * 1.00 is linear, 2.00 is quadratic, anything above 1.25 is flagged. End to end rather than between
 * consecutive sizes, because one noisy pair would fail the gate for no reason.
 *
 * `gc()` runs before each measurement: on an uncontrolled heap "the algorithm got superlinear" and
 * "GC got expensive" are the same observation.
 *
 * Exits non-zero on a flagged slope, because a gate that always passes is worse than no gate.
 */

import { toSSA } from "../../src/ssa/braun.ts";
import { buildDomTree } from "../../src/ssa/analysis/domtree.ts";
import { detectLoops } from "../../src/ssa/analysis/loops.ts";
import { buildUseDefChains } from "../../src/ssa/analysis/usedef.ts";
import type { BasicBlock, SSAFunction, ValueId } from "../../src/ssa/ir.ts";
import { testOps, type TestInstr } from "./ir.ts";

const SIZES = [500, 1000, 2000, 4000];
const FLAG_ABOVE = 1.25;

/**
 * A straight chain of `n` blocks.
 *
 * A chain rather than a fan: every block has one predecessor and one successor, so the dominator
 * tree is a path and a quadratic `dominates` shows up immediately as the block count grows. A fan
 * would make the tree flat and hide it.
 */
function chain(n: number): SSAFunction<TestInstr> {
  const blocks = new Map<string, BasicBlock<TestInstr>>();

  for (let i = 0; i < n; i++) {
    const id = `b${i}`;
    const instructions: TestInstr[] = [];
    // Three instructions per block, each reading the previous block's value, so the walk has real
    // operands to resolve and the use-def chains have real edges.
    instructions.push({ type: "const", dest: `c${i}`, value: i });
    instructions.push({ type: "add", dest: `a${i}`, left: `c${i}`, right: `c${i}` });
    instructions.push({
      type: "copy",
      dest: `x${i}`,
      src: (i === 0 ? `c0` : `x${i - 1}`) as ValueId,
    });

    blocks.set(id, {
      id,
      instructions,
      terminator: i === n - 1 ? { type: "ret", value: `x${i}` } : { type: "jump", target: `b${i + 1}` },
      predecessors: i === 0 ? [] : [`b${i - 1}`],
      successors: i === n - 1 ? [] : [`b${i + 1}`],
    });
  }

  return { id: "chain", blocks, entry: "b0" };
}

interface Measurement {
  readonly label: string;
  readonly times: readonly number[];
  readonly slope: number;
}

function measure(label: string, run: (f: SSAFunction<TestInstr>) => unknown): Measurement {
  // Built once, outside the timed region: building the fixture is allocation, not the algorithm.
  const functions = SIZES.map(chain);
  const times: number[] = [];

  for (const f of functions) {
    global.gc?.();
    const start = performance.now();
    run(f);
    times.push(performance.now() - start);
  }

  return { label, times, slope: overallSlope(times) };
}

function overallSlope(times: readonly number[]): number {
  const first = times[0]!;
  const last = times[times.length - 1]!;
  return Math.log(last / first) / (Math.log(SIZES.length) / Math.log(2));
}

const measurements: Measurement[] = [
  measure("braun", (f) => toSSA(f, testOps)),
  measure("dominator tree", (f) => buildDomTree(f)),
  measure("use-def chains", (f) => buildUseDefChains(f)),
  measure("loop detection", (f) => detectLoops(f, buildDomTree(f))),
];

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`blocks:     ${SIZES.map((n) => pad(String(n), 10)).join("")}  (each size is 2x the last)`);
console.log("");

let failed = false;
for (const m of measurements) {
  const flag = m.slope > FLAG_ABOVE;
  if (flag) failed = true;
  console.log(
    `${pad(m.label, 16)}${m.times.map((t) => pad(`${t.toFixed(2)}ms`, 10)).join("")}` +
      `  slope ${m.slope.toFixed(2)}${flag ? "  <-- SUPERLINEAR" : ""}`,
  );
}

console.log("");
console.log(
  failed ? "FAILED: an analysis is superlinear in the block count." : "ok: every analysis is linear.",
);
process.exit(failed ? 1 : 0);
