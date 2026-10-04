/**
 * SSA invariant verifier
 *
 * Checks that SSA form is well-formed:
 * - Each value defined exactly once
 * - Each use has a corresponding definition
 * - Phi nodes only at merge points
 * - Dominance property: definition dominates all uses
 * - No circular dependencies (except through phi nodes)
 *
 * Should be run after each SSA pass to catch bugs early.
 */

import type { SSAFunction, BasicBlock, Instruction, Terminator, ValueId, BlockId } from "./ir.ts";
import type { DomTree } from "./analysis/domtree.ts";
import { buildDomTree, dominates } from "./analysis/domtree.ts";

export class SSAVerifyError extends Error {
  public readonly details: { errors: string[] } | undefined;

  constructor(message: string, details?: { errors: string[] }) {
    super(message);
    this.details = details;
  }
}

/**
 * Verification result
 */
export interface VerifyResult {
  valid: boolean;
  errors: string[];
}

/**
 * Verify SSA form for a function.
 * Throws SSAVerifyError if invalid.
 */
export function verifySSA(func: SSAFunction): void {
  const errors: string[] = [];

  try {
    // Build dominator tree for dominance checks
    const domTree = buildDomTree(func);

    // Check 1: All blocks reachable from entry
    checkReachability(func, errors);

    // Check 2: Each value defined exactly once
    checkUniqueDefs(func, errors);

    // Check 3: Each use has a definition
    checkUsesHaveDefs(func, errors);

    // Check 4: Definitions dominate uses
    checkDominance(func, domTree, errors);

    // Check 5: Phi nodes only at merge points
    checkPhiPlacement(func, errors);

    // Check 6: Block structure is valid
    checkBlockStructure(func, errors);

    // Check 7: Control flow is well-formed
    checkControlFlow(func, errors);
  } catch (e) {
    errors.push(`Internal verifier error: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (errors.length > 0) {
    throw new SSAVerifyError(
      `SSA verification failed for function ${func.id}:\n${errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n")}`,
      { errors },
    );
  }
}

/**
 * Verify SSA form, returning result without throwing.
 */
export function verifySSASafe(func: SSAFunction): VerifyResult {
  try {
    verifySSA(func);
    return { valid: true, errors: [] };
  } catch (e) {
    if (e instanceof SSAVerifyError) {
      return { valid: false, errors: e.details ? e.details.errors : [e.message] };
    }
    return { valid: false, errors: [String(e)] };
  }
}

/**
 * Check that all blocks are reachable from entry.
 */
function checkReachability(func: SSAFunction, errors: string[]): void {
  const reachable = new Set<BlockId>();
  const queue = [func.entry];

  while (queue.length > 0) {
    const blockId = queue.shift()!;
    if (reachable.has(blockId)) continue;
    reachable.add(blockId);

    const block = func.blocks.get(blockId);
    if (!block) continue;

    queue.push(...block.successors);
  }

  for (const blockId of func.blocks.keys()) {
    if (!reachable.has(blockId)) {
      errors.push(`Block ${blockId} is unreachable from entry`);
    }
  }
}

/**
 * Check that each value is defined exactly once.
 */
function checkUniqueDefs(func: SSAFunction, errors: string[]): void {
  const defs = new Map<ValueId, { block: BlockId; inst: number }>();

  for (const [blockId, block] of func.blocks) {
    for (let i = 0; i < block.instructions.length; i++) {
      const inst = block.instructions[i]!;

      if (!hasDefinition(inst)) continue;

      const prev = defs.get(inst.id);
      if (prev) {
        errors.push(
          `Value ${inst.id} defined multiple times: ` + `${prev.block}:${prev.inst} and ${blockId}:${i}`,
        );
      } else {
        defs.set(inst.id, { block: blockId, inst: i });
      }
    }
  }
}

/**
 * Check that every use has a corresponding definition.
 */
function checkUsesHaveDefs(func: SSAFunction, errors: string[]): void {
  const defs = new Set<ValueId>();

  // Collect all definitions
  for (const param of func.params) {
    defs.add(param.id);
  }

  for (const block of func.blocks.values()) {
    for (const inst of block.instructions) {
      if (hasDefinition(inst)) {
        defs.add(inst.id);
      }
    }
  }

  // Check all uses
  for (const [blockId, block] of func.blocks) {
    for (let i = 0; i < block.instructions.length; i++) {
      const inst = block.instructions[i]!;
      const uses = getInstructionUses(inst);

      for (const use of uses) {
        if (!defs.has(use)) {
          errors.push(`Use of undefined value ${use} in ${blockId}:${i} (${inst.kind})`);
        }
      }
    }

    // Check terminator uses
    const termUses = getTerminatorUses(block.terminator);
    for (const use of termUses) {
      if (!defs.has(use)) {
        errors.push(`Use of undefined value ${use} in ${blockId} terminator`);
      }
    }
  }
}

/**
 * Check that definitions dominate all uses (except phi back-edges).
 */
function checkDominance(func: SSAFunction, domTree: DomTree, errors: string[]): void {
  const defBlock = new Map<ValueId, BlockId>();

  // Map values to their defining blocks
  for (const [blockId, block] of func.blocks) {
    for (const inst of block.instructions) {
      if (hasDefinition(inst)) {
        defBlock.set(inst.id, blockId);
      }
    }
  }

  // Check each use
  for (const [blockId, block] of func.blocks) {
    for (const inst of block.instructions) {
      const uses = getInstructionUses(inst);

      for (const use of uses) {
        const defBlk = defBlock.get(use);
        if (!defBlk) continue; // Already caught by checkUsesHaveDefs

        // Special case: phi nodes can use values from predecessors
        if (inst.kind === "phi") {
          const phi = inst as Extract<Instruction, { kind: "phi" }>;

          for (const incoming of phi.incoming) {
            if (incoming.value === use) {
              // Check that definition dominates the predecessor block's end
              if (!dominates(domTree, defBlk, incoming.block)) {
                errors.push(
                  `Definition of ${use} in ${defBlk} does not dominate ` +
                    `phi use in ${blockId} from predecessor ${incoming.block}`,
                );
              }
            }
          }
        } else {
          // Normal instruction: definition must dominate this block
          if (!dominates(domTree, defBlk, blockId)) {
            errors.push(
              `Definition of ${use} in ${defBlk} does not dominate use in ${blockId} (${inst.kind})`,
            );
          }
        }
      }
    }

    // Check terminator
    const termUses = getTerminatorUses(block.terminator);
    for (const use of termUses) {
      const defBlk = defBlock.get(use);
      if (defBlk && !dominates(domTree, defBlk, blockId)) {
        errors.push(`Definition of ${use} in ${defBlk} does not dominate use in ${blockId} terminator`);
      }
    }
  }
}

/**
 * Check that phi nodes only appear at merge points.
 */
function checkPhiPlacement(func: SSAFunction, errors: string[]): void {
  for (const [blockId, block] of func.blocks) {
    let seenNonPhi = false;

    for (const inst of block.instructions) {
      if (inst.kind === "phi") {
        if (seenNonPhi) {
          errors.push(`Phi node appears after non-phi instruction in ${blockId}`);
        }

        // Phi should only be in blocks with multiple predecessors
        if (block.predecessors.length < 2) {
          errors.push(`Phi node in ${blockId} but block has ${block.predecessors.length} predecessor(s)`);
        }

        // Check phi incoming blocks match predecessors
        const phi = inst as Extract<Instruction, { kind: "phi" }>;
        const incomingBlocks = new Set(phi.incoming.map((inc) => inc.block));
        const preds = new Set(block.predecessors);

        if (incomingBlocks.size !== preds.size) {
          errors.push(
            `Phi node in ${blockId} has ${incomingBlocks.size} incoming but ${preds.size} predecessors`,
          );
        }

        for (const inc of phi.incoming) {
          if (!preds.has(inc.block)) {
            errors.push(`Phi node in ${blockId} has incoming from ${inc.block} which is not a predecessor`);
          }
        }
      } else {
        seenNonPhi = true;
      }
    }
  }
}

/**
 * Check basic block structure.
 */
function checkBlockStructure(func: SSAFunction, errors: string[]): void {
  // Check entry block exists
  if (!func.blocks.has(func.entry)) {
    errors.push(`Entry block ${func.entry} does not exist`);
  }

  for (const [blockId, block] of func.blocks) {
    // Check block has terminator
    if (!block.terminator) {
      errors.push(`Block ${blockId} has no terminator`);
      continue;
    }

    // Check successors/predecessors are consistent
    for (const succ of block.successors) {
      const succBlock = func.blocks.get(succ);
      if (!succBlock) {
        errors.push(`Block ${blockId} has non-existent successor ${succ}`);
      } else if (!succBlock.predecessors.includes(blockId)) {
        errors.push(
          `Block ${blockId} lists ${succ} as successor but ${succ} doesn't list ${blockId} as predecessor`,
        );
      }
    }

    for (const pred of block.predecessors) {
      const predBlock = func.blocks.get(pred);
      if (!predBlock) {
        errors.push(`Block ${blockId} has non-existent predecessor ${pred}`);
      } else if (!predBlock.successors.includes(blockId)) {
        errors.push(
          `Block ${blockId} lists ${pred} as predecessor but ${pred} doesn't list ${blockId} as successor`,
        );
      }
    }
  }
}

/**
 * Check control flow is well-formed.
 */
function checkControlFlow(func: SSAFunction, errors: string[]): void {
  for (const [blockId, block] of func.blocks) {
    const term = block.terminator;

    switch (term.kind) {
      case "jmp":
        if (block.successors.length !== 1) {
          errors.push(`Block ${blockId} has jmp but ${block.successors.length} successors`);
        }
        if (block.successors[0] !== term.target) {
          errors.push(`Block ${blockId} jmp target mismatch: ${term.target} vs ${block.successors[0]}`);
        }
        break;

      case "br":
        if (block.successors.length !== 2) {
          errors.push(`Block ${blockId} has br but ${block.successors.length} successors`);
        }
        if (!block.successors.includes(term.then)) {
          errors.push(`Block ${blockId} br then-target ${term.then} not in successors`);
        }
        if (!block.successors.includes(term.else)) {
          errors.push(`Block ${blockId} br else-target ${term.else} not in successors`);
        }
        break;

      case "ret":
      case "unreachable":
        if (block.successors.length !== 0) {
          errors.push(`Block ${blockId} has ${term.kind} but ${block.successors.length} successors`);
        }
        break;
    }
  }
}

// Helper functions

function hasDefinition(inst: Instruction): inst is Instruction & { id: ValueId } {
  return "id" in inst && typeof inst.id === "string";
}

function getInstructionUses(inst: Instruction): ValueId[] {
  switch (inst.kind) {
    case "const":
      return [];
    case "binop":
      return [inst.left, inst.right];
    case "unop":
      return [inst.operand];
    case "call":
      return inst.args;
    case "phi":
      return inst.incoming.map((inc) => inc.value);
    case "load":
      return [inst.addr];
    case "store":
      return [inst.addr, inst.value];
    case "alloca":
      return [];
    default:
      return [];
  }
}

function getTerminatorUses(term: Terminator): ValueId[] {
  switch (term.kind) {
    case "jmp":
    case "unreachable":
      return [];
    case "br":
      return [term.cond];
    case "ret":
      return term.value ? [term.value] : [];
    default:
      return [];
  }
}
