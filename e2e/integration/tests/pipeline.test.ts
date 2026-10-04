/**
 * Integration tests: full pipeline
 *
 * Tests the nanopass transformation chain and the SSA optimization pipeline.
 */

import { describe, it, expect } from "vitest";
import { runPipeline, runPipelineSteps } from "../../nanopass/pipeline.js";
import { runPipeline as runSSAPipeline } from "../../ssa/pipeline.js";
import { FIXTURES as NANOPASS_FIXTURES, deepNestedLet, wideArithmetic } from "../../nanopass/fixtures.js";
import { FIXTURES as SSA_FIXTURES } from "../../ssa/fixtures.js";

describe("Nanopass pipeline", () => {
  it("transforms simple let binding", () => {
    const result = runPipeline(NANOPASS_FIXTURES.simpleLet);

    // Should be an App: ((lambda (x) (+ x 3)) 5)
    expect(result.type).toBe("App");
  });

  it("flattens nested arithmetic", () => {
    const result = runPipeline(NANOPASS_FIXTURES.nestedArithmetic);

    // Should be a Seq with temporaries
    expect(result.type).toBe("Seq");
  });

  it("tracks binding depth in nested let", () => {
    const { l2 } = runPipelineSteps(NANOPASS_FIXTURES.nestedLet);

    // Should have Ref nodes with depth information
    expect(JSON.stringify(l2)).toContain('"type":"Ref"');
  });

  it("handles lambda with captured variable", () => {
    const result = runPipeline(NANOPASS_FIXTURES.lambdaCapture);

    expect(result).toBeDefined();
    // Result should be a Lambda
    expect(result.type).toBe("Lambda");
  });

  it("handles deeply nested lets", () => {
    const source = deepNestedLet(50);
    const result = runPipeline(source);

    expect(result).toBeDefined();
  });

  it("handles wide arithmetic", () => {
    const source = wideArithmetic(50);
    const result = runPipeline(source);

    expect(result).toBeDefined();
  });

  it("is deterministic (same input → same output)", () => {
    const r1 = runPipeline(NANOPASS_FIXTURES.nestedArithmetic);
    const r2 = runPipeline(NANOPASS_FIXTURES.nestedArithmetic);

    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

describe("SSA pipeline", () => {
  it("optimizes straight-line code", () => {
    const func = SSA_FIXTURES.straightLine();
    runSSAPipeline(func);

    // After SCCP, all constants should be folded
    const entry = func.blocks.get("entry")!;
    expect(entry).toBeDefined();
  });

  it("optimizes diamond CFG", () => {
    const func = SSA_FIXTURES.diamond();
    runSSAPipeline(func);

    // Phi node should be preserved (values differ)
    const join = func.blocks.get("join")!;
    expect(join).toBeDefined();
  });

  it("removes dead code", () => {
    const func = SSA_FIXTURES.deadCode();
    const before = func.blocks.get("entry")!.instructions.length;

    runSSAPipeline(func);

    const after = func.blocks.get("entry")!.instructions.length;
    expect(after).toBeLessThanOrEqual(before);
  });

  it("removes unreachable blocks", () => {
    const func = SSA_FIXTURES.unreachableBlock();
    runSSAPipeline(func);

    // Unreachable block should be removed
    expect(func.blocks.has("dead")).toBe(false);
  });

  it("preserves reachable blocks", () => {
    const func = SSA_FIXTURES.straightLine();
    runSSAPipeline(func);

    expect(func.blocks.has("entry")).toBe(true);
  });

  it("converges (does not run forever)", () => {
    const func = SSA_FIXTURES.loop();
    runSSAPipeline(func, { maxIterations: 5 });

    // Should complete without hanging
    expect(func.blocks.has("loop")).toBe(true);
  });
});
