/**
 * SSA pass declaration interface
 *
 * Similar to nanopass passes, but for graph transformations on SSA IR.
 *
 * Unlike tree passes:
 * - No automatic fusion (graph structure is mutable)
 * - Passes modify IR in-place
 * - Dependencies declared explicitly (domtree, loops, usedef)
 * - Pass manager handles scheduling and analysis invalidation
 *
 * Example:
 *
 * ```typescript
 * const myPass = ssaPass({
 *   name: "my-optimization",
 *   requires: ["domtree", "usedef"],
 *   invalidates: ["usedef"],
 *   run: (func, analyses) => {
 *     const domTree = analyses.domtree;
 *     const usedef = analyses.usedef;
 *     // Transform func...
 *     return { changed: true };
 *   }
 * });
 * ```
 */

import type { SSAFunction } from "./ir.ts";
import type { DomTree } from "./analysis/domtree.ts";
import type { UseDefChains } from "./analysis/usedef.ts";
import type { LoopInfo } from "./analysis/loops.ts";

/**
 * Available analyses that passes can depend on
 */
export interface SSAAnalyses {
  domtree?: DomTree;
  usedef?: UseDefChains;
  loops?: LoopInfo;
}

/**
 * Analysis types that can be requested
 */
export type AnalysisType = "domtree" | "usedef" | "loops";

/**
 * Result of running a pass
 */
export interface PassResult {
  /** Whether the pass changed the IR */
  changed: boolean;
  /** Optional stats for reporting */
  stats?: Record<string, number>;
}

/**
 * SSA pass definition
 */
export interface SSAPass {
  /** Unique pass name */
  readonly name: string;

  /** Analyses this pass requires */
  readonly requires: readonly AnalysisType[];

  /** Analyses this pass invalidates (must be recomputed after) */
  readonly invalidates: readonly AnalysisType[];

  /** Whether this pass preserves all analyses (rare, only for pure analysis passes) */
  readonly preservesAll?: boolean;

  /** Run the pass */
  readonly run: (func: SSAFunction, analyses: SSAAnalyses) => PassResult;

  /** Optional: check if this pass should run (e.g., skip if no opportunities) */
  readonly shouldRun?: ((func: SSAFunction, analyses: SSAAnalyses) => boolean) | undefined;
}

/**
 * Create an SSA pass.
 */
export function ssaPass(spec: {
  readonly name: string;
  readonly requires?: readonly AnalysisType[] | undefined;
  readonly invalidates?: readonly AnalysisType[] | undefined;
  readonly preservesAll?: boolean | undefined;
  readonly run: (func: SSAFunction, analyses: SSAAnalyses) => PassResult;
  readonly shouldRun?: ((func: SSAFunction, analyses: SSAAnalyses) => boolean) | undefined;
}): SSAPass {
  return {
    name: spec.name,
    requires: spec.requires ?? [],
    invalidates: spec.invalidates ?? [],
    preservesAll: spec.preservesAll ?? false,
    run: spec.run,
    shouldRun: spec.shouldRun,
  };
}

/**
 * Function pass: runs on each function independently.
 * The default and most common type of SSA pass.
 */
export type FunctionPass = SSAPass;

/**
 * Module pass: runs on entire module (all functions).
 * Used for interprocedural optimizations.
 */
export interface ModulePass {
  readonly name: string;
  readonly requires: readonly AnalysisType[];
  readonly invalidates: readonly AnalysisType[];
  readonly run: (
    functions: Map<string, SSAFunction>,
    analyses: Map<string, SSAAnalyses>,
  ) => { changed: boolean };
}

/**
 * Create a module pass.
 */
export function modulePass(spec: {
  readonly name: string;
  readonly requires?: readonly AnalysisType[] | undefined;
  readonly invalidates?: readonly AnalysisType[] | undefined;
  readonly run: (
    functions: Map<string, SSAFunction>,
    analyses: Map<string, SSAAnalyses>,
  ) => { changed: boolean };
}): ModulePass {
  return {
    name: spec.name,
    requires: spec.requires ?? [],
    invalidates: spec.invalidates ?? [],
    run: spec.run,
  };
}

/**
 * Pass pipeline: sequence of passes with dependency resolution.
 */
export interface PassPipeline {
  readonly passes: readonly (FunctionPass | ModulePass)[];

  /** Run all passes on a function */
  readonly runOnFunction: (func: SSAFunction) => void;

  /** Run all passes on a module */
  readonly runOnModule: (functions: Map<string, SSAFunction>) => void;
}

/**
 * Utility: create a simple transform pass (common pattern).
 */
export function transformPass(spec: {
  readonly name: string;
  readonly requires?: readonly AnalysisType[] | undefined;
  readonly transform: (func: SSAFunction, analyses: SSAAnalyses) => boolean;
}): SSAPass {
  return ssaPass({
    name: spec.name,
    requires: spec.requires,
    invalidates: ["usedef"], // Most transforms invalidate usedef
    run: (func, analyses) => {
      const changed = spec.transform(func, analyses);
      return { changed };
    },
  });
}

/**
 * Utility: create an analysis pass (computes but doesn't modify).
 */
export function analysisPass(spec: {
  readonly name: string;
  readonly requires?: readonly AnalysisType[] | undefined;
  readonly analyze: (func: SSAFunction, analyses: SSAAnalyses) => void;
}): SSAPass {
  return ssaPass({
    name: spec.name,
    requires: spec.requires,
    invalidates: [],
    preservesAll: true,
    run: (func, analyses) => {
      spec.analyze(func, analyses);
      return { changed: false };
    },
  });
}

/**
 * Common pass categories (for organization and scheduling hints).
 */
export type PassCategory =
  | "simplification"
  | "dce"
  | "scalar"
  | "loop"
  | "inlining"
  | "memory"
  | "analysis"
  | "verification";

/**
 * Extended pass with category (for pass manager hints).
 */
export interface CategorizedPass extends SSAPass {
  readonly category: PassCategory;
}

/**
 * Create a categorized pass.
 */
export function categorizedPass(
  category: PassCategory,
  spec: Parameters<typeof ssaPass>[0],
): CategorizedPass {
  return {
    ...ssaPass(spec),
    category,
  };
}
