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

import type { SSAFunction, BlockId, ValueType } from "../../src/ssa/ir.ts";
import { SSABuilder } from "../../src/ssa/codegen.ts";

/**
 * Lower result: CFG ready for SSA construction
 */
export interface LowerResult {
  /** The function in pre-SSA form (explicit control flow, no phi nodes yet) */
  cfg: SSAFunction;

  /** Variable mapping (source name → initial block assignments) */
  variables: Map<string, { block: BlockId; value: string }>;
}

/**
 * Lower L_final tree to SSA IR (CFG form, before phi insertion).
 *
 * This produces a CFG that will be fed into the Braun algorithm
 * to construct proper SSA form with phi nodes.
 */
export function lowerToSSA(tree: unknown /* L_final.Program */): LowerResult {
  // TODO: Implement once L_final is defined
  throw new Error("lowerToSSA: not implemented yet (requires L_final definition)");
}

/**
 * Lower a single function definition.
 */
function lowerFunction(func: unknown /* L_final.Function */): SSAFunction {
  // TODO: Implement
  throw new Error("lowerFunction: not implemented yet");
}

/**
 * Lower an expression to a sequence of instructions.
 */
function lowerExpression(
  expr: unknown /* L_final.Expr */,
  builder: SSABuilder,
  currentBlock: BlockId,
): { value: string; block: BlockId } {
  // TODO: Implement
  throw new Error("lowerExpression: not implemented yet");
}

/**
 * Lower a control flow construct (if, loop, sequence).
 */
function lowerControl(
  control: unknown /* L_final.Control */,
  builder: SSABuilder,
  currentBlock: BlockId,
): BlockId {
  // TODO: Implement
  throw new Error("lowerControl: not implemented yet");
}

/**
 * Placeholder: Example of what lowering might look like
 *
 * Input (L_final pseudo-tree):
 * ```
 * (define (add-one x)
 *   (+ x 1))
 * ```
 *
 * Output (CFG before SSA):
 * ```
 * entry:
 *   v0 = param x
 *   v1 = const 1
 *   v2 = add v0 v1
 *   ret v2
 * ```
 *
 * After Braun (SSA with phi nodes):
 * ```
 * entry:
 *   v0 = param x
 *   v1 = const 1
 *   v2 = add v0 v1
 *   ret v2
 * ```
 * (In this case, no phi nodes needed since no control flow merges)
 */
export function exampleLowering(): SSAFunction {
  const builder = new SSABuilder("add-one");

  // Single basic block
  const entry = builder.freshBlock();
  builder.entry = entry;

  const intType: ValueType = "int";

  builder.addBlock(entry, {
    id: entry,
    instructions: [
      {
        kind: "const",
        id: "v1",
        type: intType,
        value: 1,
      },
      {
        kind: "binop",
        id: "v2",
        type: intType,
        op: "add",
        left: "v0",
        right: "v1",
      },
    ],
    terminator: {
      kind: "ret",
      value: "v2",
    },
    predecessors: [],
    successors: [],
  });

  return builder.build([{ id: "v0", type: intType }], intType);
}
