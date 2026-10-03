/**
 * Use-def chains (SSA def-use analysis)
 *
 * Tracks relationships between definitions and uses of SSA values.
 *
 * Use-def chain: for each use, find the unique definition (trivial in SSA)
 * Def-use chain: for each definition, find all uses
 *
 * Used for:
 * - Dead code elimination (unused definitions)
 * - Constant propagation (single-use values)
 * - Copy propagation
 * - Register allocation
 * - Program slicing
 */

import type { SSAFunction, BasicBlock, Instruction, Terminator, ValueId, BlockId } from "../ir.ts";

export class UseDefError extends Error {}

/**
 * Location of a use: instruction and operand index
 */
export interface UseLocation {
  block: BlockId;
  instruction: number; // Index in block.instructions (-1 for terminator)
  operand: number; // Which operand (for instructions with multiple operands)
}

/**
 * Definition site
 */
export interface DefLocation {
  block: BlockId;
  instruction: number; // Index in block.instructions
}

/**
 * Use-def chains: for each value, track its definition and all uses
 */
export interface UseDefChains {
  // Value -> definition site
  defs: Map<ValueId, DefLocation>;

  // Value -> all use sites
  uses: Map<ValueId, UseLocation[]>;

  // Reverse: instruction use -> value being used
  useToValue: Map<string, ValueId>; // Key: "block:inst:operand"
}

/**
 * Build use-def chains for a function.
 */
export function buildUseDefChains(func: SSAFunction): UseDefChains {
  const defs = new Map<ValueId, DefLocation>();
  const uses = new Map<ValueId, UseLocation[]>();
  const useToValue = new Map<string, ValueId>();

  // Collect definitions
  for (const [blockId, block] of func.blocks) {
    for (let i = 0; i < block.instructions.length; i++) {
      const inst = block.instructions[i]!;

      if (hasDefinition(inst)) {
        defs.set(inst.id, { block: blockId, instruction: i });
      }
    }
  }

  // Collect uses
  for (const [blockId, block] of func.blocks) {
    // Uses in instructions
    for (let i = 0; i < block.instructions.length; i++) {
      const inst = block.instructions[i]!;
      const operands = getOperands(inst);

      for (let opIndex = 0; opIndex < operands.length; opIndex++) {
        const value = operands[opIndex]!;
        const loc: UseLocation = { block: blockId, instruction: i, operand: opIndex };

        if (!uses.has(value)) {
          uses.set(value, []);
        }
        uses.get(value)!.push(loc);

        const key = `${blockId}:${i}:${opIndex}`;
        useToValue.set(key, value);
      }
    }

    // Uses in terminator
    const termOperands = getTerminatorOperands(block.terminator);
    for (let opIndex = 0; opIndex < termOperands.length; opIndex++) {
      const value = termOperands[opIndex]!;
      const loc: UseLocation = { block: blockId, instruction: -1, operand: opIndex };

      if (!uses.has(value)) {
        uses.set(value, []);
      }
      uses.get(value)!.push(loc);

      const key = `${blockId}:-1:${opIndex}`;
      useToValue.set(key, value);
    }
  }

  return { defs, uses, useToValue };
}

/**
 * Check if instruction defines a value.
 */
function hasDefinition(inst: Instruction): inst is Instruction & { id: ValueId } {
  return "id" in inst && typeof inst.id === "string";
}

/**
 * Get all values used by an instruction.
 */
function getOperands(inst: Instruction): ValueId[] {
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

/**
 * Get all values used by a terminator.
 */
function getTerminatorOperands(term: Terminator): ValueId[] {
  switch (term.kind) {
    case "jmp":
      return [];

    case "br":
      return [term.cond];

    case "ret":
      return term.value ? [term.value] : [];

    case "unreachable":
      return [];

    default:
      return [];
  }
}

/**
 * Check if a value is used.
 */
export function isUsed(chains: UseDefChains, value: ValueId): boolean {
  const uses = chains.uses.get(value);
  return uses !== undefined && uses.length > 0;
}

/**
 * Check if a value has exactly one use.
 */
export function hasSingleUse(chains: UseDefChains, value: ValueId): boolean {
  const uses = chains.uses.get(value);
  return uses !== undefined && uses.length === 1;
}

/**
 * Get the unique use of a value (if it has exactly one).
 */
export function getSingleUse(chains: UseDefChains, value: ValueId): UseLocation | null {
  const uses = chains.uses.get(value);
  if (uses && uses.length === 1) {
    return uses[0]!;
  }
  return null;
}

/**
 * Get all unused definitions (dead code candidates).
 */
export function getUnusedDefs(chains: UseDefChains): ValueId[] {
  const unused: ValueId[] = [];

  for (const [value] of chains.defs) {
    if (!isUsed(chains, value)) {
      unused.push(value);
    }
  }

  return unused;
}

/**
 * Replace all uses of oldValue with newValue.
 */
export function replaceUses(
  func: SSAFunction,
  chains: UseDefChains,
  oldValue: ValueId,
  newValue: ValueId,
): void {
  const uses = chains.uses.get(oldValue);
  if (!uses) return;

  for (const use of uses) {
    const block = func.blocks.get(use.block);
    if (!block) continue;

    if (use.instruction === -1) {
      // Terminator
      replaceInTerminator(block.terminator, use.operand, newValue);
    } else {
      // Instruction
      const inst = block.instructions[use.instruction];
      if (inst) {
        replaceInInstruction(inst, use.operand, newValue);
      }
    }
  }

  // Update chains
  chains.uses.set(newValue, [...(chains.uses.get(newValue) ?? []), ...uses]);
  chains.uses.delete(oldValue);
}

/**
 * Replace operand in instruction.
 */
function replaceInInstruction(inst: Instruction, operandIndex: number, newValue: ValueId): void {
  switch (inst.kind) {
    case "binop":
      if (operandIndex === 0) inst.left = newValue;
      else if (operandIndex === 1) inst.right = newValue;
      break;

    case "unop":
      if (operandIndex === 0) inst.operand = newValue;
      break;

    case "call":
      if (operandIndex < inst.args.length) {
        inst.args[operandIndex] = newValue;
      }
      break;

    case "phi":
      if (operandIndex < inst.incoming.length) {
        inst.incoming[operandIndex]!.value = newValue;
      }
      break;

    case "load":
      if (operandIndex === 0) inst.addr = newValue;
      break;

    case "store":
      if (operandIndex === 0) inst.addr = newValue;
      else if (operandIndex === 1) inst.value = newValue;
      break;
  }
}

/**
 * Replace operand in terminator.
 */
function replaceInTerminator(term: Terminator, operandIndex: number, newValue: ValueId): void {
  switch (term.kind) {
    case "br":
      if (operandIndex === 0) term.cond = newValue;
      break;

    case "ret":
      if (operandIndex === 0 && term.value) term.value = newValue;
      break;
  }
}

/**
 * Remove a definition and all its uses (for dead code elimination).
 */
export function removeDef(func: SSAFunction, chains: UseDefChains, value: ValueId): void {
  const defLoc = chains.defs.get(value);
  if (!defLoc) return;

  const block = func.blocks.get(defLoc.block);
  if (!block) return;

  // Remove instruction
  block.instructions.splice(defLoc.instruction, 1);

  // Update chains
  chains.defs.delete(value);
  chains.uses.delete(value);

  // Adjust instruction indices for remaining defs/uses in this block
  for (const [v, loc] of chains.defs) {
    if (loc.block === defLoc.block && loc.instruction > defLoc.instruction) {
      loc.instruction--;
    }
  }

  for (const uses of chains.uses.values()) {
    for (const use of uses) {
      if (use.block === defLoc.block && use.instruction > defLoc.instruction) {
        use.instruction--;
      }
    }
  }
}
