/**
 * SSA codegen: generate graph walkers and transformers
 *
 * Unlike nanopass (tree → tree with fusion), SSA codegen generates:
 * - Graph visitors (for analysis passes)
 * - In-place transformers (for optimization passes)
 * - Block iterators (CFG traversal: DFS, RPO, etc.)
 *
 * Key differences from tree codegen:
 * - No automatic fusion (graphs have cycles and shared nodes)
 * - No immutable reconstruction (SSA IR is mutable)
 * - Visitor pattern instead of structural recursion
 *
 * Generated code supports common patterns:
 * - visitBlock: process each block
 * - visitInstruction: process each instruction
 * - walkCFG: traverse in specified order
 * - replaceInstruction: transform in-place
 */

import type { SSAFunction, BasicBlock, Instruction, BlockId, ValueType } from "./ir.ts";

/**
 * CFG traversal orders
 */
export type TraversalOrder =
  | "entry-first" // Entry block first, then successors (BFS-like)
  | "dfs" // Depth-first search
  | "rpo" // Reverse postorder (common for forward dataflow)
  | "po" // Postorder (common for backward dataflow)
  | "dominator-tree"; // Follow dominator tree structure

/**
 * Block visitor: called for each block during traversal
 */
export interface BlockVisitor {
  (block: BasicBlock, func: SSAFunction): void | boolean; // return false to skip
}

/**
 * Instruction visitor: called for each instruction
 */
export interface InstructionVisitor {
  (inst: Instruction, block: BasicBlock, func: SSAFunction): void | "remove" | "skip-rest";
}

/**
 * Walk CFG in specified order, calling visitor for each block.
 */
export function walkCFG(func: SSAFunction, order: TraversalOrder, visitor: BlockVisitor): void {
  const visited = new Set<BlockId>();

  switch (order) {
    case "entry-first":
      walkEntryFirst(func, visitor, visited);
      break;
    case "dfs":
      walkDFS(func, func.entry, visitor, visited);
      break;
    case "rpo":
      walkRPO(func, visitor);
      break;
    case "po":
      walkPO(func, visitor);
      break;
    case "dominator-tree":
      // Requires dominator tree, delegate to analysis module
      throw new Error("dominator-tree order requires explicit dominator tree");
  }
}

/**
 * Walk blocks in entry-first order (BFS-like).
 */
function walkEntryFirst(func: SSAFunction, visitor: BlockVisitor, visited: Set<BlockId>): void {
  const queue = [func.entry];

  while (queue.length > 0) {
    const blockId = queue.shift()!;
    if (visited.has(blockId)) continue;
    visited.add(blockId);

    const block = func.blocks.get(blockId);
    if (!block) continue;

    const result = visitor(block, func);
    if (result === false) continue;

    queue.push(...block.successors);
  }
}

/**
 * Walk blocks in DFS order.
 */
function walkDFS(func: SSAFunction, blockId: BlockId, visitor: BlockVisitor, visited: Set<BlockId>): void {
  if (visited.has(blockId)) return;
  visited.add(blockId);

  const block = func.blocks.get(blockId);
  if (!block) return;

  const result = visitor(block, func);
  if (result === false) return;

  for (const succ of block.successors) {
    walkDFS(func, succ, visitor, visited);
  }
}

/**
 * Walk blocks in reverse postorder (RPO).
 * RPO is a common order for forward dataflow analysis.
 */
function walkRPO(func: SSAFunction, visitor: BlockVisitor): void {
  const postorder = computePostorder(func);
  postorder.reverse();

  for (const blockId of postorder) {
    const block = func.blocks.get(blockId);
    if (!block) continue;
    visitor(block, func);
  }
}

/**
 * Walk blocks in postorder.
 */
function walkPO(func: SSAFunction, visitor: BlockVisitor): void {
  const postorder = computePostorder(func);

  for (const blockId of postorder) {
    const block = func.blocks.get(blockId);
    if (!block) continue;
    visitor(block, func);
  }
}

/**
 * Compute postorder traversal.
 */
function computePostorder(func: SSAFunction): BlockId[] {
  const visited = new Set<BlockId>();
  const postorder: BlockId[] = [];

  function visit(blockId: BlockId): void {
    if (visited.has(blockId)) return;
    visited.add(blockId);

    const block = func.blocks.get(blockId);
    if (!block) return;

    for (const succ of block.successors) {
      visit(succ);
    }

    postorder.push(blockId);
  }

  visit(func.entry);
  return postorder;
}

/**
 * Visit all instructions in a function.
 */
export function walkInstructions(
  func: SSAFunction,
  order: TraversalOrder,
  visitor: InstructionVisitor,
): void {
  walkCFG(func, order, (block) => {
    for (let i = 0; i < block.instructions.length; i++) {
      const inst = block.instructions[i]!;
      const result = visitor(inst, block, func);

      if (result === "remove") {
        block.instructions.splice(i, 1);
        i--; // Adjust index after removal
      } else if (result === "skip-rest") {
        return false; // Stop visiting this block
      }
    }
  });
}

/**
 * Generic instruction transformer: visits each instruction and allows replacement.
 */
export interface InstructionTransformer {
  (
    inst: Instruction,
    block: BasicBlock,
    func: SSAFunction,
  ):
    | Instruction // Replace with new instruction
    | null // Remove instruction
    | undefined; // Keep unchanged
}

/**
 * Transform instructions in-place.
 */
export function transformInstructions(
  func: SSAFunction,
  order: TraversalOrder,
  transformer: InstructionTransformer,
): { changed: boolean } {
  let changed = false;

  walkCFG(func, order, (block) => {
    for (let i = 0; i < block.instructions.length; i++) {
      const inst = block.instructions[i]!;
      const result = transformer(inst, block, func);

      if (result === null) {
        // Remove instruction
        block.instructions.splice(i, 1);
        i--;
        changed = true;
      } else if (result !== undefined && result !== inst) {
        // Replace instruction
        block.instructions[i] = result;
        changed = true;
      }
    }
  });

  return { changed };
}

/**
 * Block transformer: allows block-level modifications.
 */
export interface BlockTransformer {
  (
    block: BasicBlock,
    func: SSAFunction,
  ):
    | BasicBlock // Replace block
    | null // Remove block (dangerous: must fix predecessors!)
    | undefined; // Keep unchanged
}

/**
 * Transform blocks in-place.
 */
export function transformBlocks(
  func: SSAFunction,
  order: TraversalOrder,
  transformer: BlockTransformer,
): { changed: boolean } {
  let changed = false;
  const toRemove: BlockId[] = [];

  walkCFG(func, order, (block) => {
    const result = transformer(block, func);

    if (result === null) {
      toRemove.push(block.id);
      changed = true;
    } else if (result !== undefined && result !== block) {
      func.blocks.set(block.id, result);
      changed = true;
    }
  });

  // Remove blocks (caller must ensure CFG remains valid)
  for (const blockId of toRemove) {
    func.blocks.delete(blockId);
  }

  return { changed };
}

/**
 * Worklist algorithm helper: process items until fixed point.
 * Common pattern in dataflow analysis.
 */
export function worklist<T>(
  initial: Iterable<T>,
  process: (item: T) => Iterable<T>, // Returns new items to add to worklist
): void {
  const queue = Array.from(initial);
  const inQueue = new Set(queue);

  while (queue.length > 0) {
    const item = queue.shift()!;
    inQueue.delete(item);

    const newItems = process(item);

    for (const newItem of newItems) {
      if (!inQueue.has(newItem)) {
        queue.push(newItem);
        inQueue.add(newItem);
      }
    }
  }
}

/**
 * Builder pattern for constructing new SSA functions.
 * Useful when generating SSA from scratch.
 */
export class SSABuilder {
  public readonly funcId: string;
  public readonly blocks: Map<BlockId, BasicBlock>;
  public entry: BlockId;
  private blockCounter = 0;
  private valueCounter = 0;

  constructor(funcId: string, blocks?: Map<BlockId, BasicBlock>, entry?: BlockId) {
    this.funcId = funcId;
    this.blocks = blocks ?? new Map<BlockId, BasicBlock>();
    this.entry = entry ?? "entry";
  }

  /**
   * Create a new block ID.
   */
  freshBlock(): BlockId {
    return `bb${this.blockCounter++}`;
  }

  /**
   * Create a new value ID.
   */
  freshValue(): string {
    return `v${this.valueCounter++}`;
  }

  /**
   * Add a block to the function.
   */
  addBlock(id: BlockId, block: BasicBlock): void {
    this.blocks.set(id, block);
  }

  /**
   * Build the final SSA function.
   */
  build(params: Array<{ id: string; type: ValueType }>, returnType: ValueType): SSAFunction {
    return {
      id: this.funcId,
      params,
      returnType,
      blocks: this.blocks,
      entry: this.entry,
    };
  }
}

/**
 * Utility: collect all instructions of a specific kind.
 */
export function collectInstructions<K extends Instruction["kind"]>(
  func: SSAFunction,
  kind: K,
): Array<Extract<Instruction, { kind: K }>> {
  const results: Array<Extract<Instruction, { kind: K }>> = [];

  walkInstructions(func, "entry-first", (inst) => {
    if (inst.kind === kind) {
      results.push(inst as Extract<Instruction, { kind: K }>);
    }
  });

  return results;
}

/**
 * Utility: count instructions by kind.
 */
export function countInstructions(func: SSAFunction): Map<Instruction["kind"], number> {
  const counts = new Map<Instruction["kind"], number>();

  walkInstructions(func, "entry-first", (inst) => {
    counts.set(inst.kind, (counts.get(inst.kind) ?? 0) + 1);
  });

  return counts;
}
