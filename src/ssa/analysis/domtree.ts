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
  /** DFS entry number in the dominator tree (-1 if unreachable). */
  enter: number;
  /** DFS exit number in the dominator tree (-1 if unreachable). */
  exit: number;
}

/**
 * Complete dominator tree
 */
export interface DomTree {
  nodes: Map<BlockId, DomNode>;
  entry: BlockId;
}

/**
 * Build dominator tree using the Cooper-Harvey-Kennedy algorithm.
 * Generic over T: works on any IR extension.
 */
export function buildDomTree<T>(func: SSAFunction<T>): DomTree {
  const blocks = Array.from(func.blocks.values()) as BasicBlock<T>[];
  const entry = func.entry;

  const blockMap = new Map<BlockId, BasicBlock<T>>();
  for (const block of blocks) blockMap.set(block.id, block);

  // Step 1: reverse postorder over reachable blocks
  const { rpo, index: rpoIndex } = computeRPO(blockMap, entry);

  // Step 2: immediate dominators
  const idom = computeDominators(blockMap, entry, rpo, rpoIndex);

  // Step 3: Build dominator tree structure
  const nodes = new Map<BlockId, DomNode>();

  for (const block of blocks) {
    nodes.set(block.id, {
      block: block.id,
      idom: idom.get(block.id) ?? null,
      children: [],
      domFrontier: new Set(),
      level: 0,
      enter: -1,
      exit: -1,
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

  // DFS interval numbering over the dominator tree.
  //
  // Lets `dominates(a, b)` be answered in O(1): a dominates b iff b's interval
  // is nested inside a's. Without this, each query walks up the tree — and
  // loop detection queries it once per CFG edge, giving O(n²) on deep CFGs.
  let counter = 0;
  const number = (blockId: BlockId): void => {
    const node = nodes.get(blockId);
    if (!node) return;
    node.enter = counter++;
    for (const child of node.children) number(child);
    node.exit = counter++;
  };
  if (nodes.has(entry)) number(entry);

  // Step 4: Compute dominance frontiers
  computeDominanceFrontiers(blocks, nodes);

  return { nodes, entry };
}

/**
 * Compute reverse postorder (RPO) over the reachable blocks.
 *
 * RPO is the standard traversal order for forward dataflow: it visits a block
 * before all blocks it dominates (except itself), which is what the
 * Cooper-Harvey-Kennedy dominator algorithm needs.
 */
function computeRPO<T>(
  blockMap: Map<BlockId, BasicBlock<T>>,
  entry: BlockId,
): { rpo: BlockId[]; index: Map<BlockId, number> } {
  const postorder: BlockId[] = [];
  const visited = new Set<BlockId>();

  // Iterative DFS (explicit stack) — deep CFGs would blow the native stack otherwise.
  const stack: Array<{ block: BlockId; succIndex: number }> = [{ block: entry, succIndex: 0 }];
  visited.add(entry);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const block = blockMap.get(frame.block);
    const succs = block ? block.successors : [];

    if (frame.succIndex < succs.length) {
      const next = succs[frame.succIndex++]!;
      if (!visited.has(next) && blockMap.has(next)) {
        visited.add(next);
        stack.push({ block: next, succIndex: 0 });
      }
    } else {
      postorder.push(frame.block);
      stack.pop();
    }
  }

  const rpo = postorder.reverse();
  const index = new Map<BlockId, number>();
  for (let i = 0; i < rpo.length; i++) index.set(rpo[i]!, i);

  return { rpo, index };
}

/**
 * Compute immediate dominators using the Cooper-Harvey-Kennedy algorithm.
 *
 * Simple, near-linear in practice, and linear on reducible CFGs like chains.
 * Avoids the O(n²) set-of-all-dominators representation entirely: we store
 * only the immediate dominator per block.
 *
 * Reference: Cooper, Harvey, Kennedy, "A Simple, Fast Dominance Algorithm" (2001).
 */
function computeDominators<T>(
  blockMap: Map<BlockId, BasicBlock<T>>,
  entry: BlockId,
  rpo: BlockId[],
  rpoIndex: Map<BlockId, number>,
): Map<BlockId, BlockId> {
  const idom = new Map<BlockId, BlockId>();
  idom.set(entry, entry); // entry is its own immediate dominator (sentinel)

  /** Walk up the dominator tree until two nodes meet. */
  const intersect = (a: BlockId, b: BlockId): BlockId => {
    let x = a;
    let y = b;
    while (x !== y) {
      while ((rpoIndex.get(x) ?? 0) > (rpoIndex.get(y) ?? 0)) {
        x = idom.get(x)!;
      }
      while ((rpoIndex.get(y) ?? 0) > (rpoIndex.get(x) ?? 0)) {
        y = idom.get(y)!;
      }
    }
    return x;
  };

  let changed = true;
  while (changed) {
    changed = false;

    for (const blockId of rpo) {
      if (blockId === entry) continue;

      const block = blockMap.get(blockId);
      if (!block) continue;

      let newIdom: BlockId | undefined;
      for (const pred of block.predecessors) {
        if (!idom.has(pred)) continue; // predecessor not yet processed
        newIdom = newIdom === undefined ? pred : intersect(pred, newIdom);
      }

      if (newIdom !== undefined && idom.get(blockId) !== newIdom) {
        idom.set(blockId, newIdom);
        changed = true;
      }
    }
  }

  // Drop the entry sentinel so callers see `null` for the root.
  idom.delete(entry);
  return idom;
}

/**
 * Compute dominance frontiers for all blocks.
 *
 * Dominance frontier of block X:
 * Set of blocks Y where X dominates a predecessor of Y, but does not strictly dominate Y.
 */
function computeDominanceFrontiers<T>(blocks: BasicBlock<T>[], nodes: Map<BlockId, DomNode>): void {
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
 *
 * O(1): a dominates b iff b's DFS interval is nested inside a's.
 */
export function dominates(tree: DomTree, a: BlockId, b: BlockId): boolean {
  if (a === b) return true;

  const na = tree.nodes.get(a);
  const nb = tree.nodes.get(b);
  if (!na || !nb) return false;

  // Unreachable blocks (enter === -1) are not dominated by anything.
  if (na.enter === -1 || nb.enter === -1) return false;

  return na.enter <= nb.enter && nb.exit <= na.exit;
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
