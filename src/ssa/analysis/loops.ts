/**
 * Loop recognition and analysis
 *
 * Detects natural loops in the CFG using dominator tree.
 *
 * Natural loop:
 * - A back edge from B to H where H dominates B
 * - Loop = all nodes that can reach B without going through H
 *
 * Loop properties:
 * - Header: entry point (dominates all loop blocks)
 * - Latches: blocks with back edges to header
 * - Exits: edges leaving the loop
 * - Depth: nesting level
 *
 * Used for:
 * - Loop optimizations (invariant code motion, strength reduction)
 * - Vectorization
 * - Unrolling
 * - Parallelization analysis
 */

import type { SSAFunction, BlockId, BasicBlock } from "../ir.ts";
import type { DomTree } from "./domtree.ts";
import { dominates } from "./domtree.ts";

export class LoopError extends Error {}

/**
 * A natural loop in the CFG
 */
export interface Loop {
  id: number; // Unique loop identifier
  header: BlockId; // Loop header (dominates all loop blocks)
  latches: BlockId[]; // Blocks with back edges to header
  blocks: Set<BlockId>; // All blocks in the loop
  exits: Array<{ from: BlockId; to: BlockId }>; // Edges exiting the loop
  parent: number | null; // Parent loop ID (for nested loops)
  children: number[]; // Child loop IDs
  depth: number; // Nesting depth (0 = top-level)
}

/**
 * Complete loop structure for a function
 */
export interface LoopInfo {
  loops: Map<number, Loop>;
  blockToLoop: Map<BlockId, number>; // Block -> innermost loop ID
  headers: Set<BlockId>; // All loop headers
}

/**
 * Detect all natural loops in the function.
 */
export function detectLoops<T>(func: SSAFunction<T>, domTree: DomTree): LoopInfo {
  const loops = new Map<number, Loop>();
  const blockToLoop = new Map<BlockId, number>();
  const headers = new Set<BlockId>();

  let loopCounter = 0;

  // Step 1: Find back edges (B -> H where H dominates B)
  const backEdges: Array<{ from: BlockId; to: BlockId }> = [];

  for (const [blockId, block] of func.blocks) {
    for (const succ of block.successors) {
      if (dominates(domTree, succ, blockId)) {
        backEdges.push({ from: blockId, to: succ });
        headers.add(succ);
      }
    }
  }

  // Step 2: For each back edge, construct the natural loop
  const headerToLoops = new Map<BlockId, number[]>();

  for (const edge of backEdges) {
    const header = edge.to;
    const latch = edge.from;

    // Find all blocks in this loop (blocks that reach latch without going through header)
    const loopBlocks = findLoopBlocks(func, header, latch);

    // Create or merge with existing loop for this header
    const existingLoops = headerToLoops.get(header) ?? [];

    if (existingLoops.length === 0) {
      // New loop
      const loopId = loopCounter++;
      const loop: Loop = {
        id: loopId,
        header,
        latches: [latch],
        blocks: loopBlocks,
        exits: [],
        parent: null,
        children: [],
        depth: 0,
      };

      loops.set(loopId, loop);
      headerToLoops.set(header, [loopId]);

      for (const block of loopBlocks) {
        blockToLoop.set(block, loopId);
      }
    } else {
      // Merge with existing loop (multiple latches)
      const loopId = existingLoops[0]!;
      const loop = loops.get(loopId)!;

      loop.latches.push(latch);

      // Add new blocks
      for (const block of loopBlocks) {
        if (!loop.blocks.has(block)) {
          loop.blocks.add(block);
          blockToLoop.set(block, loopId);
        }
      }
    }
  }

  // Step 3: Find loop exits
  for (const loop of loops.values()) {
    for (const blockId of loop.blocks) {
      const block = func.blocks.get(blockId) as BasicBlock<T> | undefined;
      if (!block) continue;

      for (const succ of block.successors) {
        if (!loop.blocks.has(succ)) {
          loop.exits.push({ from: blockId, to: succ });
        }
      }
    }
  }

  // Step 4: Build loop nesting tree
  buildLoopNesting(loops, blockToLoop);

  return { loops, blockToLoop, headers };
}

/**
 * Find all blocks in a loop given header and one latch.
 *
 * Algorithm: work backwards from latch to header, collecting all blocks.
 */
function findLoopBlocks<T>(func: SSAFunction<T>, header: BlockId, latch: BlockId): Set<BlockId> {
  const blocks = new Set<BlockId>([header, latch]);
  const worklist = [latch];

  while (worklist.length > 0) {
    const current = worklist.pop()!;
    if (current === header) continue;

    const block = func.blocks.get(current);
    if (!block) continue;

    for (const pred of block.predecessors) {
      if (!blocks.has(pred)) {
        blocks.add(pred);
        worklist.push(pred);
      }
    }
  }

  return blocks;
}

/**
 * Build parent-child relationships between nested loops.
 */
function buildLoopNesting(loops: Map<number, Loop>, blockToLoop: Map<BlockId, number>): void {
  // For each loop, find its parent (smallest loop that contains its header)
  for (const loop of loops.values()) {
    let parentLoop: Loop | null = null;
    let parentSize = Infinity;

    for (const candidate of loops.values()) {
      if (candidate.id === loop.id) continue;

      if (candidate.blocks.has(loop.header) && candidate.blocks.size < parentSize) {
        parentLoop = candidate;
        parentSize = candidate.blocks.size;
      }
    }

    if (parentLoop) {
      loop.parent = parentLoop.id;
      parentLoop.children.push(loop.id);
    }
  }

  // Compute depths
  function computeDepth(loopId: number): number {
    const loop = loops.get(loopId);
    if (!loop) return 0;

    if (loop.parent === null) {
      loop.depth = 0;
      return 0;
    }

    loop.depth = computeDepth(loop.parent) + 1;
    return loop.depth;
  }

  for (const loop of loops.values()) {
    if (loop.depth === 0 && loop.parent === null) {
      computeDepth(loop.id);
    }
  }
}

/**
 * Get the innermost loop containing a block.
 */
export function getInnermostLoop(info: LoopInfo, block: BlockId): Loop | null {
  const loopId = info.blockToLoop.get(block);
  if (loopId === undefined) return null;
  return info.loops.get(loopId) ?? null;
}

/**
 * Get all loops containing a block (from innermost to outermost).
 */
export function getLoopNest(info: LoopInfo, block: BlockId): Loop[] {
  const nest: Loop[] = [];
  let current = getInnermostLoop(info, block);

  while (current) {
    nest.push(current);
    current = current.parent !== null ? (info.loops.get(current.parent) ?? null) : null;
  }

  return nest;
}

/**
 * Check if a loop is a simple loop (single latch, single exit).
 */
export function isSimpleLoop(loop: Loop): boolean {
  return loop.latches.length === 1 && loop.exits.length === 1;
}

/**
 * Check if a block is a loop header.
 */
export function isLoopHeader(info: LoopInfo, block: BlockId): boolean {
  return info.headers.has(block);
}

/**
 * Get all top-level loops (not nested in other loops).
 */
export function getTopLevelLoops(info: LoopInfo): Loop[] {
  const topLevel: Loop[] = [];

  for (const loop of info.loops.values()) {
    if (loop.parent === null) {
      topLevel.push(loop);
    }
  }

  return topLevel;
}

/**
 * Get loop preheader (single predecessor of header outside the loop).
 * Returns null if no unique preheader exists.
 */
export function getLoopPreheader(func: SSAFunction, loop: Loop): BlockId | null {
  const headerBlock = func.blocks.get(loop.header);
  if (!headerBlock) return null;

  const externalPreds = headerBlock.predecessors.filter((pred) => !loop.blocks.has(pred));

  if (externalPreds.length === 1) {
    return externalPreds[0]!;
  }

  return null;
}

/**
 * Check if a loop has a single exit block (all exits go to same block).
 */
export function hasSingleExit(loop: Loop): boolean {
  if (loop.exits.length === 0) return false;

  const firstExit = loop.exits[0]!.to;
  return loop.exits.every((exit) => exit.to === firstExit);
}

/**
 * Get trip count if loop has a simple counting pattern.
 * Returns null if trip count cannot be determined statically.
 */
export function getTripCount(func: SSAFunction, loop: Loop): number | null {
  // TODO: Implement pattern matching for simple counting loops
  // This requires value range analysis and induction variable recognition
  return null;
}
