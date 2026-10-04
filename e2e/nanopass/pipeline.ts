/**
 * Nanopass pipeline: compose the transformation chain
 *
 * L0 → L1 → L2 → L3
 *
 * Each pass is a function from one language to the next.
 * The pipeline runs them in sequence.
 */

import { desugarLet, explicitRefs, flatten, resetTempCounter } from "./passes.js";
import type { L0_Expr, L1_Expr, L2_Expr, L3_Expr } from "./languages.js";

/**
 * Run the full nanopass pipeline on a source expression.
 */
export function runPipeline(source: L0_Expr): L3_Expr {
  resetTempCounter();

  const l1 = desugarLet(source);
  const l2 = explicitRefs(l1);
  const l3 = flatten(l2);

  return l3;
}

/**
 * Run the pipeline step by step, collecting intermediate results.
 */
export function runPipelineSteps(source: L0_Expr): {
  l0: L0_Expr;
  l1: L1_Expr;
  l2: L2_Expr;
  l3: L3_Expr;
} {
  resetTempCounter();

  const l1 = desugarLet(source);
  const l2 = explicitRefs(l1);
  const l3 = flatten(l2);

  return { l0: source, l1, l2, l3 };
}

/**
 * Pipeline description for documentation / debugging.
 */
export const PIPELINE_STEPS = [
  { name: "desugar-let", from: "L0", to: "L1" },
  { name: "explicit-refs", from: "L1", to: "L2" },
  { name: "flatten", from: "L2", to: "L3" },
] as const;
