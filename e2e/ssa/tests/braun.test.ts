/**
 * Braun SSA construction.
 *
 * The algorithm's job: take a function whose operands are variable names, where a variable may be
 * assigned many times, and produce a function where every value is assigned once and merge points
 * carry phi nodes. These tests pin the cases where that is easy to get subtly wrong.
 *
 * Every result is also run through `verifySSA`, so a construction that produces the right *shape*
 * but broken SSA still fails.
 */

import { describe, it, expect } from "vitest";
import { toSSA } from "../../../src/ssa/braun.ts";
import { verifySSA } from "../../../src/ssa/verify.ts";
import { block, fn, testOps, phisOf, bodyOf, destOf, type TestInstr } from "../ir.ts";

/** Construct SSA, then verify it. */
function build(f: ReturnType<typeof fn>) {
  const out = toSSA(f, testOps);
  verifySSA(out, testOps);
  return out;
}

describe("braun: one definition", () => {
  it("renames the definition and its uses consistently", () => {
    const f = fn("entry", [
      block(
        "entry",
        [
          { type: "const", dest: "x", value: 7 },
          { type: "copy", dest: "y", src: "x" },
        ],
        { type: "ret", value: "y" },
      ),
    ]);

    const out = build(f);
    const body = bodyOf(out, "entry");
    const copy = body.find((i) => i.type === "copy")!;

    // `x` and `y` must both be renamed, and the copy must read the renamed `x`.
    const constDest = destOf(body.find((i) => i.type === "const")!)!;
    expect(constDest).not.toBe("x");
    expect(copy.type).toBe("copy");
    expect(copy.src).toBe(constDest);
    expect(destOf(copy)).not.toBe("y");
  });
});

describe("braun: several definitions in one block", () => {
  it("keeps the second assignment distinct from the first", () => {
    // x = 1; x = 2; y = x   -- y must read the second x, not the first.
    const f = fn("entry", [
      block(
        "entry",
        [
          { type: "const", dest: "x", value: 1 },
          { type: "const", dest: "x", value: 2 },
          { type: "copy", dest: "y", src: "x" },
        ],
        { type: "ret", value: "y" },
      ),
    ]);

    const out = build(f);
    const body = bodyOf(out, "entry");
    const consts = body.filter((i) => i.type === "const");
    const copy = body.find((i) => i.type === "copy")!;

    expect(consts).toHaveLength(2);
    expect(destOf(consts[0]!)!).not.toBe(destOf(consts[1]!)!);
    expect(copy.src).toBe(destOf(consts[1]!)!);
  });

  it("reads the old value in x = x + 1", () => {
    // Order matters: the read of `x` on the right must resolve to the version from before.
    const f = fn("entry", [
      block(
        "entry",
        [
          { type: "const", dest: "x", value: 1 },
          { type: "const", dest: "one", value: 1 },
          { type: "add", dest: "x", left: "x", right: "one" },
          { type: "copy", dest: "y", src: "x" },
        ],
        { type: "ret", value: "y" },
      ),
    ]);

    const out = build(f);
    const body = bodyOf(out, "entry");
    const add = body.find((i) => i.type === "add")!;
    const firstX = destOf(body.filter((i) => i.type === "const")[0]!)!;
    const copy = body.find((i) => i.type === "copy")!;

    expect(add.type).toBe("add");
    // The add reads the x from before it...
    expect(add.left).toBe(firstX);
    // ...and defines a new one, which the copy reads.
    expect(destOf(add)).not.toBe(firstX);
    expect(copy.src).toBe(destOf(add));
  });

  it("handles an instruction with no destination", () => {
    const f = fn("entry", [
      block(
        "entry",
        [
          { type: "const", dest: "x", value: 1 },
          { type: "print", value: "x" },
        ],
        { type: "ret", value: "x" },
      ),
    ]);

    const out = build(f);
    const body = bodyOf(out, "entry");
    const print = body.find((i) => i.type === "print")!;
    const constDest = destOf(body.find((i) => i.type === "const")!)!;

    expect(print.type).toBe("print");
    expect(print.value).toBe(constDest);
  });
});

describe("braun: straight-line blocks", () => {
  it("needs no phi when a value flows through an unmodified block", () => {
    const f = fn("entry", [
      block("entry", [{ type: "const", dest: "x", value: 1 }], { type: "jump", target: "next" }),
      block("next", [{ type: "print", value: "x" }], { type: "ret", value: "x" }),
    ]);

    const out = build(f);
    expect(phisOf(out, "next")).toHaveLength(0);

    const print = bodyOf(out, "next").find((i) => i.type === "print")!;
    expect(print.value).toBe(destOf(bodyOf(out, "entry")[0] as TestInstr)!);
  });
});

describe("braun: a real merge needs a phi", () => {
  it("inserts a phi where two paths define the same variable differently", () => {
    //        entry
    //        /    \
    //      then   else
    //        \    /
    //        join
    const f = fn("entry", [
      block("entry", [{ type: "const", dest: "c", value: 1 }], {
        type: "branch",
        cond: "c",
        ifTrue: "then",
        ifFalse: "else",
      }),
      block("then", [{ type: "const", dest: "x", value: 10 }], { type: "jump", target: "join" }),
      block("else", [{ type: "const", dest: "x", value: 20 }], { type: "jump", target: "join" }),
      block("join", [], { type: "ret", value: "x" }),
    ]);

    const out = build(f);
    const phis = phisOf(out, "join");

    expect(phis).toHaveLength(1);
    expect(phis[0]!.from).toHaveLength(2);

    // The return must read the phi.
    expect(out.blocks.get("join")!.terminator).toMatchObject({ type: "ret", value: phis[0]!.dest });
  });

  it("inserts one phi per merged variable", () => {
    const f = fn("entry", [
      block("entry", [], { type: "branch", cond: "c", ifTrue: "then", ifFalse: "else" }),
      block(
        "then",
        [
          { type: "const", dest: "x", value: 10 },
          { type: "const", dest: "y", value: 1 },
        ],
        { type: "jump", target: "join" },
      ),
      block(
        "else",
        [
          { type: "const", dest: "x", value: 20 },
          { type: "const", dest: "y", value: 2 },
        ],
        { type: "jump", target: "join" },
      ),
      block("join", [{ type: "add", dest: "z", left: "x", right: "y" }], { type: "ret", value: "z" }),
    ]);

    const out = build(f);
    expect(phisOf(out, "join")).toHaveLength(2);
  });
});

describe("braun: trivial phis", () => {
  it("does not leave a phi when both paths carry the same value", () => {
    // `x` is defined once before the branch and never changed, so the merge point has nothing to
    // merge. A phi here would be `phi(x, x)` — redundant, and it would become a wasted copy later.
    const f = fn("entry", [
      block("entry", [{ type: "const", dest: "x", value: 1 }], {
        type: "branch",
        cond: "x",
        ifTrue: "then",
        ifFalse: "else",
      }),
      block("then", [], { type: "jump", target: "join" }),
      block("else", [], { type: "jump", target: "join" }),
      block("join", [], { type: "ret", value: "x" }),
    ]);

    const out = build(f);
    expect(phisOf(out, "join")).toHaveLength(0);

    const x = destOf(bodyOf(out, "entry")[0] as TestInstr)!;
    expect(out.blocks.get("join")!.terminator).toMatchObject({ type: "ret", value: x });
  });

  it("removes a phi whose only other operand is itself", () => {
    // In a loop, a variable that is not modified in the body produces `phi(entry: x, loop: <itself>)`.
    const f = fn("entry", [
      block("entry", [{ type: "const", dest: "x", value: 1 }], { type: "jump", target: "loop" }),
      block("loop", [{ type: "print", value: "x" }], {
        type: "branch",
        cond: "c",
        ifTrue: "loop",
        ifFalse: "exit",
      }),
      block("exit", [], { type: "ret", value: "x" }),
    ]);

    const out = build(f);
    expect(phisOf(out, "loop")).toHaveLength(0);
    expect(phisOf(out, "exit")).toHaveLength(0);
  });
});

describe("braun: loops", () => {
  it("inserts a phi in the loop header for the loop variable", () => {
    // entry: i = 0
    // loop:  i = i + 1; if c goto loop else exit
    // exit:  return i
    const f = fn("entry", [
      block("entry", [{ type: "const", dest: "i", value: 0 }], { type: "jump", target: "loop" }),
      block(
        "loop",
        [
          { type: "const", dest: "one", value: 1 },
          { type: "add", dest: "i", left: "i", right: "one" },
        ],
        { type: "branch", cond: "c", ifTrue: "loop", ifFalse: "exit" },
      ),
      block("exit", [], { type: "ret", value: "i" }),
    ]);

    const out = build(f);
    const phis = phisOf(out, "loop");

    expect(phis).toHaveLength(1);
    // One operand from each predecessor: entry and the loop itself.
    expect(phis[0]!.from).toHaveLength(2);

    // The add must read the phi (not the initial value, and not its own result).
    const add = bodyOf(out, "loop").find((i) => i.type === "add")!;
    expect(add.type).toBe("add");
    expect(add.left).toBe(phis[0]!.dest);
  });

  it("handles a loop nested in a branch", () => {
    const f = fn("entry", [
      block("entry", [{ type: "const", dest: "i", value: 0 }], {
        type: "branch",
        cond: "c",
        ifTrue: "loop",
        ifFalse: "after",
      }),
      block(
        "loop",
        [
          { type: "const", dest: "one", value: 1 },
          { type: "add", dest: "i", left: "i", right: "one" },
        ],
        { type: "branch", cond: "c2", ifTrue: "loop", ifFalse: "after" },
      ),
      block("after", [], { type: "ret", value: "i" }),
    ]);

    const out = build(f);
    // `i` differs on the two paths into `after` (entry's 0 vs the loop's last value), so it merges.
    expect(phisOf(out, "after")).toHaveLength(1);
  });
});

describe("braun: nested diamonds", () => {
  it("merges at both joins", () => {
    //        entry
    //          |
    //      outer_then ---- outer_else
    //       /    \             |
    //  inner_then inner_else   |
    //       \    /             |
    //     inner_join ----------+
    //          |
    //      final_join
    const f = fn("entry", [
      block("entry", [{ type: "const", dest: "x", value: 0 }], {
        type: "branch",
        cond: "c",
        ifTrue: "outer_then",
        ifFalse: "outer_else",
      }),
      block("outer_then", [], { type: "branch", cond: "c2", ifTrue: "inner_then", ifFalse: "inner_else" }),
      block("inner_then", [{ type: "const", dest: "x", value: 1 }], { type: "jump", target: "inner_join" }),
      block("inner_else", [{ type: "const", dest: "x", value: 2 }], { type: "jump", target: "inner_join" }),
      block("inner_join", [], { type: "jump", target: "final_join" }),
      block("outer_else", [{ type: "const", dest: "x", value: 3 }], { type: "jump", target: "final_join" }),
      block("final_join", [], { type: "ret", value: "x" }),
    ]);

    const out = build(f);
    expect(phisOf(out, "inner_join")).toHaveLength(1);
    expect(phisOf(out, "final_join")).toHaveLength(1);

    // The final phi must take its inner operand from the inner phi.
    const inner = phisOf(out, "inner_join")[0]!;
    const final = phisOf(out, "final_join")[0]!;
    expect(final.from).toContain(inner.dest);
  });
});

describe("braun: parameters and globals", () => {
  it("leaves a value with no definition standing for itself", () => {
    // `n` is never defined: it is a parameter. The framework does not model parameters, so a read
    // that no definition reaches just passes the name through.
    const f = fn("entry", [
      block(
        "entry",
        [
          { type: "const", dest: "one", value: 1 },
          { type: "add", dest: "r", left: "n", right: "one" },
        ],
        { type: "ret", value: "r" },
      ),
    ]);

    const out = build(f);
    const add = bodyOf(out, "entry").find((i) => i.type === "add")!;
    expect(add.type).toBe("add");
    expect(add.left).toBe("n");
  });
});

describe("braun: edges are derived from terminators", () => {
  it("fills in predecessors and successors", () => {
    const f = fn("entry", [
      block("entry", [], { type: "branch", cond: "c", ifTrue: "a", ifFalse: "b" }),
      block("a", [], { type: "jump", target: "join" }),
      block("b", [], { type: "jump", target: "join" }),
      block("join", [], { type: "ret" }),
    ]);

    const out = build(f);
    expect(out.blocks.get("entry")!.successors).toEqual(["a", "b"]);
    expect(out.blocks.get("join")!.predecessors).toEqual(["a", "b"]);
    expect(out.blocks.get("entry")!.predecessors).toEqual([]);
  });
});

describe("braun: the verifier rejects broken SSA", () => {
  it("catches a value defined twice", () => {
    const f = fn("entry", [
      block(
        "entry",
        [
          { type: "const", dest: "x", value: 1 },
          { type: "const", dest: "x", value: 2 },
        ],
        { type: "ret", value: "x" },
      ),
    ]);

    expect(() => verifySSA(f, testOps)).toThrow(/defined twice/);
  });

  it("catches a phi operand that nothing defines", () => {
    const f = fn("entry", [
      block("entry", [], { type: "branch", cond: "c", ifTrue: "a", ifFalse: "b" }),
      block("a", [{ type: "const", dest: "x", value: 1 }], { type: "jump", target: "join" }),
      block("b", [{ type: "const", dest: "x", value: 2 }], { type: "jump", target: "join" }),
      block(
        "join",
        [
          {
            type: "phi",
            dest: "p",
            incoming: [
              ["a", "x"],
              ["b", "ghost"],
            ],
          },
        ],
        { type: "ret", value: "p" },
      ),
    ]);

    expect(() => verifySSA(f, testOps)).toThrow(/nothing defines ghost/);
  });

  it("allows an operand the function never defines (a parameter or global)", () => {
    // The framework models neither, so it cannot tell a parameter from a typo, and must not guess.
    const f = fn("entry", [
      block(
        "entry",
        [
          { type: "const", dest: "one", value: 1 },
          { type: "add", dest: "r", left: "param", right: "one" },
        ],
        { type: "ret", value: "r" },
      ),
    ]);

    expect(() => verifySSA(f, testOps)).not.toThrow();
  });

  it("catches a phi that is missing an operand", () => {
    const f = fn("entry", [
      block("entry", [], { type: "branch", cond: "c", ifTrue: "a", ifFalse: "b" }),
      block("a", [], { type: "jump", target: "join" }),
      block("b", [], { type: "jump", target: "join" }),
      block("join", [{ type: "phi", dest: "x", incoming: [["a", "c"]] }], { type: "ret", value: "x" }),
    ]);

    expect(() => verifySSA(f, testOps)).toThrow(/missing an operand from predecessor b/);
  });

  it("catches block edges that disagree with the terminator", () => {
    const f = fn("entry", [
      block("entry", [], { type: "jump", target: "next" }),
      block("next", [], { type: "ret" }),
    ]);
    // Claim a successor the terminator does not have.
    f.blocks.get("entry")!.successors = ["next", "ghost"];

    expect(() => verifySSA(f, testOps)).toThrow(/do not match its terminator/);
  });
});
