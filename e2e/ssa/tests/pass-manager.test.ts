/**
 * Tests for SSA pass manager
 */

import { describe, it, expect } from "vitest";
import { PassManager, runPasses } from "../../../src/ssa/pass-manager.js";
import { ssaPass, transformPass } from "../../../src/ssa/pass.js";
import type { SSAFunction } from "../../../src/ssa/ir.js";
import type { TestInstr } from "../passes.js";

function makeTestFunction(): SSAFunction<TestInstr> {
  return {
    id: "test",
    entry: "entry",
    blocks: new Map([
      [
        "entry",
        {
          id: "entry",
          instructions: [
            { type: "const", dest: "x", value: 10 },
            { type: "const", dest: "y", value: 32 },
            { type: "add", dest: "z", left: "x", right: "y" },
          ],
          terminator: { type: "ret", value: "z" },
          predecessors: [],
          successors: [],
        },
      ],
    ]),
  };
}

describe("PassManager", () => {
  it("runs a single pass", () => {
    const manager = new PassManager<TestInstr>();

    let runCount = 0;
    const testPass = transformPass<TestInstr>({
      name: "test",
      transform: (func) => {
        runCount++;
        return false; // No changes, should run once
      },
    });

    const func = makeTestFunction();
    manager.runOnFunction(func, [testPass]);

    expect(runCount).toBe(1);
  });

  it("runs multiple passes in order", () => {
    const manager = new PassManager<TestInstr>();

    const order: string[] = [];

    const pass1 = transformPass<TestInstr>({
      name: "pass1",
      transform: (func) => {
        order.push("pass1");
        return false;
      },
    });

    const pass2 = transformPass<TestInstr>({
      name: "pass2",
      transform: (func) => {
        order.push("pass2");
        return false;
      },
    });

    const pass3 = transformPass<TestInstr>({
      name: "pass3",
      transform: (func) => {
        order.push("pass3");
        return false;
      },
    });

    const func = makeTestFunction();
    manager.runOnFunction(func, [pass1, pass2, pass3]);

    expect(order).toEqual(["pass1", "pass2", "pass3"]);
  });

  it("computes required analyses", () => {
    const manager = new PassManager<TestInstr>();

    let receivedAnalyses: any = null;

    const analysisPass = ssaPass<TestInstr>({
      name: "test",
      requires: ["domtree", "usedef"],
      invalidates: [],
      run: (func, analyses) => {
        receivedAnalyses = analyses;
        return { changed: false };
      },
    });

    const func = makeTestFunction();
    manager.runOnFunction(func, [analysisPass]);

    // Should have computed required analyses
    expect(receivedAnalyses).toBeDefined();
    expect(receivedAnalyses.domtree).toBeDefined();
    expect(receivedAnalyses.usedef).toBeDefined();
  });

  it("invalidates analyses after transform", () => {
    const manager = new PassManager<TestInstr>();

    const analyses: any[] = [];
    let pass1Runs = 0;

    // First pass requires and invalidates usedef (changes only on first run)
    const pass1 = ssaPass<TestInstr>({
      name: "pass1",
      requires: ["usedef"],
      invalidates: ["usedef"],
      run: (func, a) => {
        pass1Runs++;
        analyses.push({ pass: "pass1", usedef: a.usedef });
        return { changed: pass1Runs === 1 };
      },
    });

    // Second pass requires usedef again
    const pass2 = ssaPass<TestInstr>({
      name: "pass2",
      requires: ["usedef"],
      invalidates: [],
      run: (func, a) => {
        analyses.push({ pass: "pass2", usedef: a.usedef });
        return { changed: false };
      },
    });

    const func = makeTestFunction();
    manager.runOnFunction(func, [pass1, pass2]);

    // Should have 4 entries: pass1(iter1), pass2(iter1), pass1(iter2), pass2(iter2)
    expect(analyses).toHaveLength(4);

    // Within iteration 1, pass1 invalidates usedef so pass2 sees a fresh one
    const iter1Pass1 = analyses[0].usedef;
    const iter1Pass2 = analyses[1].usedef;
    expect(iter1Pass1).toBeDefined();
    expect(iter1Pass2).toBeDefined();
    expect(iter1Pass1).not.toBe(iter1Pass2);
  });

  it("reuses cached analyses when not invalidated", () => {
    const manager = new PassManager<TestInstr>();

    const analyses: any[] = [];

    // Pass that preserves all analyses
    const pass1 = ssaPass<TestInstr>({
      name: "pass1",
      requires: ["domtree"],
      invalidates: [],
      preservesAll: true,
      run: (func, a) => {
        analyses.push({ pass: "pass1", domtree: a.domtree });
        return { changed: false };
      },
    });

    const pass2 = ssaPass<TestInstr>({
      name: "pass2",
      requires: ["domtree"],
      invalidates: [],
      run: (func, a) => {
        analyses.push({ pass: "pass2", domtree: a.domtree });
        return { changed: false };
      },
    });

    const func = makeTestFunction();
    manager.runOnFunction(func, [pass1, pass2]);

    // Should reuse the same domtree
    expect(analyses).toHaveLength(2);
    expect(analyses[0].domtree).toBe(analyses[1].domtree);
  });

  it("runs to fixed point when changes occur", () => {
    const manager = new PassManager<TestInstr>({ maxIterations: 10 });

    let runCount = 0;

    // Pass that changes on first run only
    const pass = transformPass<TestInstr>({
      name: "converge",
      transform: (func) => {
        runCount++;
        return runCount === 1; // Only first run changes
      },
    });

    const func = makeTestFunction();
    manager.runOnFunction(func, [pass]);

    // Should run twice: first changes, second sees no change
    expect(runCount).toBe(2);
  });

  it("handles shouldRun predicate", () => {
    const manager = new PassManager<TestInstr>();

    let runCount = 0;

    const conditionalPass = ssaPass<TestInstr>({
      name: "conditional",
      requires: [],
      invalidates: [],
      shouldRun: (func) => {
        // Only run if function has more than 2 instructions
        const entry = func.blocks.get(func.entry)!;
        return entry.instructions.length > 2;
      },
      run: (func) => {
        runCount++;
        return { changed: false };
      },
    });

    // Test with function that has 3 instructions
    const func1 = makeTestFunction();
    manager.runOnFunction(func1, [conditionalPass]);
    expect(runCount).toBe(1);

    // Test with function that has 1 instruction
    runCount = 0;
    const func2: SSAFunction<TestInstr> = {
      id: "small",
      entry: "entry",
      blocks: new Map([
        [
          "entry",
          {
            id: "entry",
            instructions: [{ type: "const", dest: "x", value: 42 }],
            terminator: { type: "ret", value: "x" },
            predecessors: [],
            successors: [],
          },
        ],
      ]),
    };

    manager.runOnFunction(func2, [conditionalPass]);
    expect(runCount).toBe(0); // Should skip
  });

  it("collects stats from passes", () => {
    const manager = new PassManager<TestInstr>({ collectStats: true });

    const passWithStats = ssaPass<TestInstr>({
      name: "stats-pass",
      requires: [],
      invalidates: [],
      run: (func) => {
        return {
          changed: true,
          stats: {
            instructionsRemoved: 5,
            blocksRemoved: 2,
          },
        };
      },
    });

    const func = makeTestFunction();
    manager.runOnFunction(func, [passWithStats]);

    const stats = manager.getStats();
    expect(stats.length).toBeGreaterThan(0);

    const passStats = stats.find((s) => s.passName === "stats-pass");
    expect(passStats).toBeDefined();
    expect(passStats!.stats).toEqual({
      instructionsRemoved: 5,
      blocksRemoved: 2,
    });
  });

  it("stops at max iterations", () => {
    const manager = new PassManager<TestInstr>({ maxIterations: 3 });

    let runCount = 0;

    // Pass that always changes (never converges)
    const infinitePass = transformPass<TestInstr>({
      name: "infinite",
      transform: (func) => {
        runCount++;
        return true; // Always changes
      },
    });

    const func = makeTestFunction();
    manager.runOnFunction(func, [infinitePass]);

    // Should stop at max iterations (3)
    expect(runCount).toBe(3);
  });

  it("uses runPasses convenience function", () => {
    let runCount = 0;

    const testPass = transformPass<TestInstr>({
      name: "test",
      transform: (func) => {
        runCount++;
        return false;
      },
    });

    const func = makeTestFunction();
    runPasses(func, [testPass]);

    expect(runCount).toBe(1);
  });
});
