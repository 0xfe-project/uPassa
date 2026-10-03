/**
 * Dominator tree construction
 *
 * Implements the Lengauer-Tarjan algorithm for computing dominators.
 *
 * Dominator relationships:
 * - Block A dominates block B if every path from entry to B goes through A
 * - Immediate dominator (idom): closest dominator that is not B itself
 * - Dominator tree: tree where parent is the immediate dominator
 *
 * Used for:
 * - SSA construction (phi placement at dominance frontiers)
 * - Loop detection
 * - Dead code elimination
 * - Code motion optimizations
 */

import type { SSAFunction, BlockId, BasicBlock } from "../ir.ts";

export class DomTreeError extends Error {}

/**
 * Dominator tree node
 */
export interface DomNode {
  block: BlockId;
  idom: BlockId | null; // Immediate dominator (null for entry)
  children: BlockId[]; // Blocks immediately dominated by this block
  domFrontier: Set<BlockId>; // Dominance frontier
  level: number; // Distance from entry (entry = 0)
}

/**
 * Complete dominator tree
 */
export interface DomTree {
  nodes: Map<BlockId, DomNode>;
  entry: BlockId;
}

/**
 * Build dominator tree using Lengauer-Tarjan algorithm.
 */
export function buildDomTree(func: SSAFunction): DomTree {
  const blocks = Array.from(func.blocks.values());
  const entry = func.entry;

  // Step 1: DFS to assign preorder numbers
  const { preorder, parent } = dfs(blocks, entry);

  // Step 2: Compute semi-dominators and dominators
  const idom = computeDominators(blocks, entry, preorder, parent);

  // Step 3: Build dominator tree structure
  const nodes = new Map<BlockId, DomNode>();

  for (const block of blocks) {
    nodes.set(block.id, {
      block: block.id,
      idom: idom.get(block.id) ?? null,
      children: [],
      domFrontier: new Set(),
      level: 0,
    });
  }

  // Fill children and compute levels
  for (const [blockId, node] of nodes) {
    if (node.idom) {
      const parent = nodes.get(node.idom);
      if (parent) {
        parent.children.push(blockId);
        node.level = parent.level + 1;
      }
    }
  }

  // Step 4: Compute dominance frontiers
  computeDominanceFrontiers(blocks, nodes);

  return { nodes, entry };
}

/**
 * DFS to establish preorder and parent relationships.
 */
function dfs(
  blocks: BasicBlock[],
  entry: BlockId,
): {
  preorder: Map<BlockId, number>;
  parent: Map<BlockId, BlockId>;
} {
  const preorder = new Map<BlockId, number>();
  const parent = new Map<BlockId, BlockId>();
  const visited = new Set<BlockId>();

  let counter = 0;

  function visit(blockId: BlockId): void {
    if (visited.has(blockId)) return;
    visited.add(blockId);
    preorder.set(blockId, counter++);

    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;

    for (const succ of block.successors) {
      if (!visited.has(succ)) {
        parent.set(succ, blockId);
        visit(succ);
      }
    }
  }

  visit(entry);
  return { preorder, parent };
}

/**
 * Compute immediate dominators using simplified algorithm.
 *
 * This is a simplified iterative dataflow algorithm, not the full Lengauer-Tarjan.
 * Good enough for typical CFGs, and much simpler to understand.
 */
function computeDominators(
  blocks: BasicBlock[],
  entry: BlockId,
  preorder: Map<BlockId, number>,
  parent: Map<BlockId, BlockId>,
): Map<BlockId, BlockId> {
  const blockMap = new Map<BlockId, BasicBlock>();
  for (const block of blocks) {
    blockMap.set(block.id, block);
  }

  // Initialize: all blocks dominated by all blocks
  const doms = new Map<BlockId, Set<BlockId>>();
  for (const block of blocks) {
    doms.set(block.id, new Set(blocks.map((b) => b.id)));
  }

  // Entry dominates only itself
  doms.set(entry, new Set([entry]));

  // Iterate until fixed point
  let changed = true;
  while (changed) {
    changed = false;

    for (const block of blocks) {
      if (block.id === entry) continue;

      // New dominators = {block} ∪ (∩ doms of all predecessors)
      let newDoms: Set<BlockId> | null = null;

      for (const pred of block.predecessors) {
        const predDoms = doms.get(pred);
        if (!predDoms) continue;

        if (newDoms === null) {
          newDoms = new Set(predDoms);
        } else {
          newDoms = intersection(newDoms, predDoms);
        }
      }

      if (newDoms) {
        newDoms.add(block.id);

        const oldDoms = doms.get(block.id)!;
        if (!setsEqual(oldDoms, newDoms)) {
          doms.set(block.id, newDoms);
          changed = true;
        }
      }
    }
  }

  // Extract immediate dominators
  const idom = new Map<BlockId, BlockId>();

  for (const block of blocks) {
    if (block.id === entry) continue;

    const blockDoms = doms.get(block.id);
    if (!blockDoms) continue;

    // idom is the dominator with highest preorder number (closest to block)
    let bestIdom: BlockId | null = null;
    let bestPreorder = -1;

    for (const dom of blockDoms) {
      if (dom === block.id) continue;

      const domPreorder = preorder.get(dom) ?? -1;
      if (domPreorder > bestPreorder) {
        bestPreorder = domPreorder;
        bestIdom = dom;
      }
    }

    if (bestIdom) {
      idom.set(block.id, bestIdom);
    }
  }

  return idom;
}

/**
 * Compute dominance frontiers for all blocks.
 *
 * Dominance frontier of block X:
 * Set of blocks Y where X dominates a predecessor of Y, but does not strictly dominate Y.
 */
function computeDominanceFrontiers(blocks: BasicBlock[], nodes: Map<BlockId, DomNode>): void {
  for (const block of blocks) {
    if (block.predecessors.length < 2) continue;

    for (const pred of block.predecessors) {
      let runner = pred;

      // Walk up dominator tree until we reach block's idom
      const blockNode = nodes.get(block.id);
      if (!blockNode) continue;

      while (runner !== blockNode.idom) {
        const runnerNode = nodes.get(runner);
        if (!runnerNode) break;

        runnerNode.domFrontier.add(block.id);

        if (!runnerNode.idom) break;
        runner = runnerNode.idom;
      }
    }
  }
}

/**
 * Check if block A dominates block B.
 */
export function dominates(tree: DomTree, a: BlockId, b: BlockId): boolean {
  if (a === b) return true;

  let current = b;
  while (current !== tree.entry) {
    const node = tree.nodes.get(current);
    if (!node || !node.idom) return false;

    if (node.idom === a) return true;
    current = node.idom;
  }

  return a === tree.entry;
}

/**
 * Check if block A strictly dominates block B (A ≠ B).
 */
export function strictlyDominates(tree: DomTree, a: BlockId, b: BlockId): boolean {
  return a !== b && dominates(tree, a, b);
}

/**
 * Get dominator tree path from block to entry.
 */
export function getDominatorPath(tree: DomTree, block: BlockId): BlockId[] {
  const path: BlockId[] = [];
  let current = block;

  while (true) {
    path.push(current);
    if (current === tree.entry) break;

    const node = tree.nodes.get(current);
    if (!node || !node.idom) break;
    current = node.idom;
  }

  return path;
}

/**
 * Get lowest common ancestor in dominator tree.
 */
export function getLCA(tree: DomTree, a: BlockId, b: BlockId): BlockId | null {
  const pathA = new Set(getDominatorPath(tree, a));
  const pathB = getDominatorPath(tree, b);

  for (const block of pathB) {
    if (pathA.has(block)) {
      return block;
    }
  }

  return null;
}

// Utility functions

function intersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const item of a) {
    if (b.has(item)) {
      result.add(item);
    }
  }
  return result;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
