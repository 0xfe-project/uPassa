/**
 * Source text to a running program.
 *
 * The one place that knows the whole chain, so a test or a benchmark says `runSource(...)` rather
 * than repeating the four steps and getting the order wrong.
 */

import { toSSA } from "../../src/ssa/braun.ts";
import { verifySSASafe } from "../../src/ssa/verify.ts";
import { compile } from "./pipeline.ts";
import { optimizeModule, type OptimizeStats } from "./optimize.ts";
import { lower, type LoweredProgram } from "./lower.ts";
import { run, type RunOptions, type RunResult, type Value } from "./interp.ts";
import { schemeOps, type SchemeNode } from "./ir.ts";
import type { SSAFunction } from "../../src/ssa/ir.ts";
import type { S14_Program } from "./langs/chain.ts";

export interface CompileOptions {
  /** Run the nanopass passes fused. Default false. */
  readonly fuse?: boolean;
  /** Build SSA before running. Default true — the benchmarks measure the optimized shape. */
  readonly ssa?: boolean;
  /** Run the SSA optimization passes. Default false, so tests can compare the two. */
  readonly optimize?: boolean;
  /** Verify the IR after every optimization pass. Slow. */
  readonly verifyEach?: boolean;
}

export interface CompiledProgram {
  readonly tree: S14_Program;
  readonly lowered: LoweredProgram;
  /** What the interpreter actually executes: the SSA functions when `ssa` is on. */
  readonly module: Map<string, SSAFunction<SchemeNode>>;
  readonly entry: string;
  /** Present only when `optimize` was on. */
  readonly optimizeStats?: OptimizeStats | undefined;
}

export function compileProgram(source: string, opts: CompileOptions = {}): CompiledProgram {
  const tree = compile(source, { fuse: opts.fuse ?? false });
  const lowered = lower(tree);
  if (opts.ssa === false) {
    return { tree, lowered, module: lowered.functions, entry: lowered.entry };
  }
  const module = new Map<string, SSAFunction<SchemeNode>>();
  for (const [name, fn] of lowered.functions) {
    // What the lowering produces is *not* SSA: a value produced in both arms of an `if` is one
    // variable with two definitions, which is the input the SSA construction expects. So the
    // check goes on the output, not the input.
    const ssa = toSSA(fn, schemeOps);
    const result = verifySSASafe(ssa, schemeOps);
    if (result.errors.length > 0) {
      throw new Error(`${name} is not valid SSA after construction: ${result.errors.join("; ")}`);
    }
    module.set(name, ssa);
  }
  const optimizeStats =
    opts.optimize === true ? optimizeModule(module, { verifyEach: opts.verifyEach ?? false }) : undefined;

  return { tree, lowered, module, entry: lowered.entry, optimizeStats };
}

/** Compile and run, returning the value, the printed output, and the counters. */
export function runSource(
  source: string,
  args: Value[] = [],
  opts: CompileOptions & RunOptions = {},
): RunResult {
  const { module, entry } = compileProgram(source, opts);
  return run(module, entry, args, opts);
}
