/**
 * Self tail calls becoming loops, and loop-invariant code motion.
 *
 * Two things are checked. First, that turning a call into a loop changes nothing about what the
 * program prints — for every program in the corpus, not just the recursive ones. Second, that it
 * actually does something: a self tail call that was replaced by a loop reuses one frame, and a
 * value computed inside the loop that does not change moves out of it.
 */

import { describe, expect, test } from "vitest";
import { compileProgram, runSource } from "../run.ts";
import { PROGRAMS } from "../fixtures/programs.ts";
import { convertSelfTailCalls } from "../tail-to-loop.ts";

const FIXTURE = (name: string) => PROGRAMS.find((p) => p.name === name)!.source;

const COUNT = "(define (count n acc) (if (= n 0) acc (count (- n 1) (+ acc 1))))\n(print (count 10 0))";

/**
 * The loop header of `fn`.
 *
 * Not `fn.entry`: the conversion inserts a preheader in front of the old entry, so the function's
 * entry block is the preheader and the loop header is what it jumps to.
 */
function loopHeader(fn: {
  entry: string;
  blocks: Map<string, { terminator: { type: string; target?: string } }>;
}) {
  const entry = fn.blocks.get(fn.entry)!;
  const term = entry.terminator;
  if (term.type !== "jump" || term.target === undefined) throw new Error("no preheader");
  return fn.blocks.get(term.target)! as unknown as {
    id: string;
    predecessors: string[];
    instructions: { type: string; dest?: string; incoming: [string, string][] }[];
  };
}

describe("a self tail call becomes a loop", () => {
  for (const p of PROGRAMS) {
    test(`${p.name}: the same answer with and without loop conversion`, () => {
      const called = runSource(p.source, [], { loops: false, optimize: false });
      const looped = runSource(p.source, [], { loops: true, optimize: false });
      expect(looped.output).toEqual(called.output);
      expect(JSON.stringify(looped.value)).toBe(JSON.stringify(called.value));
    });
  }

  test("a tail call reuses its frame, so neither form builds one per iteration", () => {
    // This is what a tail call is: the callee's frame takes the place of the caller's. Both forms
    // therefore build one frame for 100,000 iterations — the loop conversion is not what buys that.
    const source = FIXTURE("deep-tail-recursion");
    const called = runSource(source, [], { loops: false });
    const looped = runSource(source, [], { loops: true });
    expect(called.stats.frames).toBeLessThan(10);
    expect(looped.stats.frames).toBeLessThan(10);
  });

  test("what the loop conversion buys is instructions, once the copies are gone", () => {
    // The rewrite itself adds work: the arguments become explicit copies into the frame slots, and
    // the header gains a phi per slot. Copy propagation removes the copies and hoisting moves the
    // loop-invariant constants out, and what is left is shorter than the call it replaced.
    const source = FIXTURE("deep-tail-recursion");
    const called = runSource(source, [], { loops: false, optimize: true });
    const looped = runSource(source, [], { loops: true, optimize: true });
    expect(looped.stats.instructions).toBeLessThan(called.stats.instructions);
  });

  test("the loop body is the shape a C compiler would emit", () => {
    const { module } = compileProgram(COUNT, { loops: true, optimize: true });
    const fn = module.get("count")!;
    const header = loopHeader(fn);

    // The parameters arrive as phis at the loop header: one operand from the preheader (the value
    // the caller passed) and one from the back edge (the value the previous iteration computed).
    const phis = header.instructions.filter((i) => i.type === "phi");
    expect(phis).toHaveLength(2);
    for (const phi of phis) {
      expect(phi.incoming.map(([pred]) => pred).sort()).toEqual([...header.predecessors].sort());
    }

    // And no frame is seeded inside the loop: no instruction names p0 or p1 as a destination.
    const dests = new Set<string>();
    for (const block of fn.blocks.values()) {
      for (const inst of block.instructions) {
        const d = (inst as { dest?: string }).dest;
        if (d !== undefined) dests.add(d);
      }
    }
    expect(dests.has("p0")).toBe(false);
    expect(dests.has("p1")).toBe(false);
  });

  test("the frame values reach the header's phis as bare parameters", () => {
    // The preheader has no predecessors, and a read in a block nothing enters stands for itself —
    // so `p0` arrives at the phi under its own name. Without the preheader the header would have
    // only the back edge as a predecessor, the phi would have one operand, and the trivial-phi rule
    // would delete it, losing the argument the caller passed in.
    const { module } = compileProgram(COUNT, { loops: true, optimize: false });
    const fn = module.get("count")!;
    const header = loopHeader(fn);
    const incoming = header.instructions
      .filter((i) => i.type === "phi")
      .flatMap((p) => p.incoming.map(([, v]) => v));
    expect(incoming).toContain("p0");
    expect(incoming).toContain("p1");
  });

  test("a mutual tail call is left alone", () => {
    // It is not a loop over one frame. The interpreter still runs it in constant stack.
    const { lowered } = compileProgram(FIXTURE("mutual-recursion"), { ssa: false, loops: false });
    for (const fn of lowered.functions.values()) {
      const converted = fn.blocks.size;
      const before = new Map([...fn.blocks].map(([id, b]) => [id, b.terminator.type]));
      convertSelfTailCalls(fn);
      expect(fn.blocks.size).toBe(converted);
      for (const [id, term] of before) expect(fn.blocks.get(id)!.terminator.type).toBe(term);
    }
  });

  test("converting twice is the same as converting once", () => {
    // The second run has no self tail calls left — they are jumps now — so it must find nothing.
    // `loops: false` because the conversion normally runs as part of compiling; this test drives
    // it directly, twice.
    const { lowered } = compileProgram(FIXTURE("self-recursion"), { ssa: false, loops: false });
    const fn = [...lowered.functions.values()].find((f) => f.id === "count")!;
    expect(convertSelfTailCalls(fn)).toBe(1);
    const after = fn.blocks.size;
    expect(convertSelfTailCalls(fn)).toBe(0);
    expect(fn.blocks.size).toBe(after);
  });
});

describe("loop-invariant code motion", () => {
  test("a constant used in the loop is computed once", () => {
    const { module } = compileProgram(COUNT, { loops: true, optimize: true });
    const fn = module.get("count")!;
    const header = loopHeader(fn);

    // `1` is used by both the subtraction and the addition. It belongs outside the loop.
    const constsInHeader = header.instructions.filter((i) => i.type === "const");
    expect(constsInHeader).toHaveLength(0);
  });

  test("hoisting shortens the loop body", () => {
    const source = COUNT;
    const without = runSource(source, [], { loops: true, optimize: false });
    const with_ = runSource(source, [], { loops: true, optimize: true });
    // Per iteration: the optimized loop runs fewer instructions, and the difference is what
    // hoisting and copy propagation removed from the body.
    const perIteration = (r: { stats: { instructions: number } }, n: number) => r.stats.instructions / n;
    expect(perIteration(with_, 100)).toBeLessThan(perIteration(without, 100));
  });

  test("optimizing is still behaviour-preserving with loops on", () => {
    for (const p of PROGRAMS) {
      const plain = runSource(p.source, [], { loops: true, optimize: false });
      const optimized = runSource(p.source, [], { loops: true, optimize: true, verifyEach: true });
      expect(optimized.output).toEqual(plain.output);
    }
  });
});
