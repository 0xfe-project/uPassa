/**
 * Lowering: L_final (nanopass) → SSA IR
 *
 * Converts the final nanopass tree (explicit control flow, no nested expressions)
 * into SSA IR suitable for graph-based optimization.
 *
 * Responsibilities:
 * - Build basic blocks from tree structure
 * - Generate explicit jumps and branches
 * - Prepare for SSA construction (Braun algorithm)
 *
 * Input: L_final tree with:
 * - Explicit control flow (if, loop, sequence)
 * - Flat expressions (no nesting)
 * - Closure-converted lambdas
 *
 * Output: CFG (control flow graph) ready for SSA construction:
 * - Basic blocks with instructions
 * - Explicit predecessor/successor edges
 * - Variable definitions and uses
 */

// TODO: Import L_final language definition once nanopass chain is designed
// import type { L_final } from "../nanopass/langs/l-final.ts";

import type { SSAFunction, BasicBlock, BlockId } from "../../src/ssa/ir.ts";

/**
 * Lower result: CFG ready for SSA construction
 */
export interface LowerResult<T> {
  func: SSAFunction<T>;
}

/**
 * Lower a nanopass tree to SSA IR.
 *
 * This is the bridge between nanopass (functional tree rewriting)
 * and SSA (graph-based optimization).
 *
 * @param tree - Final nanopass tree
 * @returns CFG ready for SSA construction
 */
export function lower(tree: unknown): LowerResult<unknown> {
  // TODO: Implement lowering once L_final is defined
  throw new Error("Lowering not yet implemented - waiting for nanopass language chain");
}

/**
 * Example: Lower a simple arithmetic expression to SSA
 */
export function exampleLowering(): SSAFunction<{ op: string; args: string[] }> {
  const entry: BlockId = "entry";
  const blocks = new Map<BlockId, BasicBlock<{ op: string; args: string[] }>>();

  blocks.set(entry, {
    id: entry,
    instructions: [
      { op: "const", args: ["1"] },
      { op: "const", args: ["2"] },
      { op: "add", args: ["%1", "%2"] },
    ],
    terminator: { type: "ret", value: "%3" },
    predecessors: [],
    successors: [],
  });

  return {
    id: "example",
    entry,
    blocks,
  };
}
