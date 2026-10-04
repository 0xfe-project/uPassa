/**
 * Lowering: nanopass output (L3) → SSA input
 *
 * Converts the final nanopass tree into a control-flow graph ready for
 * SSA construction (Braun algorithm).
 *
 * Scope: the arithmetic subset of L3 (Int, Ref, Add, Mul, Temp, Seq).
 * This demonstrates the bridge between the two layers. A real compiler
 * would lower a much richer language (closures, calls, control flow).
 *
 * Input:  L3_Expr   (flattened tree with temporaries)
 * Output: SSAFunction<SSAInstr>  (single basic block)
 */

import type { SSAFunction, BasicBlock, BlockId } from "../../src/ssa/ir.js";
import type { L3_Expr } from "../nanopass/languages.js";

/**
 * Instructions produced by the lowering.
 * These are the user's instruction types — the framework does not know them.
 */
export type SSAInstr =
  | { type: "const"; dest: string; value: number }
  | { type: "add"; dest: string; left: string; right: string }
  | { type: "mul"; dest: string; left: string; right: string }
  | { type: "mov"; dest: string; src: string };

/**
 * Lowering state: fresh name counter and emitted instructions.
 */
class Lowerer {
  private counter = 0;
  private instructions: SSAInstr[] = [];

  fresh(prefix: string): string {
    return `${prefix}${this.counter++}`;
  }

  emit(instr: SSAInstr): void {
    this.instructions.push(instr);
  }

  /**
   * Lower an expression, returning the name holding its value.
   *
   * This is a simple tree walk: the arithmetic subset has no control flow,
   * so every expression produces exactly one value.
   */
  lower(expr: L3_Expr): string {
    switch (expr.type) {
      case "Int": {
        const dest = this.fresh("t");
        this.emit({ type: "const", dest, value: expr.value });
        return dest;
      }

      case "Ref":
        // A reference to a bound name; the name itself is the value.
        return expr.name;

      case "Add": {
        const left = this.lower(expr.left);
        const right = this.lower(expr.right);
        const dest = this.fresh("t");
        this.emit({ type: "add", dest, left, right });
        return dest;
      }

      case "Mul": {
        const left = this.lower(expr.left);
        const right = this.lower(expr.right);
        const dest = this.fresh("t");
        this.emit({ type: "mul", dest, left, right });
        return dest;
      }

      case "Temp": {
        // A temporary binding: lower the bound expression and record its name.
        const src = this.lower(expr.expr);
        const dest = `t${expr.id}`;
        this.emit({ type: "mov", dest, src });
        return dest;
      }

      case "Seq": {
        // Lower all bindings, then the result.
        for (const binding of expr.bindings) {
          this.lower(binding);
        }
        return this.lower(expr.result);
      }

      default:
        throw new Error(`[lower] unsupported expression: ${(expr as { type: string }).type}`);
    }
  }

  finish(result: string, id: string): SSAFunction<SSAInstr> {
    const entry: BlockId = "entry";
    const block: BasicBlock<SSAInstr> = {
      id: entry,
      instructions: this.instructions,
      terminator: { type: "ret", value: result },
      predecessors: [],
      successors: [],
    };

    return {
      id,
      entry,
      blocks: new Map([[entry, block]]),
    };
  }
}

/**
 * Lower an L3 expression to an SSA function.
 */
export function lower(expr: L3_Expr, id = "main"): SSAFunction<SSAInstr> {
  const lowerer = new Lowerer();
  const result = lowerer.lower(expr);
  return lowerer.finish(result, id);
}
