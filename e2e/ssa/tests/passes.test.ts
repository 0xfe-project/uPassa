/**
 * Tests for SSA optimization passes
 */

import { describe, it, expect } from "vitest";
import { dcePass, sccpPass, simplifyCFGPass, copyPropPass, type TestInstr } from "../passes.js";
import type { SSAFunction, BasicBlock } from "../../../src/ssa/ir.js";

/**
 * Helper: create a test function
 */
function makeFunction(blocks: Map<string, BasicBlock<TestInstr>>, entry: string): SSAFunction<TestInstr> {
  return {
    id: "test",
    blocks,
    entry,
  };
}

/**
 * Helper: create a basic block
 */
function makeBlock(
  id: string,
  instructions: any[],
  terminator: any,
  predecessors: string[] = [],
  successors: string[] = [],
): BasicBlock<TestInstr> {
  return {
    id,
    instructions,
    terminator,
    predecessors,
    successors,
  };
}

describe("DCE Pass", () => {
  it("removes unused instructions", () => {
    const blocks = new Map([
      [
        "entry",
        makeBlock(
          "entry",
          [
            { type: "const", dest: "x", value: 42 },
            { type: "const", dest: "y", value: 10 },
            { type: "add", dest: "dead", left: "x", right: "y" },
            { type: "const", dest: "result", value: 1 },
          ],
          { type: "ret", value: "result" },
          [],
          [],
        ),
      ],
    ]);

    const func = makeFunction(blocks, "entry");

    const usedef = {
      getUses: (v: string) => {
        if (v === "x") return ["add@1"];
        if (v === "y") return ["add@1"];
        if (v === "dead") return []; // No uses
        if (v === "result") return ["ret"];
        return [];
      },
    };

    const result = dcePass.run(func, { usedef: usedef as any });
    expect(result.changed).toBe(true);

    const entry = func.blocks.get("entry")!;
    expect(entry.instructions.length).toBeLessThan(4); // dead add removed
    expect(entry.instructions.find((i: any) => i.dest === "dead")).toBeUndefined();
  });

  it("keeps all used instructions", () => {
    const blocks = new Map([
      [
        "entry",
        makeBlock(
          "entry",
          [
            { type: "const", dest: "x", value: 42 },
            { type: "const", dest: "y", value: 10 },
            { type: "add", dest: "z", left: "x", right: "y" },
          ],
          { type: "ret", value: "z" },
          [],
          [],
        ),
      ],
    ]);

    const func = makeFunction(blocks, "entry");

    const usedef = {
      getUses: (v: string) => {
        if (v === "x") return ["add@1"];
        if (v === "y") return ["add@1"];
        if (v === "z") return ["ret"];
        return [];
      },
    };

    const result = dcePass.run(func, { usedef: usedef as any });
    expect(result.changed).toBe(false); // All values are used
  });
});

describe("SCCP Pass", () => {
  it("folds constant addition", () => {
    const blocks = new Map([
      [
        "entry",
        makeBlock(
          "entry",
          [
            { type: "const", dest: "x", value: 10 },
            { type: "const", dest: "y", value: 32 },
            { type: "add", dest: "z", left: "x", right: "y" },
          ],
          { type: "ret", value: "z" },
          [],
          [],
        ),
      ],
    ]);

    const func = makeFunction(blocks, "entry");
    const result = sccpPass.run(func, {});

    expect(result.changed).toBe(true);

    const entry = func.blocks.get("entry")!;
    const zInstr = entry.instructions.find((i: any) => i.dest === "z") as any;
    expect(zInstr.type).toBe("const");
    expect(zInstr.value).toBe(42);
  });

  it("folds constant multiplication", () => {
    const blocks = new Map([
      [
        "entry",
        makeBlock(
          "entry",
          [
            { type: "const", dest: "x", value: 6 },
            { type: "const", dest: "y", value: 7 },
            { type: "mul", dest: "z", left: "x", right: "y" },
          ],
          { type: "ret", value: "z" },
          [],
          [],
        ),
      ],
    ]);

    const func = makeFunction(blocks, "entry");
    const result = sccpPass.run(func, {});

    expect(result.changed).toBe(true);

    const entry = func.blocks.get("entry")!;
    const zInstr = entry.instructions.find((i: any) => i.dest === "z") as any;
    expect(zInstr.type).toBe("const");
    expect(zInstr.value).toBe(42);
  });

  it("propagates through mov", () => {
    const blocks = new Map([
      [
        "entry",
        makeBlock(
          "entry",
          [
            { type: "const", dest: "x", value: 42 },
            { type: "mov", dest: "y", src: "x" },
          ],
          { type: "ret", value: "y" },
          [],
          [],
        ),
      ],
    ]);

    const func = makeFunction(blocks, "entry");
    const result = sccpPass.run(func, {});

    expect(result.changed).toBe(true);

    const entry = func.blocks.get("entry")!;
    const yInstr = entry.instructions.find((i: any) => i.dest === "y") as any;
    expect(yInstr.type).toBe("const");
    expect(yInstr.value).toBe(42);
  });

  it("does not fold non-constant operations", () => {
    const blocks = new Map([
      [
        "entry",
        makeBlock(
          "entry",
          [
            { type: "const", dest: "x", value: 10 },
            { type: "add", dest: "z", left: "x", right: "param" },
          ],
          { type: "ret", value: "z" },
          [],
          [],
        ),
      ],
    ]);

    const func = makeFunction(blocks, "entry");
    const result = sccpPass.run(func, {});

    expect(result.changed).toBe(false);
  });
});

describe("SimplifyCFG Pass", () => {
  it("removes unreachable blocks", () => {
    const blocks = new Map([
      [
        "entry",
        makeBlock("entry", [{ type: "const", dest: "x", value: 42 }], { type: "ret", value: "x" }, [], []),
      ],
      [
        "unreachable",
        makeBlock("unreachable", [{ type: "const", dest: "y", value: 10 }], { type: "unreachable" }, [], []),
      ],
    ]);

    const func = makeFunction(blocks, "entry");
    const result = simplifyCFGPass.run(func, {});

    expect(result.changed).toBe(true);
    expect(func.blocks.has("unreachable")).toBe(false);
    expect(func.blocks.has("entry")).toBe(true);
  });

  it("keeps reachable blocks in branches", () => {
    const blocks = new Map([
      [
        "entry",
        makeBlock(
          "entry",
          [{ type: "const", dest: "cond", value: 1 }],
          { type: "branch", cond: "cond", ifTrue: "then", ifFalse: "else" },
          [],
          ["then", "else"],
        ),
      ],
      [
        "then",
        makeBlock(
          "then",
          [{ type: "const", dest: "x", value: 1 }],
          { type: "ret", value: "x" },
          ["entry"],
          [],
        ),
      ],
      [
        "else",
        makeBlock(
          "else",
          [{ type: "const", dest: "y", value: 2 }],
          { type: "ret", value: "y" },
          ["entry"],
          [],
        ),
      ],
    ]);

    const func = makeFunction(blocks, "entry");
    const result = simplifyCFGPass.run(func, {});

    expect(result.changed).toBe(false); // All blocks reachable
    expect(func.blocks.size).toBe(3);
  });
});

describe("CopyProp Pass", () => {
  it("propagates mov instructions", () => {
    const blocks = new Map([
      [
        "entry",
        makeBlock(
          "entry",
          [
            { type: "const", dest: "x", value: 42 },
            { type: "mov", dest: "y", src: "x" },
            { type: "add", dest: "z", left: "y", right: "y" },
          ],
          { type: "ret", value: "z" },
          [],
          [],
        ),
      ],
    ]);

    const func = makeFunction(blocks, "entry");

    const usedef = {
      getUses: (v: string) => {
        if (v === "x") return ["mov@1"];
        if (v === "y") return ["add@2", "add@2"];
        if (v === "z") return ["ret"];
        return [];
      },
    };

    const result = copyPropPass.run(func, { usedef: usedef as any });
    expect(result.changed).toBe(true);

    const entry = func.blocks.get("entry")!;
    const addInstr = entry.instructions.find((i: any) => i.dest === "z") as any;
    expect(addInstr.left).toBe("x");
    expect(addInstr.right).toBe("x");
  });

  it("handles phi nodes", () => {
    const blocks = new Map([
      [
        "entry",
        makeBlock(
          "entry",
          [
            { type: "const", dest: "a", value: 1 },
            { type: "mov", dest: "b", src: "a" },
            { type: "phi", dest: "x", incoming: [["entry", "b"]] },
          ],
          { type: "ret", value: "x" },
          [],
          [],
        ),
      ],
    ]);

    const func = makeFunction(blocks, "entry");

    const usedef = {
      getUses: (v: string) => {
        if (v === "a") return ["mov@1"];
        if (v === "b") return ["phi@2"];
        if (v === "x") return ["ret"];
        return [];
      },
    };

    const result = copyPropPass.run(func, { usedef: usedef as any });
    expect(result.changed).toBe(true);

    const entry = func.blocks.get("entry")!;
    const phiInstr = entry.instructions.find((i: any) => i.type === "phi") as any;
    expect(phiInstr.incoming[0][1]).toBe("a");
  });
});
