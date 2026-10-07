/**
 * The benchmark report.
 *
 * Four rows per program. They are not four measurements of the same thing — they answer four
 * different questions, and reading one as another is the mistake this file was written to correct:
 *
 *   interpreted   the same source text, run with no compiler at all. Answers **what compiling buys**
 *                 — name lookup instead of register access, every sugar form still present, every
 *                 `lambda` a heap closure.
 *   compiled      the same source, through the front end, the lowering and the SSA construction,
 *   (no opt)      with the optimization passes off. Answers **what the SSA passes buy**.
 *   compiled      the same, with the passes on.
 *   (optimized)
 *   hand-written  a *different program*: the same computation in C style, loops instead of
 *                 recursion, no intermediate data. Answers **what the source's choice of algorithm
 *                 costs** — and it is the only row the compiler cannot be judged against, because
 *                 it is not the same source. It was, in the first version of this report, the only
 *                 baseline there was.
 *
 * Wall-clock is deliberately absent. The interpreter's dispatch dominates it, so it would measure
 * the interpreter rather than the program. What is reported is what the *program* does:
 *
 *   instructions  one operation. For a compiled row: one instruction executed, plus one per frame
 *                 slot written when a call is entered. Phi nodes and terminators are not counted —
 *                 a phi names a merge of values that already exist, and counting phis but not
 *                 terminators would decide "did this tail call become a loop" by the counting. For
 *                 the interpreted row: one tree node evaluated, plus one per variable reference.
 *   frames        frames allocated. A tail call reuses the caller's frame in both rows.
 *   allocs        heap allocations: pairs and closures.
 *
 * The interpreted row's unit is coarser than a compiled instruction — a tree node may expand to
 * several instructions and vice versa — and its omissions (chain depth, dispatch, frame setup) are
 * all in the direction of making it look cheaper. So the factor between the two rows is indicative,
 * and it is a lower bound on what compiling saved.
 *
 * The expected value is checked for every row. A row that computed something else would otherwise
 * look like a very fast result.
 *
 * Comparisons are stated as what a row does against a baseline, never as a bare ratio: fewer
 * instructions is less work, and a ratio whose direction is only implied gets read the wrong way —
 * which is exactly what happened to this file's first version.
 */

import { run } from "../interp.ts";
import { runSource } from "../run.ts";
import { parse } from "../surface.ts";
import { runTree } from "../tree-interp.ts";
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
    const interpreted = runTree(parse(b.source));

    check(`${b.name} interpreted`, interpreted.output, b.expected);
    check(`${b.name} unoptimized`, plain.output, b.expected);
    check(`${b.name} optimized`, optimized.output, b.expected);
    check(`${b.name} hand-written`, handwritten.output, b.expected);

    const row = (
      label: string,
      r: { output: readonly string[]; stats: { instructions: number; frames: number; allocs: number } },
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
      rows: [
        // The same source text, twice: interpreted directly and compiled. That pair is what answers
        // "what did compiling buy". The hand-written row is a different program and answers a
        // different question — see the note at the top of the file.
        row("interpreted", {
          output: interpreted.output,
          stats: {
            instructions: interpreted.stats.steps,
            frames: interpreted.stats.frames,
            allocs: interpreted.stats.allocs,
          },
        }),
        row("compiled", plain),
        row("optimized", optimized),
        row("hand-written", handwritten),
      ],
    };
  });
}

/** The report as text, with the rows under each program and what each comparison means. */
export function format(reports: readonly BenchmarkReport[]): string {
  const lines: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (n: number) => n.toLocaleString("en-US");
  const LABEL = 14;

  lines.push("Four rows, four questions:");
  lines.push("  interpreted   the same source, no compiler          what compiling buys");
  lines.push("  compiled      the same source, SSA passes off       what the SSA passes buy");
  lines.push("  optimized     the same source, SSA passes on");
  lines.push("  hand-written  a different algorithm, in C style     what the algorithm costs");
  lines.push("");

  for (const r of reports) {
    lines.push(`${r.name} — ${r.measures}`);
    if (r.baselineNote !== undefined) lines.push(`  (hand-written row: ${r.baselineNote})`);
    lines.push(`  ${pad("", LABEL)}${pad("instructions", 15)}${pad("frames", 12)}${pad("allocs", 10)}`);
    for (const row of r.rows) {
      lines.push(
        `  ${pad(row.label, LABEL)}${pad(num(row.instructions), 15)}${pad(num(row.frames), 12)}${num(row.allocs)}`,
      );
    }

    const interpreted = r.rows.find((x) => x.label === "interpreted")!;
    const plain = r.rows.find((x) => x.label === "compiled")!;
    const optimized = r.rows.find((x) => x.label === "optimized")!;
    const handwritten = r.rows.find((x) => x.label === "hand-written")!;

    // Fewer instructions is less work, and the comparison always says which way it went. A bare
    // ratio does not: this line said "optimized/hand-written" while dividing the other way round,
    // which turned a 6x loss into a 6x win for anyone reading it.
    lines.push(
      `  ${pad("", LABEL)}compiling bought: ${work(interpreted.instructions, optimized.instructions)}` +
        `   the SSA passes bought: ${work(plain.instructions, optimized.instructions)}`,
    );
    lines.push(
      `  ${pad("", LABEL)}the hand-written row (a different algorithm) does: ` +
        `${work(optimized.instructions, handwritten.instructions)}`,
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
