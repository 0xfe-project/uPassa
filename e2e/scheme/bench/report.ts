/**
 * The benchmark report.
 *
 * Three rows per program: what the compiler produces with no optimization, what it produces with
 * the SSA passes, and the same computation written by hand in C style. All three are counted by the
 * same interpreter, on the same IR, so the numbers are comparable.
 *
 * Wall-clock is deliberately absent. The interpreter's dispatch dominates it, so it would measure
 * the interpreter rather than the program. What is reported is what the *program* does:
 *
 *   instructions  one per instruction executed, plus one per frame slot written when a call is
 *                 entered. Phi nodes and terminators are not counted: a phi names a merge of values
 *                 that already exist, and in the code this IR stands for the register allocator
 *                 resolves it away. Counting phis but not terminators would decide "did this tail
 *                 call become a loop" by the counting rather than by the program
 *   frames        frames created; a self tail call that became a loop reuses one
 *   allocs        heap allocations: pairs and closures
 *
 * The expected value is checked for every row. A row that computed something else would otherwise
 * look like a very fast result.
 *
 * Comparisons are stated as what the optimized row does against a baseline, never as a bare ratio:
 * fewer instructions is less work, and a ratio whose direction is only implied gets read the wrong
 * way — which is exactly what happened to this file's first version.
 */

import { run } from "../interp.ts";
import { runSource } from "../run.ts";
import { BENCHMARKS } from "./programs.ts";
import { baselineModule, BASELINE_ENTRY } from "./baselines.ts";

export interface Row {
  readonly label: string;
  readonly instructions: number;
  readonly frames: number;
  readonly allocs: number;
  readonly output: readonly string[];
}

export interface BenchmarkReport {
  readonly name: string;
  readonly measures: string;
  readonly expected: readonly string[];
  /** What the hand-written row is, when it is not simply the same program in C style. */
  readonly baselineNote: string | undefined;
  readonly rows: readonly Row[];
}

function check(where: string, got: readonly string[], expected: readonly string[]): void {
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new Error(`${where} printed ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
}

export function report(): readonly BenchmarkReport[] {
  return BENCHMARKS.map((b) => {
    const plain = runSource(b.source, [], { optimize: false });
    const optimized = runSource(b.source, [], { optimize: true });
    const handwritten = run(baselineModule(b.name), BASELINE_ENTRY, []);

    check(`${b.name} unoptimized`, plain.output, b.expected);
    check(`${b.name} optimized`, optimized.output, b.expected);
    check(`${b.name} hand-written`, handwritten.output, b.expected);

    const row = (
      label: string,
      r: { output: string[]; stats: { instructions: number; frames: number; allocs: number } },
    ): Row => ({
      label,
      instructions: r.stats.instructions,
      frames: r.stats.frames,
      allocs: r.stats.allocs,
      output: r.output,
    });

    return {
      name: b.name,
      measures: b.measures,
      expected: b.expected,
      baselineNote: b.baselineNote,
      rows: [row("unoptimized", plain), row("optimized", optimized), row("hand-written", handwritten)],
    };
  });
}

/** The report as text, with the three rows under each program and the ratios beside them. */
export function format(reports: readonly BenchmarkReport[]): string {
  const lines: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (n: number) => n.toLocaleString("en-US");

  for (const r of reports) {
    lines.push(`${r.name} — ${r.measures}`);
    if (r.baselineNote !== undefined) lines.push(`  (hand-written row: ${r.baselineNote})`);
    lines.push(`  ${pad("", 14)}${pad("instructions", 15)}${pad("frames", 12)}${pad("allocs", 10)}`);
    for (const row of r.rows) {
      lines.push(
        `  ${pad(row.label, 14)}${pad(num(row.instructions), 15)}${pad(num(row.frames), 12)}${num(row.allocs)}`,
      );
    }

    const plain = r.rows.find((x) => x.label === "unoptimized")!;
    const optimized = r.rows.find((x) => x.label === "optimized")!;
    const handwritten = r.rows.find((x) => x.label === "hand-written")!;

    // Fewer instructions is less work, and the comparison always says which way it went. A bare
    // ratio does not: this line said "optimized/hand-written" while dividing the other way round,
    // which turned a 6x loss into a 6x win for anyone reading it.
    lines.push(
      `  ${pad("", 14)}vs unoptimized: ${work(plain.instructions, optimized.instructions)}` +
        `   vs hand-written: ${work(handwritten.instructions, optimized.instructions)}`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

/** What `value` costs against `baseline`. Fewer instructions is less work. */
export function work(baseline: number, value: number): string {
  if (baseline === 0 || value === 0) return "n/a";
  const ratio = value / baseline;
  // A difference below half a percent is not a difference. Saying "1.00x more" for one instruction
  // out of 600,000 reads as a finding when it is rounding.
  if (Math.abs(ratio - 1) < 0.005) return "the same";
  if (ratio < 1) return `${(baseline / value).toFixed(2)}x fewer instructions`;
  return `${ratio.toFixed(2)}x more instructions`;
}

if (import.meta.main) {
  process.stdout.write(format(report()));
}
