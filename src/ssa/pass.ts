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
  domtree?: DomTree | undefined;
  usedef?: UseDefChains | undefined;
  loops?: LoopInfo | undefined;
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
 *
 * Generic over T: works on any IR extension.
 */
export interface SSAPass<T = never> {
  /** Unique pass name */
  readonly name: string;

  /** Analyses this pass requires */
  readonly requires: readonly AnalysisType[];

  /** Analyses this pass invalidates (must be recomputed after) */
  readonly invalidates: readonly AnalysisType[];

  /** Whether this pass preserves all analyses (rare, only for pure analysis passes) */
  readonly preservesAll?: boolean;

  /** Run the pass */
  readonly run: (func: SSAFunction<T>, analyses: SSAAnalyses) => PassResult;

  /** Optional: check if this pass should run (e.g., skip if no opportunities) */
  readonly shouldRun?: ((func: SSAFunction<T>, analyses: SSAAnalyses) => boolean) | undefined;
}

/**
 * Create an SSA pass.
 */
export function ssaPass<T = never>(spec: {
  readonly name: string;
  readonly requires?: readonly AnalysisType[] | undefined;
  readonly invalidates?: readonly AnalysisType[] | undefined;
  readonly preservesAll?: boolean | undefined;
  readonly run: (func: SSAFunction<T>, analyses: SSAAnalyses) => PassResult;
  readonly shouldRun?: ((func: SSAFunction<T>, analyses: SSAAnalyses) => boolean) | undefined;
}): SSAPass<T> {
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
export type FunctionPass<T = never> = SSAPass<T>;

/**
 * Module pass: runs on entire module (all functions).
 * Used for interprocedural optimizations.
 */
export interface ModulePass<T = never> {
  readonly name: string;
  readonly requires: readonly AnalysisType[];
  readonly invalidates: readonly AnalysisType[];
  readonly run: (
    functions: Map<string, SSAFunction<T>>,
    analyses: Map<string, SSAAnalyses>,
  ) => { changed: boolean };
}

/**
 * Create a module pass.
 */
export function modulePass<T = never>(spec: {
  readonly name: string;
  readonly requires?: readonly AnalysisType[] | undefined;
  readonly invalidates?: readonly AnalysisType[] | undefined;
  readonly run: (
    functions: Map<string, SSAFunction<T>>,
    analyses: Map<string, SSAAnalyses>,
  ) => { changed: boolean };
}): ModulePass<T> {
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
export interface PassPipeline<T = never> {
  readonly passes: readonly (FunctionPass<T> | ModulePass<T>)[];

  /** Run all passes on a function */
  readonly runOnFunction: (func: SSAFunction<T>) => void;

  /** Run all passes on a module */
  readonly runOnModule: (functions: Map<string, SSAFunction<T>>) => void;
}

/**
 * Utility: create a simple transform pass (common pattern).
 */
export function transformPass<T = never>(spec: {
  readonly name: string;
  readonly requires?: readonly AnalysisType[] | undefined;
  readonly transform: (func: SSAFunction<T>, analyses: SSAAnalyses) => boolean;
}): SSAPass<T> {
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
export function analysisPass<T = never>(spec: {
  readonly name: string;
  readonly requires?: readonly AnalysisType[] | undefined;
  readonly analyze: (func: SSAFunction<T>, analyses: SSAAnalyses) => void;
}): SSAPass<T> {
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
  "simplification" | "dce" | "scalar" | "loop" | "inlining" | "memory" | "analysis" | "verification";

/**
 * Extended pass with category (for pass manager hints).
 */
export interface CategorizedPass<T = never> extends SSAPass<T> {
  readonly category: PassCategory;
}

/**
 * Create a categorized pass.
 */
export function categorizedPass<T = never>(
  category: PassCategory,
  spec: Parameters<typeof ssaPass<T>>[0],
): CategorizedPass<T> {
  return {
    ...ssaPass(spec),
    category,
  };
}
