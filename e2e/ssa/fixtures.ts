/**
 * SSA test fixtures
 *
 * Pre-built SSA functions for testing analysis and optimization passes.
 */

import type { SSAFunction, BasicBlock, Instruction } from "../../src/ssa/ir.js";
import type { TestInstr } from "./passes.js";

/**
 * Helper: create a basic block
 */
function block(
  id: string,
  instructions: Instruction<TestInstr>[],
  terminator: BasicBlock<TestInstr>["terminator"],
  predecessors: string[] = [],
  successors: string[] = [],
): BasicBlock<TestInstr> {
  return { id, instructions, terminator, predecessors, successors };
}

/**
 * Straight-line code: x = 10; y = 32; z = x + y; return z
 */
export function straightLine(): SSAFunction<TestInstr> {
  return {
    id: "straight-line",
    entry: "entry",
    blocks: new Map([
      [
        "entry",
        block(
          "entry",
          [
            { type: "const", dest: "x", value: 10 },
            { type: "const", dest: "y", value: 32 },
            { type: "add", dest: "z", left: "x", right: "y" },
          ],
          { type: "ret", value: "z" },
        ),
      ],
    ]),
  };
}

/**
 * Diamond CFG with phi node:
 *
 *        entry
 *        /    \
 *     then    else
 *        \    /
 *        join
 */
export function diamond(): SSAFunction<TestInstr> {
  return {
    id: "diamond",
    entry: "entry",
    blocks: new Map([
      [
        "entry",
        block(
          "entry",
          [{ type: "const", dest: "cond", value: 1 }],
          { type: "branch", cond: "cond", ifTrue: "then", ifFalse: "else" },
          [],
          ["then", "else"],
        ),
      ],
      [
        "then",
        block(
          "then",
          [{ type: "const", dest: "x1", value: 10 }],
          { type: "jump", target: "join" },
          ["entry"],
          ["join"],
        ),
      ],
      [
        "else",
        block(
          "else",
          [{ type: "const", dest: "x2", value: 20 }],
          { type: "jump", target: "join" },
          ["entry"],
          ["join"],
        ),
      ],
      [
        "join",
        block(
          "join",
          [
            {
              type: "phi",
              dest: "x",
              incoming: [
                ["then", "x1"],
                ["else", "x2"],
              ],
            },
          ],
          { type: "ret", value: "x" },
          ["then", "else"],
        ),
      ],
    ]),
  };
}

/**
 * Loop with phi node:
 *
 *     entry
 *       |
 *     loop <--+
 *       |     |
 *       +-----+  (back edge)
 *       |
 *     exit
 */
export function loop(): SSAFunction<TestInstr> {
  return {
    id: "loop",
    entry: "entry",
    blocks: new Map([
      [
        "entry",
        block(
          "entry",
          [{ type: "const", dest: "init", value: 0 }],
          { type: "jump", target: "loop" },
          [],
          ["loop"],
        ),
      ],
      [
        "loop",
        block(
          "loop",
          [
            {
              type: "phi",
              dest: "i",
              incoming: [
                ["entry", "init"],
                ["loop", "next"],
              ],
            },
            { type: "const", dest: "one", value: 1 },
            { type: "add", dest: "next", left: "i", right: "one" },
          ],
          { type: "branch", cond: "cond", ifTrue: "loop", ifFalse: "exit" },
          ["entry", "loop"],
          ["loop", "exit"],
        ),
      ],
      ["exit", block("exit", [], { type: "ret", value: "i" }, ["loop"])],
    ]),
  };
}

/**
 * Dead code: contains an unused computation.
 */
export function deadCode(): SSAFunction<TestInstr> {
  return {
    id: "dead-code",
    entry: "entry",
    blocks: new Map([
      [
        "entry",
        block(
          "entry",
          [
            { type: "const", dest: "x", value: 42 },
            { type: "const", dest: "y", value: 10 },
            { type: "add", dest: "dead", left: "x", right: "y" },
            { type: "const", dest: "result", value: 1 },
          ],
          { type: "ret", value: "result" },
        ),
      ],
    ]),
  };
}

/**
 * Unreachable block: block that no path reaches.
 */
export function unreachableBlock(): SSAFunction<TestInstr> {
  return {
    id: "unreachable",
    entry: "entry",
    blocks: new Map([
      ["entry", block("entry", [{ type: "const", dest: "x", value: 42 }], { type: "ret", value: "x" })],
      ["dead", block("dead", [{ type: "const", dest: "y", value: 10 }], { type: "ret", value: "y" })],
    ]),
  };
}

/**
 * All fixtures by name.
 */
export const FIXTURES = {
  straightLine,
  diamond,
  loop,
  deadCode,
  unreachableBlock,
} as const;
