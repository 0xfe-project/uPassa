/**
 * Scaling benchmark for the nanopass layer.
 *
 * The claim: a generated walker is linear in the size of the tree. A pass is a tree rewrite, and a
 * tree rewrite that is quadratic means the walker is re-walking subtrees — which is exactly the bug
 * this file exists to catch, twice already.
 *
 * ── How to read it
 *
 * The sizes are n, 2n, 4n, 8n. The log-log slope between consecutive sizes is what is reported:
 * 1.00 is linear, 2.00 is quadratic, and anything above 1.25 is flagged. A single ratio is too noisy
 * to gate on — a gate that flaps gets ignored — so the failure condition is on the slope, not on a
 * wall-clock number.
 *
 * `gc()` runs before each measurement. On an uncontrolled heap "the algorithm got superlinear" and
 * "GC got expensive" are the same observation, and only one of them is worth a commit.
 *
 * Exits non-zero on a flagged slope, because a gate that always passes is worse than no gate.
 */

import { buildWalker, buildFusedGroup, canFuse } from "../../src/nanopass/index.ts";
import { beginElimSpec, beginElim } from "./passes/begin-elim.T0->T1.pass.ts";
import { negElimSpec, negElim } from "./passes/neg-elim.T1->T2.pass.ts";
import { foldConstSpec, foldConst } from "./passes/fold-const.T2.pass.ts";
import { addZeroSpec, addZero } from "./passes/add-zero.T2.pass.ts";
import type { T0_Expr } from "./langs/toy.lang.ts";

// Large enough that the measurement is not dominated by noise: at a few milliseconds the slope is
// whatever the scheduler did. A quarter of a million nodes takes tens of milliseconds, which is the
// smallest size where the number means anything.
const SIZES = [25000, 50000, 100000, 200000];
const FLAG_ABOVE = 1.25;

/**
 * A balanced tree of `n` nodes.
 *
 * Balanced rather than left-leaning on purpose: a left-leaning tree of 200,000 nodes is 200,000
 * levels deep, and a recursive walker would overflow the stack long before it finished. Depth is
 * what the walker recurses on, so the tree has to be shallow for the measurement to be about size.
 *
 * The shapes are cycled so all three rewrites in the chain have something to do.
 */
function tree(n: number, depth = 0): T0_Expr {
  if (n <= 1) return { type: "Int", value: n };
  const left = tree(Math.floor(n / 2), depth + 1);
  const right = tree(n - Math.floor(n / 2), depth + 1);
  switch (depth % 3) {
    case 0:
      return { type: "Add", left, right };
    case 1:
      return { type: "Begin", body: { type: "Neg", operand: { type: "Add", left, right } } };
    default:
      return { type: "Neg", operand: { type: "Add", left, right } };
  }
}

interface Measurement {
  readonly label: string;
  readonly times: readonly number[];
  readonly slope: number;
}

function measure(label: string, run: (t: T0_Expr) => unknown): Measurement {
  const trees = SIZES.map(tree);
  const times: number[] = [];

  for (const t of trees) {
    global.gc?.();
    const start = performance.now();
    run(t);
    times.push(performance.now() - start);
  }

  return { label, times, slope: overallSlope(times) };
}

/**
 * The log-log slope from the smallest size to the largest.
 *
 * End to end rather than between consecutive sizes: at 25ms a single measurement still carries a
 * few milliseconds of noise, and one noisy pair would set a consecutive slope to 2.0 and fail the
 * gate for no reason. Four times the size four times over averages that out.
 */
function overallSlope(times: readonly number[]): number {
  const first = times[0]!;
  const last = times[times.length - 1]!;
  const growth = Math.log(SIZES.length) / Math.log(2); // n -> 8n is three doublings
  return Math.log(last / first) / growth;
}

const CHAIN = [
  { spec: beginElimSpec, run: beginElim as (t: unknown) => unknown },
  { spec: negElimSpec, run: negElim as (t: unknown) => unknown },
  { spec: foldConstSpec, run: foldConst as (t: unknown) => unknown },
  { spec: addZeroSpec, run: addZero as (t: unknown) => unknown },
];

const measurements: Measurement[] = [
  measure("one walker", (t) => buildWalker(beginElimSpec).run(t)),
  measure("chain, unfused", (t) => {
    let cur: unknown = t;
    for (const step of CHAIN) cur = step.run(cur);
    return cur;
  }),
  measure("chain, fused", (t) => {
    // The three passes with the same nonterminal names and no extra values collapse into one
    // traversal; the first one does not join them, so it runs on its own.
    let cur: unknown = CHAIN[0]!.run(t);
    const rest = CHAIN.slice(1);
    if (canFuse(rest.map((s) => s.spec))) cur = buildFusedGroup(rest.map((s) => s.spec)).run(cur);
    else for (const step of rest) cur = step.run(cur);
    return cur;
  }),
];

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`nodes:      ${SIZES.map((n) => pad(String(n), 10)).join("")}  (each size is 2x the last)`);
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
console.log(failed ? "FAILED: a walk is superlinear in the tree size." : "ok: every walk is linear.");
process.exit(failed ? 1 : 0);
