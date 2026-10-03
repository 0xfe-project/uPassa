/**
 * Braun et al.'s SSA construction algorithm
 *
 * Reference: "Simple and Efficient Construction of Static Single Assignment Form"
 * https://pp.info.uni-karlsruhe.de/uploads/publikationen/braun13cc.pdf
 *
 * This is a simple, on-the-fly SSA construction algorithm that doesn't require
 * computing dominance frontiers upfront. Instead, it places phi nodes lazily
 * during variable renaming.
 *
 * Input convention (what user must provide):
 * - Basic blocks with explicit control flow (labels + jumps)
 * - Flattened scopes (all variables are names, no nested let/lambda)
 * - Assignments are statements (not expressions)
 *
 * Output: SSA IR with phi nodes inserted at merge points.
 */

import type {
  SSAFunction,
  SSAModule,
  BasicBlock,
  Instruction,
  Terminator,
  ValueId,
  BlockId,
  ValueType,
} from "./ir.ts";

export class BraunError extends Error {}

/**
 * Input to Braun algorithm: CFG in tree form (before SSA)
 */
export interface PreSSABlock {
  id: BlockId;
  // Variables assigned in this block (name -> value expression)
  assignments: Map<string, PreSSAValue>;
  terminator: PreSSATerminator;
  predecessors: BlockId[];
}

export type PreSSAValue =
  | { kind: "const"; value: number | boolean; type: ValueType }
  | { kind: "var"; name: string }
  | { kind: "binop"; op: string; left: string; right: string; type: ValueType }
  | { kind: "unop"; op: string; operand: string; type: ValueType }
  | { kind: "call"; func: string; args: string[]; type: ValueType };

export type PreSSATerminator =
  | { kind: "jmp"; target: BlockId }
  | { kind: "br"; cond: string; then: BlockId; else: BlockId }
  | { kind: "ret"; value?: string };

export interface PreSSAFunction {
  id: string;
  params: Array<{ name: string; type: ValueType }>;
  returnType: ValueType;
  blocks: Map<BlockId, PreSSABlock>;
  entry: BlockId;
}

/**
 * Braun algorithm state for one function
 */
class BraunBuilder {
  private readonly func: PreSSAFunction;
  private readonly blocks: Map<BlockId, BasicBlock> = new Map();

  // Current definitions: variable name -> SSA value ID
  private readonly currentDef = new Map<string, ValueId>();

  // Incomplete phi nodes (block -> variable -> phi instruction)
  // Used when block not sealed yet (don't know all predecessors)
  private readonly incompletePhis = new Map<BlockId, Map<string, Instruction>>();

  // Sealed blocks (all predecessors known)
  private readonly sealed = new Set<BlockId>();

  // Value ID counter
  private valueCounter = 0;

  // Block definitions: block -> variable -> value ID
  private readonly blockDefs = new Map<BlockId, Map<string, ValueId>>();

  constructor(func: PreSSAFunction) {
    this.func = func;

    // Initialize blocks
    for (const [id, preBlock] of func.blocks) {
      this.blocks.set(id, {
        id,
        instructions: [],
        terminator: { kind: "unreachable" }, // Will be filled
        predecessors: preBlock.predecessors,
        successors: this.getSuccessors(preBlock.terminator),
      });
      this.blockDefs.set(id, new Map());
    }
  }

  private freshValue(): ValueId {
    return `v${this.valueCounter++}`;
  }

  private getSuccessors(term: PreSSATerminator): BlockId[] {
    switch (term.kind) {
      case "jmp":
        return [term.target];
      case "br":
        return [term.then, term.else];
      case "ret":
        return [];
    }
  }

  /**
   * Read variable at current position.
   * This is the core of Braun algorithm.
   */
  private readVariable(variable: string, block: BlockId): ValueId {
    // Local value (defined in current block)
    const localDef = this.blockDefs.get(block)?.get(variable);
    if (localDef !== undefined) {
      return localDef;
    }

    // Global value (need to look at predecessors)
    return this.readVariableRecursive(variable, block);
  }

  private readVariableRecursive(variable: string, block: BlockId): ValueId {
    const ssaBlock = this.blocks.get(block);
    if (!ssaBlock) {
      throw new BraunError(`Block ${block} not found`);
    }

    const val: ValueId = !this.sealed.has(block)
      ? // Block not sealed yet: create incomplete phi
        this.addIncompletePhi(variable, block)
      : ssaBlock.predecessors.length === 1
        ? // Only one predecessor: no phi needed
          this.readVariable(variable, ssaBlock.predecessors[0]!)
        : // Multiple predecessors: need phi
          this.addPhi(variable, block);

    this.writeVariable(variable, block, val);
    return val;
  }

  /**
   * Write variable definition in a block.
   */
  private writeVariable(variable: string, block: BlockId, value: ValueId): void {
    let defs = this.blockDefs.get(block);
    if (!defs) {
      defs = new Map();
      this.blockDefs.set(block, defs);
    }
    defs.set(variable, value);
  }

  /**
   * Add phi node to block.
   */
  private addPhi(variable: string, block: BlockId): ValueId {
    const ssaBlock = this.blocks.get(block);
    if (!ssaBlock) {
      throw new BraunError(`Block ${block} not found`);
    }

    const phiId = this.freshValue();
    const incoming: Array<{ block: BlockId; value: ValueId }> = [];

    for (const pred of ssaBlock.predecessors) {
      const value = this.readVariable(variable, pred);
      incoming.push({ block: pred, value });
    }

    const phi: Instruction = {
      kind: "phi",
      id: phiId,
      type: "int", // TODO: proper type tracking
      incoming,
    };

    // Phi nodes go at the beginning of the block
    ssaBlock.instructions.unshift(phi);

    return phiId;
  }

  /**
   * Add incomplete phi (placeholder when block not sealed).
   */
  private addIncompletePhi(variable: string, block: BlockId): ValueId {
    const phiId = this.freshValue();
    const phi: Instruction = {
      kind: "phi",
      id: phiId,
      type: "int", // TODO: proper type tracking
      incoming: [],
    };

    const ssaBlock = this.blocks.get(block);
    if (ssaBlock) {
      ssaBlock.instructions.unshift(phi);
    }

    // Record as incomplete
    let blockPhis = this.incompletePhis.get(block);
    if (!blockPhis) {
      blockPhis = new Map();
      this.incompletePhis.set(block, blockPhis);
    }
    blockPhis.set(variable, phi);

    return phiId;
  }

  /**
   * Seal a block (all predecessors processed).
   */
  private sealBlock(block: BlockId): void {
    const blockPhis = this.incompletePhis.get(block);
    if (blockPhis) {
      for (const [variable, phi] of blockPhis) {
        this.fillIncompletePhi(phi, variable, block);
      }
      this.incompletePhis.delete(block);
    }
    this.sealed.add(block);
  }

  /**
   * Fill in an incomplete phi node now that block is sealed.
   */
  private fillIncompletePhi(phi: Instruction, variable: string, block: BlockId): void {
    if (phi.kind !== "phi") return;

    const ssaBlock = this.blocks.get(block);
    if (!ssaBlock) return;

    for (const pred of ssaBlock.predecessors) {
      const value = this.readVariable(variable, pred);
      phi.incoming.push({ block: pred, value });
    }
  }

  /**
   * Process a block: convert assignments to SSA form.
   */
  private processBlock(blockId: BlockId): void {
    const preBlock = this.func.blocks.get(blockId);
    const ssaBlock = this.blocks.get(blockId);
    if (!preBlock || !ssaBlock) {
      throw new BraunError(`Block ${blockId} not found`);
    }

    // Process assignments
    for (const [varName, value] of preBlock.assignments) {
      const ssaValue = this.convertValue(value);
      this.writeVariable(varName, blockId, ssaValue);
    }

    // Convert terminator
    ssaBlock.terminator = this.convertTerminator(preBlock.terminator);
  }

  /**
   * Convert pre-SSA value to SSA instruction.
   */
  private convertValue(value: PreSSAValue): ValueId {
    const id = this.freshValue();
    // TODO: Add instruction to current block
    return id;
  }

  /**
   * Convert pre-SSA terminator to SSA terminator.
   */
  private convertTerminator(term: PreSSATerminator): Terminator {
    switch (term.kind) {
      case "jmp":
        return { kind: "jmp", target: term.target };
      case "br": {
        const cond = this.currentDef.get(term.cond);
        if (!cond) {
          throw new BraunError(`Undefined variable in branch: ${term.cond}`);
        }
        return { kind: "br", cond, then: term.then, else: term.else };
      }
      case "ret": {
        if (!term.value) {
          return { kind: "ret" };
        }
        const value = this.currentDef.get(term.value);
        if (!value) {
          throw new BraunError(`Undefined variable in return: ${term.value}`);
        }
        return { kind: "ret", value };
      }
    }
  }

  /**
   * Build SSA form using Braun algorithm.
   */
  build(): SSAFunction {
    // Initialize parameters
    for (const param of this.func.params) {
      const paramId = this.freshValue();
      this.writeVariable(param.name, this.func.entry, paramId);
    }

    // Process blocks in dominator tree order (simplified: just use entry-first order)
    const visited = new Set<BlockId>();
    const queue = [this.func.entry];

    while (queue.length > 0) {
      const blockId = queue.shift()!;
      if (visited.has(blockId)) continue;
      visited.add(blockId);

      this.processBlock(blockId);
      this.sealBlock(blockId);

      // Add successors
      const block = this.blocks.get(blockId);
      if (block) {
        queue.push(...block.successors);
      }
    }

    return {
      id: this.func.id,
      params: this.func.params.map((p, i) => ({ id: `v${i}`, type: p.type })),
      returnType: this.func.returnType,
      blocks: this.blocks,
      entry: this.func.entry,
    };
  }
}

/**
 * Convert pre-SSA function to SSA form using Braun algorithm.
 */
export function toSSA(func: PreSSAFunction): SSAFunction {
  const builder = new BraunBuilder(func);
  return builder.build();
}

/**
 * Convert pre-SSA module to SSA form.
 */
export function moduleToSSA(functions: Map<string, PreSSAFunction>, entry: string): SSAModule {
  const ssaFunctions = new Map<string, SSAFunction>();

  for (const [id, func] of functions) {
    ssaFunctions.set(id, toSSA(func));
  }

  return {
    functions: ssaFunctions,
    entry,
  };
}
