/**
 * The SSA-level optimization pipeline.
 *
 * Every pass here is a *user* pass: it is built on the framework's `ssaPass` and run through the
 * framework's `PassManager`, and it knows nothing the framework does not expose. That is the point
 * of running them from `e2e/` — they are the framework's own exercise, not part of it.
 *
 * ── Where mem2reg went
 *
 * There is no mem2reg pass, because there is nothing for it to do. In a conventional pipeline
 * mem2reg promotes the load/store slots a frontend emits into SSA values; here the SSA construction
 * (Braun) consumes variables directly and produces phis, so the slots never exist. Adding a pass
 * that promoted already-promoted values would be a pass that never fires.
 *
 * ── Why a fixpoint
 *
 * The passes feed each other: CSE makes a value dead and DCE removes it, folding a constant makes
 * an instruction redundant, and copy propagation exposes an expression that CSE can then merge.
 * Running the list once leaves work behind. The loop stops when a whole round changes nothing.
 */

import { PassManager } from "../../src/ssa/pass-manager.ts";
import type { SSAPass } from "../../src/ssa/pass.ts";
import type { SSAFunction } from "../../src/ssa/ir.ts";
import { schemeOps, type SchemeNode } from "./ir.ts";
import { copyPropPass } from "./ssa-passes/copy-prop.ssa.pass.ts";
import { constFoldPass } from "./ssa-passes/const-fold.ssa.pass.ts";
import { dcePass } from "./ssa-passes/dce.ssa.pass.ts";
import { csePass } from "./ssa-passes/cse.ssa.pass.ts";

/**
 * The passes, in the order they run in a round.
 *
 * Copy propagation first: it removes instructions, which makes the rest cheaper. DCE last: it
 * cleans up whatever the others left dead.
 */
export const SSA_PASSES: readonly SSAPass<SchemeNode>[] = [copyPropPass, constFoldPass, csePass, dcePass];

export interface OptimizeOptions {
  /** Stop after this many rounds even if something is still changing. */
  readonly maxRounds?: number;
  // (the manager's own iteration cap; a round is one run of the whole list)
  /** Verify the IR after every pass. Slow; used by tests. */
  readonly verifyEach?: boolean;
}

export interface OptimizeStats {
  /** Rounds actually run. */
  rounds: number;
  /** Per pass name, how many times it reported a change. */
  changed: Record<string, number>;
}

/** Optimize one function in place, to a fixpoint. */
export function optimizeFunction(fn: SSAFunction<SchemeNode>, opts: OptimizeOptions = {}): OptimizeStats {
  const manager = new PassManager<SchemeNode>({
    verifyEach: opts.verifyEach ?? false,
    ops: schemeOps,
    collectStats: true,
    maxIterations: opts.maxRounds ?? 20,
  });

  // The manager already repeats the list until a whole round changes nothing, so the loop is its
  // job, not ours. Doing it here as well would run every pass twice over the same fixpoint.
  manager.runOnFunction(fn, SSA_PASSES);

  const changed: Record<string, number> = {};
  for (const s of manager.getStats()) {
    if (s.changed) changed[s.passName] = (changed[s.passName] ?? 0) + 1;
  }
  return { rounds: manager.getStats().length > 0 ? 1 : 0, changed };
}

/** Optimize every function of a module. */
export function optimizeModule(
  functions: Map<string, SSAFunction<SchemeNode>>,
  opts: OptimizeOptions = {},
): OptimizeStats {
  const total: OptimizeStats = { rounds: 0, changed: {} };
  for (const fn of functions.values()) {
    const s = optimizeFunction(fn, opts);
    total.rounds = Math.max(total.rounds, s.rounds);
    for (const [k, v] of Object.entries(s.changed)) total.changed[k] = (total.changed[k] ?? 0) + v;
  }
  return total;
}
