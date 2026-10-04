/**
 * SSA walker: CFG traversal and transformation utilities
 *
 * Provides:
 * - Graph visitors (for analysis passes)
 * - In-place transformers (for optimization passes)
 * - Block iterators (CFG traversal: DFS, RPO, etc.)
 */

import type { SSAFunction, BasicBlock, Instruction, BlockId } from "./ir.ts";

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
export interface BlockVisitor<T = never> {
  (block: BasicBlock<T>, func: SSAFunction<T>): void | boolean; // return false to skip
}

/**
 * Instruction visitor: called for each instruction
 */
export interface InstructionVisitor<T = never> {
  (inst: Instruction<T>, block: BasicBlock<T>, func: SSAFunction<T>): void | "remove" | "skip-rest";
}

/**
 * Walk CFG in specified order, calling visitor for each block.
 */
export function walkCFG<T>(func: SSAFunction<T>, order: TraversalOrder, visitor: BlockVisitor<T>): void {
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
function walkEntryFirst<T>(func: SSAFunction<T>, visitor: BlockVisitor<T>, visited: Set<BlockId>): void {
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
function walkDFS<T>(func: SSAFunction<T>, blockId: BlockId, visitor: BlockVisitor<T>, visited: Set<BlockId>): void {
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
function walkRPO<T>(func: SSAFunction<T>, visitor: BlockVisitor<T>): void {
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
function walkPO<T>(func: SSAFunction<T>, visitor: BlockVisitor<T>): void {
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
function computePostorder<T>(func: SSAFunction<T>): BlockId[] {
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
export function walkInstructions<T>(
  func: SSAFunction<T>,
  order: TraversalOrder,
  visitor: InstructionVisitor<T>,
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
export interface InstructionTransformer<T = never> {
  (
    inst: Instruction<T>,
    block: BasicBlock<T>,
    func: SSAFunction<T>,
  ):
    | Instruction<T> // Replace with new instruction
    | null // Remove instruction
    | undefined; // Keep unchanged
}

/**
 * Transform instructions in-place.
 */
export function transformInstructions<T>(
  func: SSAFunction<T>,
  order: TraversalOrder,
  transformer: InstructionTransformer<T>,
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
export interface BlockTransformer<T = never> {
  (
    block: BasicBlock<T>,
    func: SSAFunction<T>,
  ):
    | BasicBlock<T> // Replace block
    | null // Remove block (dangerous: must fix predecessors!)
    | undefined; // Keep unchanged
}

/**
 * Transform blocks in-place.
 */
export function transformBlocks<T>(
  func: SSAFunction<T>,
  order: TraversalOrder,
  transformer: BlockTransformer<T>,
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
