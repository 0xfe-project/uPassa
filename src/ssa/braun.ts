/**
 * Braun et al.'s SSA construction algorithm (generic)
 *
 * Reference: "Simple and Efficient Construction of Static Single Assignment Form"
 * https://pp.info.uni-karlsruhe.de/uploads/publikationen/braun13cc.pdf
 *
 * This algorithm places phi nodes lazily during variable renaming, without
 * computing dominance frontiers upfront.
 *
 * Generic over T: user-provided instruction and terminator types flow through.
 * The framework only inserts phi nodes (minimal IR); user instructions pass through.
 */

import type { SSAFunction, BasicBlock, Instruction, Terminator, ValueId, BlockId, PhiNode } from "./ir.ts";

export class BraunError extends Error {}

/**
 * Input to Braun: pre-SSA CFG with variable names.
 * Generic over T: user's instruction/terminator types.
 */
export interface PreSSABlock<T> {
  id: BlockId;
  // Variable assignments in this block: name -> value expression
  assignments: Map<string, PreSSAValue<T>>;
  terminator: PreSSATerminator<T>;
  predecessors: BlockId[];
}

/**
 * Pre-SSA value: either a variable reference or a user-defined expression.
 * Variable references will be renamed to SSA values by Braun.
 * User expressions (T) flow through unchanged.
 */
export type PreSSAValue<T> = { kind: "var"; name: string } | { kind: "expr"; value: T };

/**
 * Pre-SSA terminator: variable names not yet renamed.
 * Generic over T: user can provide custom terminator types.
 */
export type PreSSATerminator<T> =
  | { kind: "jump"; target: BlockId }
  | { kind: "branch"; cond: string; ifTrue: BlockId; ifFalse: BlockId }
  | { kind: "ret"; value?: string }
  | { kind: "user"; term: T };

export interface PreSSAFunction<T> {
  id: string;
  blocks: Map<BlockId, PreSSABlock<T>>;
  entry: BlockId;
}

/**
 * Braun algorithm state
 */
class BraunBuilder<T> {
  private readonly preFunc: PreSSAFunction<T>;
  private readonly blocks: Map<BlockId, BasicBlock<T>> = new Map();

  // Block-local definitions: block -> variable -> SSA value ID
  private readonly blockDefs = new Map<BlockId, Map<string, ValueId>>();

  // Incomplete phi nodes: block -> variable -> phi instruction index
  private readonly incompletePhis = new Map<BlockId, Map<string, number>>();

  // Sealed blocks (all predecessors known)
  private readonly sealed = new Set<BlockId>();

  // Value ID counter
  private valueCounter = 0;

  constructor(preFunc: PreSSAFunction<T>) {
    this.preFunc = preFunc;

    // Initialize SSA blocks
    for (const [id, preBlock] of preFunc.blocks) {
      const successors = this.getSuccessors(preBlock.terminator);
      this.blocks.set(id, {
        id,
        instructions: [],
        terminator: { type: "unreachable" } as Terminator<T>,
        predecessors: preBlock.predecessors,
        successors,
      });
      this.blockDefs.set(id, new Map());
    }
  }

  private freshValue(): ValueId {
    return `%${this.valueCounter++}`;
  }

  private getSuccessors(term: PreSSATerminator<T>): BlockId[] {
    switch (term.kind) {
      case "jump":
        return [term.target];
      case "branch":
        return [term.ifTrue, term.ifFalse];
      case "ret":
      case "user":
        return [];
    }
  }

  /**
   * Read variable at current position (core of Braun algorithm).
   */
  private readVariable(variable: string, block: BlockId): ValueId {
    const localDef = this.blockDefs.get(block)?.get(variable);
    if (localDef !== undefined) {
      return localDef;
    }
    return this.readVariableRecursive(variable, block);
  }

  private readVariableRecursive(variable: string, block: BlockId): ValueId {
    const ssaBlock = this.blocks.get(block);
    if (!ssaBlock) {
      throw new BraunError(`Block ${block} not found`);
    }

    const val: ValueId = !this.sealed.has(block)
      ? this.addIncompletePhi(variable, block)
      : ssaBlock.predecessors.length === 1
        ? this.readVariable(variable, ssaBlock.predecessors[0]!)
        : this.addPhi(variable, block);

    this.writeVariable(variable, block, val);
    return val;
  }

  private writeVariable(variable: string, block: BlockId, value: ValueId): void {
    let defs = this.blockDefs.get(block);
    if (!defs) {
      defs = new Map();
      this.blockDefs.set(block, defs);
    }
    defs.set(variable, value);
  }

  private addPhi(variable: string, block: BlockId): ValueId {
    const ssaBlock = this.blocks.get(block);
    if (!ssaBlock) {
      throw new BraunError(`Block ${block} not found`);
    }

    const phiId = this.freshValue();
    const incoming: Array<readonly [BlockId, ValueId]> = [];

    for (const pred of ssaBlock.predecessors) {
      const value = this.readVariable(variable, pred);
      incoming.push([pred, value] as const);
    }

    const phi: Instruction = {
      type: "phi",
      dest: phiId,
      incoming,
    };

    ssaBlock.instructions.unshift(phi);
    return phiId;
  }

  private addIncompletePhi(variable: string, block: BlockId): ValueId {
    const phiId = this.freshValue();
    const phi: Instruction<T> = {
      type: "phi",
      dest: phiId,
      incoming: [],
    };

    const ssaBlock = this.blocks.get(block);
    if (!ssaBlock) {
      throw new BraunError(`Block ${block} not found`);
    }

    const phiIndex = ssaBlock.instructions.length;
    ssaBlock.instructions.push(phi);

    let blockPhis = this.incompletePhis.get(block);
    if (!blockPhis) {
      blockPhis = new Map();
      this.incompletePhis.set(block, blockPhis);
    }
    blockPhis.set(variable, phiIndex);

    return phiId;
  }

  private sealBlock(block: BlockId): void {
    const blockPhis = this.incompletePhis.get(block);
    if (blockPhis) {
      for (const [variable, phiIndex] of blockPhis) {
        this.fillIncompletePhi(variable, block, phiIndex);
      }
      this.incompletePhis.delete(block);
    }
    this.sealed.add(block);
  }

  private fillIncompletePhi(variable: string, block: BlockId, phiIndex: number): void {
    const ssaBlock = this.blocks.get(block);
    if (!ssaBlock) return;

    const phi = ssaBlock.instructions[phiIndex];
    if (!phi || !isPhi(phi)) return;

    const incoming: Array<readonly [BlockId, ValueId]> = [];
    for (const pred of ssaBlock.predecessors) {
      const value = this.readVariable(variable, pred);
      incoming.push([pred, value] as const);
    }

    // Update phi (cast to mutable to fill)
    (phi as any).incoming = incoming;
  }

  private processBlock(blockId: BlockId): void {
    const preBlock = this.preFunc.blocks.get(blockId);
    const ssaBlock = this.blocks.get(blockId);
    if (!preBlock || !ssaBlock) {
      throw new BraunError(`Block ${blockId} not found`);
    }

    // Process assignments
    for (const [varName, value] of preBlock.assignments) {
      const ssaValue = this.convertValue(value, blockId);
      this.writeVariable(varName, blockId, ssaValue);
    }

    // Convert terminator
    ssaBlock.terminator = this.convertTerminator(preBlock.terminator, blockId);
  }

  private convertValue(value: PreSSAValue<T>, blockId: BlockId): ValueId {
    if (value.kind === "var") {
      return this.readVariable(value.name, blockId);
    } else {
      // User expression: allocate a fresh value ID
      // User is responsible for adding the actual instruction to the block
      // (or we could provide a hook here)
      return this.freshValue();
    }
  }

  private convertTerminator(term: PreSSATerminator<T>, blockId: BlockId): Terminator<T> {
    switch (term.kind) {
      case "jump":
        return { type: "jump", target: term.target };
      case "branch": {
        const cond = this.readVariable(term.cond, blockId);
        return { type: "branch", cond, ifTrue: term.ifTrue, ifFalse: term.ifFalse };
      }
      case "ret": {
        if (term.value === undefined) {
          return { type: "ret" };
        }
        const value = this.readVariable(term.value, blockId);
        return { type: "ret", value };
      }
      case "user":
        return term.term as Terminator<T>;
    }
  }

  build(): SSAFunction<T> {
    // Process blocks in entry-first order (simplified; proper impl would use dominator tree order)
    const visited = new Set<BlockId>();
    const queue = [this.preFunc.entry];

    while (queue.length > 0) {
      const blockId = queue.shift()!;
      if (visited.has(blockId)) continue;
      visited.add(blockId);

      this.processBlock(blockId);
      this.sealBlock(blockId);

      const block = this.blocks.get(blockId);
      if (block) {
        queue.push(...block.successors);
      }
    }

    return {
      id: this.preFunc.id,
      blocks: this.blocks,
      entry: this.preFunc.entry,
    };
  }
}

// Type guard for phi nodes
function isPhi<T>(inst: Instruction<T>): inst is PhiNode {
  return (inst as any).type === "phi";
}

/**
 * Convert pre-SSA function to SSA form using Braun algorithm.
 * Generic over T: user instruction/terminator types.
 */
export function toSSA<T>(func: PreSSAFunction<T>): SSAFunction<T> {
  const builder = new BraunBuilder(func);
  return builder.build();
}
