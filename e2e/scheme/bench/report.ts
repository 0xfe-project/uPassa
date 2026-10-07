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
 *   instructions  one per instruction executed, phis included, plus one per frame slot written
 *                 when a call is entered — entering a call is work a C loop does not do
 *   frames        frames created; a self tail call that became a loop reuses one
 *   allocs        heap allocations: pairs and closures
 *
 * The expected value is checked for every row. A row that computed something else would otherwise
 * look like a very fast result.
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
    lines.push(`  ${pad("", 14)}${pad("instructions", 15)}${pad("frames", 12)}${pad("allocs", 10)}`);
    for (const row of r.rows) {
      lines.push(
        `  ${pad(row.label, 14)}${pad(num(row.instructions), 15)}${pad(num(row.frames), 12)}${num(row.allocs)}`,
      );
    }

    const [plain, optimized, handwritten] = r.rows as [Row, Row, Row];
    lines.push(
      `  ${pad("", 14)}optimized/unoptimized ${ratio(plain.instructions, optimized.instructions)}` +
        `   optimized/hand-written ${ratio(handwritten.instructions, optimized.instructions)}`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

/** `to / from`, as `n×`. */
function ratio(from: number, to: number): string {
  if (to === 0) return "n/a";
  return `${(from / to).toFixed(2)}×`;
}

if (import.meta.main) {
  process.stdout.write(format(report()));
}
