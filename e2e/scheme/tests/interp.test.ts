/**
 * Smoke test for the interpreter.
 *
 * The IR here is built by hand, not produced by the front end. That is deliberate: if the first
 * thing you run through the interpreter is the output of a lowering you just wrote, a bug in either
 * one looks the same. Hand-built IR pins the interpreter on its own.
 */

import { describe, it, expect } from "vitest";
import { run, show, V_INT, SchemeRuntimeError, type Module, type Value } from "../interp.ts";
import { toSSA } from "../../../src/ssa/braun.ts";
import { schemeOps, type SchemeNode } from "../ir.ts";
import type { BasicBlock, SSAFunction, BlockId, Terminator, Instruction } from "../../../src/ssa/ir.ts";

function block(
  id: BlockId,
  instructions: Instruction<SchemeNode>[],
  terminator: Terminator<SchemeNode>,
): BasicBlock<SchemeNode> {
  return { id, instructions, terminator, predecessors: [], successors: [] };
}

function mod(fns: SSAFunction<SchemeNode>[]): Module {
  return new Map(fns.map((f) => [f.id, f]));
}

const entry = (id: string): SSAFunction<SchemeNode> => ({
  id,
  entry: "entry",
  blocks: new Map(),
});

describe("interpreter: arithmetic", () => {
  it("computes (+ 1 2)", () => {
    const f = entry("main");
    f.blocks.set(
      "entry",
      block(
        "entry",
        [
          { type: "const", dest: "a", value: 1 },
          { type: "const", dest: "b", value: 2 },
          { type: "prim", dest: "r", op: "add", args: ["a", "b"] },
        ],
        { type: "ret", value: "r" },
      ),
    );

    const result = run(mod([f]), "main");
    expect(result.value).toEqual(V_INT(3));
    expect(result.stats.instructions).toBe(3);
    expect(result.stats.allocs).toBe(0);
  });

  it("computes a nested expression", () => {
    // (* (+ 1 2) (- 10 4))
    const f = entry("main");
    f.blocks.set(
      "entry",
      block(
        "entry",
        [
          { type: "const", dest: "one", value: 1 },
          { type: "const", dest: "two", value: 2 },
          { type: "prim", dest: "sum", op: "add", args: ["one", "two"] },
          { type: "const", dest: "ten", value: 10 },
          { type: "const", dest: "four", value: 4 },
          { type: "prim", dest: "diff", op: "sub", args: ["ten", "four"] },
          { type: "prim", dest: "prod", op: "mul", args: ["sum", "diff"] },
        ],
        { type: "ret", value: "prod" },
      ),
    );

    expect(run(mod([f]), "main").value).toEqual(V_INT(18));
  });

  it("compares", () => {
    const f = entry("main");
    f.blocks.set(
      "entry",
      block(
        "entry",
        [
          { type: "const", dest: "a", value: 1 },
          { type: "const", dest: "b", value: 2 },
          { type: "prim", dest: "r", op: "lt", args: ["a", "b"] },
        ],
        { type: "ret", value: "r" },
      ),
    );

    expect(run(mod([f]), "main").value).toEqual({ tag: "bool", b: true });
  });
});

describe("interpreter: control flow", () => {
  it("follows a branch", () => {
    const f = entry("main");
    f.blocks.set(
      "entry",
      block(
        "entry",
        [
          { type: "const", dest: "c", value: true },
          { type: "const", dest: "x", value: 10 },
        ],
        { type: "branch", cond: "c", ifTrue: "yes", ifFalse: "no" },
      ),
    );
    f.blocks.set("yes", block("yes", [], { type: "ret", value: "x" }));
    f.blocks.set("no", block("no", [{ type: "const", dest: "y", value: 20 }], { type: "ret", value: "y" }));

    expect(run(mod([f]), "main").value).toEqual(V_INT(10));
  });

  it("runs a hand-written loop", () => {
    // Sum 1..n with a phi, no function calls.
    const f = entry("main");
    f.blocks.set(
      "entry",
      block("entry", [{ type: "const", dest: "zero", value: 0 }], { type: "jump", target: "test" }),
    );
    f.blocks.set(
      "test",
      block(
        "test",
        [
          {
            type: "phi",
            dest: "i",
            incoming: [
              ["entry", "zero"],
              ["body", "next"],
            ],
          },
          {
            type: "phi",
            dest: "acc",
            incoming: [
              ["entry", "zero"],
              ["body", "acc2"],
            ],
          },
          { type: "const", dest: "limit", value: 5 },
          { type: "prim", dest: "done", op: "ge", args: ["i", "limit"] },
        ],
        { type: "branch", cond: "done", ifTrue: "exit", ifFalse: "body" },
      ),
    );
    f.blocks.set(
      "body",
      block(
        "body",
        [
          { type: "const", dest: "one", value: 1 },
          { type: "prim", dest: "next", op: "add", args: ["i", "one"] },
          { type: "prim", dest: "acc2", op: "add", args: ["acc", "i"] },
        ],
        { type: "jump", target: "test" },
      ),
    );
    f.blocks.set("exit", block("exit", [], { type: "ret", value: "acc" }));

    // 0+1+2+3+4
    expect(run(mod([f]), "main").value).toEqual(V_INT(10));
  });
});

describe("interpreter: calls", () => {
  it("calls a top-level function", () => {
    const main = entry("main");
    main.blocks.set(
      "entry",
      block(
        "entry",
        [
          { type: "func-ref", dest: "f", fn: "add1" },
          { type: "const", dest: "a", value: 41 },
          { type: "call", dest: "r", callee: "f", args: ["a"] },
        ],
        { type: "ret", value: "r" },
      ),
    );

    const add1 = entry("add1");
    add1.blocks.set(
      "entry",
      block(
        "entry",
        [
          { type: "const", dest: "one", value: 1 },
          { type: "prim", dest: "r", op: "add", args: ["p0", "one"] },
        ],
        { type: "ret", value: "r" },
      ),
    );

    expect(run(mod([main, add1]), "main").value).toEqual(V_INT(42));
  });

  it("calls a closure and reads its captured value", () => {
    // (define (adder n) (lambda (x) (+ x n)))  -- the closure captures n
    const main = entry("main");
    main.blocks.set(
      "entry",
      block(
        "entry",
        [
          { type: "func-ref", dest: "adder", fn: "adder" },
          { type: "const", dest: "ten", value: 10 },
          { type: "call", dest: "add10", callee: "adder", args: ["ten"] },
          { type: "const", dest: "five", value: 5 },
          { type: "call", dest: "r", callee: "add10", args: ["five"] },
        ],
        { type: "ret", value: "r" },
      ),
    );

    // adder: make a closure over its argument.
    const adder = entry("adder");
    adder.blocks.set(
      "entry",
      block("entry", [{ type: "make-closure", dest: "c", fn: "lambda1", free: ["p0"] }], {
        type: "ret",
        value: "c",
      }),
    );

    // lambda1: read the captured n from f0, add the argument.
    const lambda1 = entry("lambda1");
    lambda1.blocks.set(
      "entry",
      block("entry", [{ type: "prim", dest: "r", op: "add", args: ["p0", "f0"] }], {
        type: "ret",
        value: "r",
      }),
    );

    expect(run(mod([main, adder, lambda1]), "main").value).toEqual(V_INT(15));
  });

  it("a tail call does not grow the stack", () => {
    // (define (loop n) (if (= n 0) 0 (loop (- n 1))))  -- 100000 iterations
    const main = entry("main");
    main.blocks.set(
      "entry",
      block(
        "entry",
        [
          { type: "const", dest: "n", value: 100_000 },
          { type: "func-ref", dest: "loop", fn: "loop" },
        ],
        { type: "tailcall", callee: "loop", args: ["n"] },
      ),
    );

    const loop = entry("loop");
    loop.blocks.set(
      "entry",
      block(
        "entry",
        [
          { type: "const", dest: "zero", value: 0 },
          { type: "prim", dest: "done", op: "num-eq", args: ["p0", "zero"] },
        ],
        { type: "branch", cond: "done", ifTrue: "base", ifFalse: "step" },
      ),
    );
    loop.blocks.set(
      "base",
      block("base", [{ type: "const", dest: "z", value: 0 }], { type: "ret", value: "z" }),
    );
    loop.blocks.set(
      "step",
      block(
        "step",
        [
          { type: "const", dest: "one", value: 1 },
          { type: "prim", dest: "next", op: "sub", args: ["p0", "one"] },
          { type: "func-ref", dest: "self", fn: "loop" },
        ],
        { type: "tailcall", callee: "self", args: ["next"] },
      ),
    );

    const result = run(mod([main, loop]), "main");
    expect(result.value).toEqual(V_INT(0));
    expect(result.stats.tailcalls).toBe(100_001);
  });
});

describe("interpreter: heap", () => {
  it("builds and takes apart a pair", () => {
    const f = entry("main");
    f.blocks.set(
      "entry",
      block(
        "entry",
        [
          { type: "const", dest: "a", value: 1 },
          { type: "const", dest: "b", value: 2 },
          { type: "cons", dest: "p", car: "a", cdr: "b" },
          { type: "car", dest: "x", pair: "p" },
        ],
        { type: "ret", value: "x" },
      ),
    );

    const result = run(mod([f]), "main");
    expect(result.value).toEqual(V_INT(1));
    expect(result.stats.allocs).toBe(1);
  });

  it("prints", () => {
    const f = entry("main");
    f.blocks.set(
      "entry",
      block(
        "entry",
        [
          { type: "const", dest: "a", value: 7 },
          { type: "print", value: "a" },
        ],
        { type: "ret", value: "a" },
      ),
    );

    expect(run(mod([f]), "main").output).toEqual(["7"]);
  });
});

describe("interpreter: it runs Braun's output", () => {
  it("runs a function with a real merge, after SSA construction", () => {
    //        entry
    //        /    \
    //      then   else
    //        \    /
    //       join -> return x
    // `x` is assigned in both arms, so Braun has to insert a phi — and the interpreter has to
    // honour it. This is the first test that exercises the two together.
    const pre: SSAFunction<SchemeNode> = {
      id: "main",
      entry: "entry",
      blocks: new Map([
        [
          "entry",
          block("entry", [{ type: "const", dest: "c", value: true }], {
            type: "branch",
            cond: "c",
            ifTrue: "then",
            ifFalse: "else",
          }),
        ],
        ["then", block("then", [{ type: "const", dest: "x", value: 10 }], { type: "jump", target: "join" })],
        ["else", block("else", [{ type: "const", dest: "x", value: 20 }], { type: "jump", target: "join" })],
        ["join", block("join", [], { type: "ret", value: "x" })],
      ]),
    };

    const ssa = toSSA(pre, schemeOps);
    const result = run(mod([ssa]), "main");

    expect(result.value).toEqual(V_INT(10));
  });
});

describe("interpreter: it refuses to run away", () => {
  it("aborts a program that never terminates", () => {
    const f = entry("main");
    f.blocks.set("entry", block("entry", [], { type: "jump", target: "entry" }));

    expect(() => run(mod([f]), "main", [], { maxSteps: 1000 })).toThrow(SchemeRuntimeError);
  });

  it("reports a branch on a non-boolean", () => {
    const f = entry("main");
    f.blocks.set(
      "entry",
      block("entry", [{ type: "const", dest: "c", value: 1 }], {
        type: "branch",
        cond: "c",
        ifTrue: "a",
        ifFalse: "b",
      }),
    );
    f.blocks.set("a", block("a", [], { type: "ret" }));
    f.blocks.set("b", block("b", [], { type: "ret" }));

    expect(() => run(mod([f]), "main")).toThrow(/branch condition must be a boolean/);
  });

  it("reports a call to a non-function", () => {
    const f = entry("main");
    f.blocks.set(
      "entry",
      block(
        "entry",
        [
          { type: "const", dest: "notafn", value: 3 },
          { type: "call", dest: "r", callee: "notafn", args: [] },
        ],
        { type: "ret", value: "r" },
      ),
    );

    expect(() => run(mod([f]), "main")).toThrow(/not a function/);
  });
});

describe("interpreter: show", () => {
  it("renders values", () => {
    expect(show(V_INT(3))).toBe("3");
    expect(show({ tag: "bool", b: true })).toBe("#t");
    expect(show({ tag: "void" })).toBe("#<void>");
    expect(
      show({ tag: "pair", car: V_INT(1), cdr: { tag: "pair", car: V_INT(2), cdr: { tag: "void" } } }),
    ).toBe("(1 2)");
    expect(show({ tag: "pair", car: V_INT(1), cdr: V_INT(2) })).toBe("(1 . 2)");
  });
});
