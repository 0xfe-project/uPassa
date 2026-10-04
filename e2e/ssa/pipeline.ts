/**
 * SSA pipeline: compose the optimization passes
 *
 * Runs a sequence of SSA passes using the pass manager.
 */

import { PassManager, type PassManagerConfig } from "../../src/ssa/pass-manager.js";
import type { SSAFunction } from "../../src/ssa/ir.js";
import { dcePass, sccpPass, simplifyCFGPass, copyPropPass, type TestInstr } from "./passes.js";

/**
 * Standard optimization pipeline: SCCP → CopyProp → DCE → SimplifyCFG
 */
export const OPTIMIZATION_PASSES = [sccpPass, copyPropPass, dcePass, simplifyCFGPass];

/**
 * Run the standard optimization pipeline on a function.
 */
export function runPipeline(func: SSAFunction<TestInstr>, config?: PassManagerConfig): void {
  const manager = new PassManager<TestInstr>(config);
  manager.runOnFunction(func, OPTIMIZATION_PASSES);
}

/**
 * Pipeline description for documentation / debugging.
 */
export const PIPELINE_STEPS = [
  { name: "sccp", requires: [], invalidates: ["usedef"] },
  { name: "copyprop", requires: ["usedef"], invalidates: ["usedef"] },
  { name: "dce", requires: ["usedef"], invalidates: ["usedef"] },
  { name: "simplifycfg", requires: [], invalidates: ["usedef", "domtree", "loops"] },
] as const;
