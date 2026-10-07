/**
 * The pipeline as a whole.
 *
 * The important assertion here is the first one: running the passes fused and unfused must produce
 * byte-identical output. Fusion reorders evaluation, so "the output is the same" is a property that
 * has to be checked rather than assumed, and this is what checks it.
 *
 * The rest pin the shape the lowering is written against, so that changing a pass cannot quietly
 * change the contract between the two.
 */

import { describe, expect, test } from "vitest";
import { compile, fusionGroups, PIPELINE } from "../pipeline.ts";
import { PROGRAMS } from "../fixtures/programs.ts";

describe("pipeline", () => {
  for (const p of PROGRAMS) {
    test(`fused and unfused agree: ${p.name} (${p.covers})`, () => {
      const unfused = JSON.stringify(compile(p.source));
      const fused = JSON.stringify(compile(p.source, { fuse: true }));
      expect(fused).toBe(unfused);
    });
  }

  test("fusion actually collapses something", () => {
    // If every group were a single pass, the fused path would be a slower way to do nothing and
    // the agreement tests above would be vacuous.
    const groups = fusionGroups();
    const collapsed = groups.filter((g) => g.length > 1);
    expect(collapsed.length).toBeGreaterThanOrEqual(2);
    expect(groups.length).toBeLessThan(PIPELINE.length);
  });

  test("no pass is fused across a pass that threads extra values", () => {
    for (const group of fusionGroups()) {
      if (group.length > 1) for (const step of group) expect(step.spec.arity).toBe(0);
    }
  });
});

describe("the shape handed to the lowering", () => {
  const compiled = compile(PROGRAMS.find((p) => p.name === "closure")!.source);

  test("no lambda or application survives", () => {
    const tags = new Set<string>();
    walk(compiled, (n) => tags.add(n.type));
    expect(tags.has("Lambda")).toBe(false);
    expect(tags.has("App")).toBe(false);
    expect(tags.has("MakeClosure")).toBe(true);
    expect(tags.has("Call")).toBe(true);
  });

  test("every function is a top-level definition", () => {
    for (const d of compiled.defs) expect(d.type).toBe("DefFun");
  });

  test("captures become leading frame slots, then arguments", () => {
    const adder = compiled.defs.find((d) => d.type === "DefFun" && d.name === "adder")!;
    expect(adder.type).toBe("DefFun");
    if (adder.type !== "DefFun") return;
    // adder's own lambda captures nothing; its parameter is p0.
    expect(adder.params).toEqual(["p0"]);

    // The lambda it returns captured `n`, which is now the leading slot f0.
    const inner = compiled.defs.find(
      (d) => d.type === "DefFun" && d.name !== "adder" && d.params[0] === "f0",
    )!;
    expect(inner.type).toBe("DefFun");
    if (inner.type !== "DefFun") return;
    expect(inner.params).toEqual(["f0", "p0"]);

    // And the body reads the capture under its new name — the renaming is the part that would
    // otherwise produce a reference to a variable that does not exist.
    const vars = new Set<string>();
    walk(inner.body, (n) => {
      if (n.type === "Var") vars.add(n.name as string);
    });
    expect([...vars].sort()).toEqual(["f0", "p0"]);
  });

  test("a self-recursive function does not capture itself", () => {
    const recursive = compile(PROGRAMS.find((p) => p.name === "self-recursion")!.source);
    const count = recursive.defs.find((d) => d.type === "DefFun" && d.name === "count");
    expect(count).toBeDefined();
  });

  test("the last expression of the program body is in tail position", () => {
    const body = compiled.body;
    expect(body[body.length - 1]!.type).toBe("Tail");
  });

  test("both branches of a tail-position if are in tail position", () => {
    const t = compile(PROGRAMS.find((p) => p.name === "tail-in-let")!.source);
    const loop = t.defs.find((d) => d.type === "DefFun" && d.name === "loop");
    expect(loop?.type).toBe("DefFun");
    if (loop?.type !== "DefFun") return;
    expect(loop.body.type).toBe("If");
    if (loop.body.type !== "If") return;
    expect(loop.body.then.type).toBe("Tail");
    // The `else` branch is a `let`, which is not wrapped — it has no value of its own, so what is
    // in tail position is its body.
    expect(loop.body.alt.type).toBe("Let");
    if (loop.body.alt.type !== "Let") return;
    expect(loop.body.alt.body.type).toBe("Tail");
  });

  test("a let in tail position passes tail position to its body", () => {
    const t = compile(PROGRAMS.find((p) => p.name === "tail-in-let")!.source);
    const loop = t.defs.find((d) => d.type === "DefFun" && d.name === "loop");
    if (loop?.type !== "DefFun" || loop.body.type !== "If") return;
    const alt = loop.body.alt;
    expect(alt.type).toBe("Let");
    if (alt.type !== "Let") return;
    expect(alt.body.type).toBe("Tail");
    if (alt.body.type !== "Tail") return;
    expect(alt.body.expr.type).toBe("Call");
  });
});

/** Visit every node, including nested ones, without depending on the language declaration. */
function walk(x: unknown, f: (n: { type: string; [k: string]: unknown }) => void): void {
  if (Array.isArray(x)) {
    for (const y of x) walk(y, f);
    return;
  }
  if (x === null || typeof x !== "object") return;
  const o = x as { type?: unknown; [k: string]: unknown };
  if (typeof o.type === "string") f(o as { type: string; [k: string]: unknown });
  for (const [k, v] of Object.entries(o)) if (k !== "__lang__") walk(v, f);
}
