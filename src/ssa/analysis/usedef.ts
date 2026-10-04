/**
 * Use-Def chain analysis (generic)
 *
 * Tracks which instructions use/define each SSA value.
 * Generic over T: only analyzes minimal IR nodes; user nodes are opaque.
 */

import type {
  SSAFunction,
  BasicBlock,
  Instruction,
  Terminator,
  ValueId,
  BlockId,
  PhiNode,
  BranchNode,
  RetNode,
} from "../ir.ts";

/**
 * Use site: instruction/terminator that uses a value
 */
export interface UseSite {
  block: BlockId;
  instruction?: number; // index in block.instructions, undefined = terminator
}

/**
 * Def site: instruction that defines a value
 */
export interface DefSite {
  block: BlockId;
  instruction: number; // index in block.instructions
}

/**
 * Use-Def chains for a function
 */
export class UseDefChains<T = never> {
  // Value -> all use sites
  private readonly uses = new Map<ValueId, UseSite[]>();

  // Value -> def site
  private readonly defs = new Map<ValueId, DefSite>();

  constructor(func: SSAFunction<T>) {
    this.build(func);
  }

  private build(func: SSAFunction<T>): void {
    for (const block of func.blocks.values()) {
      this.analyzeBlock(block);
    }
  }

  private analyzeBlock(block: BasicBlock<T>): void {
    // Analyze instructions
    for (let i = 0; i < block.instructions.length; i++) {
      const inst = block.instructions[i]!;
      this.analyzeInstruction(inst, block.id, i);
    }

    // Analyze terminator
    this.analyzeTerminator(block.terminator, block.id);
  }

  private analyzeInstruction(inst: Instruction<T>, blockId: BlockId, index: number): void {
    // Type guard: check if instruction is PhiNode
    if (isPhi(inst)) {
      // Phi defines dest
      this.addDef(inst.dest, blockId, index);

      // Phi uses incoming values
      for (const [_predBlock, value] of inst.incoming) {
        this.addUse(value, blockId, index);
      }
    }
    // User instructions (T): opaque, don't analyze
  }

  private analyzeTerminator(term: Terminator<T>, blockId: BlockId): void {
    // Type guards for minimal IR terminators
    if (isBranch(term)) {
      this.addUse(term.cond, blockId, undefined);
    } else if (isRet(term)) {
      if (term.value !== undefined) {
        this.addUse(term.value, blockId, undefined);
      }
    }
    // jump, unreachable: no uses
    // User terminators (T): opaque
  }

  private addDef(value: ValueId, block: BlockId, instruction: number): void {
    this.defs.set(value, { block, instruction });
  }

  private addUse(value: ValueId, block: BlockId, instruction?: number): void {
    let useSites = this.uses.get(value);
    if (!useSites) {
      useSites = [];
      this.uses.set(value, useSites);
    }
    const useSite: UseSite = { block };
    if (instruction !== undefined) {
      useSite.instruction = instruction;
    }
    useSites.push(useSite);
  }

  /**
   * Get all use sites of a value
   */
  getUses(value: ValueId): readonly UseSite[] {
    return this.uses.get(value) ?? [];
  }

  /**
   * Get def site of a value
   */
  getDef(value: ValueId): DefSite | undefined {
    return this.defs.get(value);
  }

  /**
   * Get all values defined in the function
   */
  getDefinedValues(): Set<ValueId> {
    return new Set(this.defs.keys());
  }

  /**
   * Check if a value is used
   */
  isUsed(value: ValueId): boolean {
    const useSites = this.uses.get(value);
    return useSites !== undefined && useSites.length > 0;
  }

  /**
   * Check if a value has a definition
   */
  isDefined(value: ValueId): boolean {
    return this.defs.has(value);
  }

  /**
   * Replace all uses of oldValue with newValue
   */
  replaceUses(func: SSAFunction<T>, oldValue: ValueId, newValue: ValueId): void {
    const useSites = this.uses.get(oldValue);
    if (!useSites) return;

    for (const site of useSites) {
      const block = func.blocks.get(site.block);
      if (!block) continue;

      if (site.instruction !== undefined) {
        const inst = block.instructions[site.instruction];
        if (!inst) continue;
        this.replaceUseInInstruction(inst, oldValue, newValue);
      } else {
        this.replaceUseInTerminator(block.terminator, oldValue, newValue);
      }
    }

    // Update use-def chains
    this.uses.set(newValue, [...(this.uses.get(newValue) ?? []), ...useSites]);
    this.uses.delete(oldValue);
  }

  private replaceUseInInstruction(inst: Instruction<T>, oldValue: ValueId, newValue: ValueId): void {
    if (isPhi(inst)) {
      // Cast to mutable to update
      const incoming = inst.incoming as Array<[BlockId, ValueId]>;
      for (let i = 0; i < incoming.length; i++) {
        if (incoming[i]![1] === oldValue) {
          incoming[i] = [incoming[i]![0], newValue];
        }
      }
    }
    // User instructions: opaque, can't rewrite
  }

  private replaceUseInTerminator(term: Terminator<T>, oldValue: ValueId, newValue: ValueId): void {
    if (isBranch(term) && term.cond === oldValue) {
      (term as any).cond = newValue;
    } else if (isRet(term) && term.value === oldValue) {
      (term as any).value = newValue;
    }
    // User terminators: opaque
  }
}

// Type guards for minimal IR nodes
function isPhi<T>(inst: Instruction<T>): inst is PhiNode {
  return (inst as any).type === "phi";
}

function isBranch<T>(term: Terminator<T>): term is BranchNode {
  return (term as any).type === "branch";
}

function isRet<T>(term: Terminator<T>): term is RetNode {
  return (term as any).type === "ret";
}

/**
 * Build use-def chains for a function
 */
export function buildUseDefChains<T>(func: SSAFunction<T>): UseDefChains<T> {
  return new UseDefChains(func);
}
