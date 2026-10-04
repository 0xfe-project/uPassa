/**
 * SSA optimization passes for testing
 *
 * These passes demonstrate the SSA pass infrastructure.
 * They are NOT production-quality optimizations - just examples.
 */

import { ssaPass, transformPass } from "../../src/ssa/pass.js";
import type { SSAFunction, BasicBlock, Instruction, Terminator, PhiNode } from "../../src/ssa/ir.js";
import type { SSAAnalyses } from "../../src/ssa/pass.js";

/**
 * Example instruction type for testing
 */
export type TestInstr =
  | { type: "const"; dest: string; value: number }
  | { type: "add"; dest: string; left: string; right: string }
  | { type: "mul"; dest: string; left: string; right: string }
  | { type: "mov"; dest: string; src: string }
  | { type: "load"; dest: string; addr: string }
  | { type: "store"; addr: string; value: string };

/**
 * Dead Code Elimination (DCE)
 *
 * Remove instructions whose results are never used.
 * This is a simple local DCE - doesn't handle control flow.
 */
export const dcePass = transformPass({
  name: "dce",
  requires: ["usedef"],
  transform(func: SSAFunction<TestInstr>, analyses: SSAAnalyses): boolean {
    const usedef = analyses.usedef;
    if (!usedef) return false;

    let changed = false;

    for (const [_, block] of func.blocks) {
      const newInstrs: Instruction<TestInstr>[] = [];

      for (const instr of block.instructions) {
        // Keep phi nodes if they have uses
        if (instr.type === "phi") {
          const uses = usedef.getUses(instr.dest);
          if (uses.length > 0) {
            newInstrs.push(instr);
          } else {
            changed = true;
          }
          continue;
        }

        // Keep instructions without dest (side effects)
        if (!("dest" in instr)) {
          newInstrs.push(instr);
          continue;
        }

        // Keep instructions with uses
        const uses = usedef.getUses(instr.dest);
        if (uses.length > 0) {
          newInstrs.push(instr);
        } else {
          changed = true;
        }
      }

      block.instructions = newInstrs;
    }

    return changed;
  },
});

/**
 * Sparse Conditional Constant Propagation (SCCP)
 *
 * Propagate constants through the CFG using SSA form.
 * Simplified version - only handles integer constants.
 */
export const sccpPass = transformPass({
  name: "sccp",
  transform(func: SSAFunction<TestInstr>, _analyses: SSAAnalyses): boolean {
    // Map variable name -> constant value (if known)
    const constants = new Map<string, number>();
    let changed = false;

    // Collect constants
    for (const [_, block] of func.blocks) {
      for (const instr of block.instructions) {
        if (instr.type === "const") {
          constants.set(instr.dest, instr.value);
        }
      }
    }

    // Propagate and fold
    for (const [_, block] of func.blocks) {
      const newInstrs: Instruction<TestInstr>[] = [];

      for (const instr of block.instructions) {
        if (instr.type === "phi") {
          newInstrs.push(instr);
          continue;
        }

        // Try to fold add
        if (instr.type === "add") {
          const leftVal = constants.get(instr.left);
          const rightVal = constants.get(instr.right);

          if (leftVal !== undefined && rightVal !== undefined) {
            const result = leftVal + rightVal;
            constants.set(instr.dest, result);
            newInstrs.push({ type: "const", dest: instr.dest, value: result });
            changed = true;
            continue;
          }
        }

        // Try to fold mul
        if (instr.type === "mul") {
          const leftVal = constants.get(instr.left);
          const rightVal = constants.get(instr.right);

          if (leftVal !== undefined && rightVal !== undefined) {
            const result = leftVal * rightVal;
            constants.set(instr.dest, result);
            newInstrs.push({ type: "const", dest: instr.dest, value: result });
            changed = true;
            continue;
          }
        }

        // Replace mov with constant
        if (instr.type === "mov") {
          const srcVal = constants.get(instr.src);
          if (srcVal !== undefined) {
            constants.set(instr.dest, srcVal);
            newInstrs.push({ type: "const", dest: instr.dest, value: srcVal });
            changed = true;
            continue;
          }
        }

        newInstrs.push(instr);
      }

      block.instructions = newInstrs;
    }

    return changed;
  },
});

/**
 * SimplifyCFG
 *
 * Simplify control flow graph:
 * - Remove unreachable blocks
 * - Merge blocks with single predecessor and single successor
 */
export const simplifyCFGPass = transformPass({
  name: "simplifycfg",
  transform(func: SSAFunction<TestInstr>, _analyses: SSAAnalyses): boolean {
    // Find reachable blocks
    const reachable = new Set<string>();
    const queue = [func.entry];

    while (queue.length > 0) {
      const label = queue.shift()!;
      if (reachable.has(label)) continue;
      reachable.add(label);

      const block = func.blocks.get(label);
      if (!block) continue;

      // Add successors to queue
      for (const succ of block.successors) {
        queue.push(succ);
      }
    }

    // Remove unreachable blocks
    let changed = false;
    for (const [label, _] of func.blocks) {
      if (!reachable.has(label)) {
        func.blocks.delete(label);
        changed = true;
      }
    }

    return changed;
  },
});

/**
 * Mem2Reg (simplified stub)
 *
 * Promote memory operations to registers using SSA.
 * This is a stub - real mem2reg would analyze alloca/load/store.
 */
export const mem2regPass = transformPass({
  name: "mem2reg",
  requires: ["domtree"],
  transform(func: SSAFunction<TestInstr>, analyses: SSAAnalyses): boolean {
    // Stub: in a real implementation, this would:
    // 1. Find alloca instructions
    // 2. Check if they can be promoted (no address taken, simple uses)
    // 3. Replace load/store with SSA values and phi nodes
    // 4. Use the Braun algorithm to insert phis

    // For now, just return unchanged
    return false;
  },
});

/**
 * Copy Propagation
 *
 * Replace uses of copied values with the original.
 * x = mov y  -->  replace all uses of x with y
 */
export const copyPropPass = transformPass({
  name: "copyprop",
  requires: ["usedef"],
  transform(func: SSAFunction<TestInstr>, analyses: SSAAnalyses): boolean {
    const usedef = analyses.usedef;
    if (!usedef) return false;

    // Find mov instructions
    const copies = new Map<string, string>();

    for (const [_, block] of func.blocks) {
      for (const instr of block.instructions) {
        if (instr.type === "mov") {
          copies.set(instr.dest, instr.src);
        }
      }
    }

    if (copies.size === 0) return false;

    let changed = false;

    // Replace uses in instructions
    for (const [_, block] of func.blocks) {
      for (const instr of block.instructions) {
        if (instr.type === "phi") {
          // Replace phi incoming values
          const newIncoming = instr.incoming.map(([pred, value]) => {
            const replacement = copies.get(value);
            if (replacement) {
              changed = true;
              return [pred, replacement] as const;
            }
            return [pred, value] as const;
          });
          (instr as any).incoming = newIncoming;
        } else if (instr.type === "add" || instr.type === "mul") {
          const leftReplacement = copies.get(instr.left);
          const rightReplacement = copies.get(instr.right);
          if (leftReplacement) {
            (instr as any).left = leftReplacement;
            changed = true;
          }
          if (rightReplacement) {
            (instr as any).right = rightReplacement;
            changed = true;
          }
        } else if (instr.type === "mov" || instr.type === "store") {
          const srcReplacement = copies.get(instr.type === "mov" ? instr.src : instr.value);
          if (srcReplacement) {
            if (instr.type === "mov") {
              (instr as any).src = srcReplacement;
            } else {
              (instr as any).value = srcReplacement;
            }
            changed = true;
          }
        }
      }

      // Replace uses in terminator
      if (block.terminator.type === "branch") {
        const replacement = copies.get(block.terminator.cond);
        if (replacement) {
          (block.terminator as any).cond = replacement;
          changed = true;
        }
      } else if (block.terminator.type === "ret" && block.terminator.value) {
        const replacement = copies.get(block.terminator.value);
        if (replacement) {
          (block.terminator as any).value = replacement;
          changed = true;
        }
      }
    }

    return changed;
  },
});
