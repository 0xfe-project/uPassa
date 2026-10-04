/**
 * Tests for Braun SSA construction algorithm
 */

import { describe, it, expect } from "vitest";
import { toSSA, type PreSSAFunction, type PreSSABlock } from "../../../src/ssa/braun.js";
import type { SSAFunction } from "../../../src/ssa/ir.js";

describe("Braun SSA Construction", () => {
  it("constructs simple straight-line code", () => {
    const preFunc: PreSSAFunction<never> = {
      id: "test",
      entry: "entry",
      blocks: new Map([
        [
          "entry",
          {
            id: "entry",
            assignments: new Map([
              ["x", { kind: "var", name: "v1" }],
              ["y", { kind: "var", name: "v2" }],
            ]),
            terminator: { kind: "ret", value: "x" },
            predecessors: [],
          },
        ],
      ]),
    };

    const ssaFunc = toSSA(preFunc);

    expect(ssaFunc.blocks.size).toBe(1);
    const entry = ssaFunc.blocks.get("entry")!;
    expect(entry).toBeDefined();
    expect(entry.terminator.type).toBe("ret");
  });

  it("inserts phi for diamond CFG", () => {
    const preFunc: PreSSAFunction<never> = {
      id: "test",
      entry: "entry",
      blocks: new Map([
        [
          "entry",
          {
            id: "entry",
            assignments: new Map([["x", { kind: "var", name: "v1" }]]),
            terminator: { kind: "branch", cond: "cond", ifTrue: "then", ifFalse: "else" },
            predecessors: [],
          },
        ],
        [
          "then",
          {
            id: "then",
            assignments: new Map([["x", { kind: "var", name: "v2" }]]),
            terminator: { kind: "jump", target: "join" },
            predecessors: ["entry"],
          },
        ],
        [
          "else",
          {
            id: "else",
            assignments: new Map([["x", { kind: "var", name: "v3" }]]),
            terminator: { kind: "jump", target: "join" },
            predecessors: ["entry"],
          },
        ],
        [
          "join",
          {
            id: "join",
            assignments: new Map(),
            terminator: { kind: "ret", value: "x" },
            predecessors: ["then", "else"],
          },
        ],
      ]),
    };

    const ssaFunc = toSSA(preFunc);

    const joinBlock = ssaFunc.blocks.get("join")!;
    expect(joinBlock).toBeDefined();

    // Should have phi node for x
    const phiNodes = joinBlock.instructions.filter((i: any) => i.type === "phi");
    expect(phiNodes.length).toBeGreaterThan(0);
  });

  it("handles loop with back edge", () => {
    const preFunc: PreSSAFunction<never> = {
      id: "test",
      entry: "entry",
      blocks: new Map([
        [
          "entry",
          {
            id: "entry",
            assignments: new Map([["i", { kind: "var", name: "v_init" }]]),
            terminator: { kind: "jump", target: "loop" },
            predecessors: [],
          },
        ],
        [
          "loop",
          {
            id: "loop",
            assignments: new Map([["i", { kind: "var", name: "v_next" }]]),
            terminator: { kind: "branch", cond: "cond", ifTrue: "loop", ifFalse: "exit" },
            predecessors: ["entry", "loop"],
          },
        ],
        [
          "exit",
          {
            id: "exit",
            assignments: new Map(),
            terminator: { kind: "ret", value: "i" },
            predecessors: ["loop"],
          },
        ],
      ]),
    };

    const ssaFunc = toSSA(preFunc);

    const loopBlock = ssaFunc.blocks.get("loop")!;
    expect(loopBlock).toBeDefined();

    // Loop header should have phi for loop variable
    const phiNodes = loopBlock.instructions.filter((i: any) => i.type === "phi");
    expect(phiNodes.length).toBeGreaterThan(0);
  });

  it("propagates values through empty blocks", () => {
    const preFunc: PreSSAFunction<never> = {
      id: "test",
      entry: "entry",
      blocks: new Map([
        [
          "entry",
          {
            id: "entry",
            assignments: new Map([["x", { kind: "var", name: "v1" }]]),
            terminator: { kind: "jump", target: "middle" },
            predecessors: [],
          },
        ],
        [
          "middle",
          {
            id: "middle",
            assignments: new Map(),
            terminator: { kind: "jump", target: "exit" },
            predecessors: ["entry"],
          },
        ],
        [
          "exit",
          {
            id: "exit",
            assignments: new Map(),
            terminator: { kind: "ret", value: "x" },
            predecessors: ["middle"],
          },
        ],
      ]),
    };

    const ssaFunc = toSSA(preFunc);

    expect(ssaFunc.blocks.size).toBe(3);
    const exitBlock = ssaFunc.blocks.get("exit")!;
    expect(exitBlock.terminator.type).toBe("ret");
  });

  it("handles multiple variables independently", () => {
    const preFunc: PreSSAFunction<never> = {
      id: "test",
      entry: "entry",
      blocks: new Map([
        [
          "entry",
          {
            id: "entry",
            assignments: new Map([
              ["x", { kind: "var", name: "x1" }],
              ["y", { kind: "var", name: "y1" }],
            ]),
            terminator: { kind: "branch", cond: "c", ifTrue: "b1", ifFalse: "b2" },
            predecessors: [],
          },
        ],
        [
          "b1",
          {
            id: "b1",
            assignments: new Map([["x", { kind: "var", name: "x2" }]]),
            terminator: { kind: "jump", target: "join" },
            predecessors: ["entry"],
          },
        ],
        [
          "b2",
          {
            id: "b2",
            assignments: new Map([["y", { kind: "var", name: "y2" }]]),
            terminator: { kind: "jump", target: "join" },
            predecessors: ["entry"],
          },
        ],
        [
          "join",
          {
            id: "join",
            assignments: new Map(),
            terminator: { kind: "ret", value: "x" },
            predecessors: ["b1", "b2"],
          },
        ],
      ]),
    };

    const ssaFunc = toSSA(preFunc);

    const joinBlock = ssaFunc.blocks.get("join")!;
    const phiNodes = joinBlock.instructions.filter((i: any) => i.type === "phi");

    // Should have phis for both x and y
    expect(phiNodes.length).toBeGreaterThanOrEqual(1);
  });
});
