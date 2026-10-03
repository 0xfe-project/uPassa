/**
 * SSA pass manager: scheduling, dependency resolution, and analysis invalidation
 *
 * Responsibilities:
 * - Run passes in dependency order
 * - Compute and cache analyses (domtree, usedef, loops)
 * - Invalidate analyses when passes modify IR
 * - Handle fixed-point iteration (run until no changes)
 * - Provide pass statistics and debugging
 *
 * Unlike nanopass (automatic fusion), SSA passes:
 * - Run independently with explicit dependencies
 * - Modify IR in-place
 * - Invalidate specific analyses
 * - May run multiple times until fixed point
 */

import type { SSAFunction } from "./ir.ts";
import type { SSAPass, ModulePass, SSAAnalyses, AnalysisType, PassResult } from "./pass.ts";
import { buildDomTree, type DomTree } from "./analysis/domtree.ts";
import { buildUseDefChains, type UseDefChains } from "./analysis/usedef.ts";
import { detectLoops, type LoopInfo } from "./analysis/loops.ts";

/**
 * Pass manager configuration
 */
export interface PassManagerConfig {
  /** Maximum iterations for fixed-point passes */
  readonly maxIterations?: number;

  /** Enable pass statistics collection */
  readonly collectStats?: boolean;

  /** Enable verbose logging */
  readonly verbose?: boolean;

  /** Verify IR after each pass (slow, for debugging) */
  readonly verifyEach?: boolean;
}

/**
 * Pass execution statistics
 */
export interface PassStats {
  readonly passName: string;
  readonly runs: number;
  readonly totalTimeMs: number;
  readonly changed: boolean;
  readonly stats?: Record<string, number> | undefined;
}

/**
 * Analysis cache: manages computed analyses and invalidation
 */
class AnalysisCache {
  private cache = new Map<AnalysisType, unknown>();

  get<T>(type: AnalysisType): T | undefined {
    return this.cache.get(type) as T | undefined;
  }

  set(type: AnalysisType, value: unknown): void {
    this.cache.set(type, value);
  }

  invalidate(types: readonly AnalysisType[]): void {
    for (const type of types) {
      this.cache.delete(type);
    }
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  has(type: AnalysisType): boolean {
    return this.cache.has(type);
  }
}

/**
 * SSA pass manager: orchestrates pass execution
 */
export class PassManager {
  private readonly config: Required<PassManagerConfig>;
  private readonly stats: PassStats[] = [];

  constructor(config: PassManagerConfig = {}) {
    this.config = {
      maxIterations: config.maxIterations ?? 10,
      collectStats: config.collectStats ?? false,
      verbose: config.verbose ?? false,
      verifyEach: config.verifyEach ?? false,
    };
  }

  /**
   * Run a sequence of passes on a function until fixed point.
   */
  runOnFunction(func: SSAFunction, passes: readonly SSAPass[]): void {
    const cache = new AnalysisCache();
    let iteration = 0;
    let anyChanged = true;

    while (anyChanged && iteration < this.config.maxIterations) {
      anyChanged = false;
      iteration++;

      if (this.config.verbose && iteration > 1) {
        console.log(`[PassManager] Iteration ${iteration}`);
      }

      for (const pass of passes) {
        const startTime = performance.now();

        // Check if pass should run
        if (pass.shouldRun) {
          const analyses = this.computeAnalyses(func, pass.requires, cache);
          if (!pass.shouldRun(func, analyses)) {
            if (this.config.verbose) {
              console.log(`[PassManager] Skipping ${pass.name} (shouldRun = false)`);
            }
            continue;
          }
        }

        // Compute required analyses
        const analyses = this.computeAnalyses(func, pass.requires, cache);

        // Run the pass
        if (this.config.verbose) {
          console.log(`[PassManager] Running ${pass.name}`);
        }

        const result = pass.run(func, analyses);

        // Record statistics
        const elapsed = performance.now() - startTime;
        if (this.config.collectStats) {
          this.recordStats(pass.name, elapsed, result);
        }

        // Handle invalidation
        if (result.changed) {
          anyChanged = true;
          if (!pass.preservesAll) {
            cache.invalidate(pass.invalidates);
          }
        }

        // Verify if requested
        if (this.config.verifyEach) {
          this.verifyFunction(func, pass.name);
        }
      }
    }

    if (iteration >= this.config.maxIterations) {
      console.warn(`[PassManager] Reached max iterations (${this.config.maxIterations}) without convergence`);
    }
  }

  /**
   * Run a sequence of passes on all functions in a module.
   */
  runOnModule(functions: Map<string, SSAFunction>, passes: readonly (SSAPass | ModulePass)[]): void {
    // Separate function passes and module passes
    const functionPasses = passes.filter((p): p is SSAPass => !("run" in p && p.run.length === 2));
    const modulePasses = passes.filter((p): p is ModulePass => !functionPasses.includes(p as any));

    // Run function passes on each function
    for (const [funcId, func] of functions) {
      if (this.config.verbose) {
        console.log(`[PassManager] Processing function ${funcId}`);
      }
      this.runOnFunction(func, functionPasses);
    }

    // Run module passes
    for (const pass of modulePasses) {
      if (this.config.verbose) {
        console.log(`[PassManager] Running module pass ${pass.name}`);
      }

      const analyses = new Map<string, SSAAnalyses>();
      for (const [funcId, func] of functions) {
        const cache = new AnalysisCache();
        analyses.set(funcId, this.computeAnalyses(func, pass.requires, cache));
      }

      const startTime = performance.now();
      const result = pass.run(functions, analyses);
      const elapsed = performance.now() - startTime;

      if (this.config.collectStats) {
        this.recordStats(pass.name, elapsed, result);
      }
    }
  }

  /**
   * Get collected statistics.
   */
  getStats(): readonly PassStats[] {
    return this.stats;
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats.length = 0;
  }

  /**
   * Compute required analyses, using cache when available.
   */
  private computeAnalyses(
    func: SSAFunction,
    required: readonly AnalysisType[],
    cache: AnalysisCache,
  ): SSAAnalyses {
    const analyses: SSAAnalyses = {};

    for (const type of required) {
      if (cache.has(type)) {
        // Use cached analysis
        switch (type) {
          case "domtree":
            analyses.domtree = cache.get<DomTree>(type);
            break;
          case "usedef":
            analyses.usedef = cache.get<UseDefChains>(type);
            break;
          case "loops":
            analyses.loops = cache.get<LoopInfo>(type);
            break;
        }
      } else {
        // Compute and cache
        switch (type) {
          case "domtree": {
            const domtree = buildDomTree(func);
            cache.set(type, domtree);
            analyses.domtree = domtree;
            break;
          }
          case "usedef": {
            const usedef = buildUseDefChains(func);
            cache.set(type, usedef);
            analyses.usedef = usedef;
            break;
          }
          case "loops": {
            // Loops require domtree
            if (!analyses.domtree) {
              const domtree = cache.get<DomTree>("domtree") ?? buildDomTree(func);
              cache.set("domtree", domtree);
              analyses.domtree = domtree;
            }
            const loops = detectLoops(func, analyses.domtree!);
            cache.set(type, loops);
            analyses.loops = loops;
            break;
          }
        }
      }
    }

    return analyses;
  }

  /**
   * Record pass statistics.
   */
  private recordStats(passName: string, timeMs: number, result: PassResult): void {
    const existing = this.stats.find((s) => s.passName === passName);

    if (existing) {
      (existing as any).runs++;
      (existing as any).totalTimeMs += timeMs;
      (existing as any).changed = existing.changed || result.changed;
      if (result.stats) {
        (existing as any).stats = { ...existing.stats, ...result.stats };
      }
    } else {
      this.stats.push({
        passName,
        runs: 1,
        totalTimeMs: timeMs,
        changed: result.changed,
        stats: result.stats,
      });
    }
  }

  /**
   * Verify function after a pass (for debugging).
   */
  private verifyFunction(func: SSAFunction, passName: string): void {
    // Import verify lazily to avoid circular dependencies
    const { verifySSA } = require("./verify.ts");
    try {
      verifySSA(func);
    } catch (err) {
      throw new Error(`IR verification failed after pass "${passName}": ${(err as Error).message}`);
    }
  }
}

/**
 * Convenience: create a pass manager and run passes.
 */
export function runPasses(func: SSAFunction, passes: readonly SSAPass[], config?: PassManagerConfig): void {
  const manager = new PassManager(config);
  manager.runOnFunction(func, passes);
}

/**
 * Convenience: run passes on a module.
 */
export function runModulePasses(
  functions: Map<string, SSAFunction>,
  passes: readonly (SSAPass | ModulePass)[],
  config?: PassManagerConfig,
): void {
  const manager = new PassManager(config);
  manager.runOnModule(functions, passes);
}

/**
 * Pass pipeline builder: fluent API for constructing pipelines.
 */
export class PassPipelineBuilder {
  private passes: (SSAPass | ModulePass)[] = [];

  /**
   * Add a function pass.
   */
  add(pass: SSAPass): this {
    this.passes.push(pass);
    return this;
  }

  /**
   * Add a module pass.
   */
  addModule(pass: ModulePass): this {
    this.passes.push(pass);
    return this;
  }

  /**
   * Add multiple passes.
   */
  addAll(passes: readonly (SSAPass | ModulePass)[]): this {
    this.passes.push(...passes);
    return this;
  }

  /**
   * Build the pipeline.
   */
  build(): readonly (SSAPass | ModulePass)[] {
    return this.passes;
  }

  /**
   * Run the pipeline on a function.
   */
  runOnFunction(func: SSAFunction, config?: PassManagerConfig): void {
    const functionPasses = this.passes.filter((p): p is SSAPass => "shouldRun" in p);
    runPasses(func, functionPasses, config);
  }

  /**
   * Run the pipeline on a module.
   */
  runOnModule(functions: Map<string, SSAFunction>, config?: PassManagerConfig): void {
    runModulePasses(functions, this.passes, config);
  }
}

/**
 * Create a new pass pipeline builder.
 */
export function pipeline(): PassPipelineBuilder {
  return new PassPipelineBuilder();
}
