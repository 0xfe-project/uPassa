/**
 * Hand-written C-style SSA IR for the benchmark corpus.
 *
 * This is the reference the compiler is measured against. It is written by hand, in the IR the
 * interpreter runs, so the three rows of a benchmark — unoptimized, optimized, hand-written — are
 * counted by exactly the same code.
 *
 * ── What "C-style" means here
 *
 * The same computation, written the way a C programmer would write it: loops rather than recursion,
 * direct calls rather than closures, and no intermediate data where a C compiler would keep the
 * value in a register. For `map-fold`, that means one loop that squares and accumulates rather than
 * a list that is built, mapped and folded. That is the honest reading of the question — "how close
 * does the functional version get to the work the C-shaped version does" — and it is why the
 * baseline is a floor on work rather than a floor on code quality.
 *
 * Loops are written with **variables**, not phis: `copy` writes a name, and the SSA construction
 * turns two writes into a phi. Writing the phis by hand would be more faithful to a compiler's
 * output and much easier to get subtly wrong; the construction is the same one the compiler under
 * test uses, so the baseline inherits it rather than reimplementing it.
 *
 * Every baseline is checked against the same expected output as the Scheme program it stands for —
 * see `tests/bench.test.ts`. A baseline that computes something else would make the comparison
 * meaningless and would not otherwise be noticeable.
 */

import type { BasicBlock, SSAFunction, ValueId } from "../../../src/ssa/ir.ts";
import { toSSA } from "../../../src/ssa/braun.ts";
import { BUILTINS } from "../lower.ts";
import { schemeOps, type PrimOp, type SchemeInstr, type SchemeNode } from "../ir.ts";

// ───────────────────────── A small builder ─────────────────────────

/** One block, with a method per instruction kind. Names are given where they matter and made up otherwise. */
class Blk {
  readonly block: BasicBlock<SchemeNode>;
  private readonly owner: Fn;

  constructor(owner: Fn, id: string) {
    this.owner = owner;
    this.block = {
      id,
      instructions: [],
      terminator: { type: "unreachable" },
      predecessors: [],
      successors: [],
    };
  }

  private add(inst: SchemeInstr): void {
    this.block.instructions.push(inst);
  }

  /** A name for a value nobody needs to refer to again. */
  private tmp(): ValueId {
    return this.owner.tmp();
  }

  const(value: number | boolean, dest: ValueId = this.tmp()): ValueId {
    this.add({ type: "const", dest, value });
    return dest;
  }

  nil(dest: ValueId = this.tmp()): ValueId {
    this.add({ type: "nil", dest });
    return dest;
  }

  prim(op: PrimOp, ...args: ValueId[]): ValueId {
    const dest = this.tmp();
    this.add({ type: "prim", dest, op, args });
    return dest;
  }

  cons(car: ValueId, cdr: ValueId): ValueId {
    const dest = this.tmp();
    this.add({ type: "cons", dest, car, cdr });
    return dest;
  }

  car(pair: ValueId): ValueId {
    const dest = this.tmp();
    this.add({ type: "car", dest, pair });
    return dest;
  }

  cdr(pair: ValueId): ValueId {
    const dest = this.tmp();
    this.add({ type: "cdr", dest, pair });
    return dest;
  }

  funcRef(fn: string): ValueId {
    const dest = this.tmp();
    this.add({ type: "func-ref", dest, fn });
    return dest;
  }

  makeClosure(fn: string, free: ValueId[]): ValueId {
    const dest = this.tmp();
    this.add({ type: "make-closure", dest, fn, free });
    return dest;
  }

  call(callee: ValueId, args: ValueId[]): ValueId {
    const dest = this.tmp();
    this.add({ type: "call", dest, callee, args });
    return dest;
  }

  print(value: ValueId): void {
    this.add({ type: "print", value });
  }

  /** Write a name. In a loop this is what makes the SSA construction place a phi. */
  copy(dest: ValueId, src: ValueId): void {
    this.add({ type: "copy", dest, src });
  }

  jump(target: string): void {
    this.block.terminator = { type: "jump", target };
  }

  branch(cond: ValueId, ifTrue: string, ifFalse: string): void {
    this.block.terminator = { type: "branch", cond, ifTrue, ifFalse };
  }

  ret(value?: ValueId): void {
    this.block.terminator = value === undefined ? { type: "ret" } : { type: "ret", value };
  }

  tailcall(callee: ValueId, args: ValueId[]): void {
    this.block.terminator = { type: "tailcall", callee, args };
  }
}

class Fn {
  readonly blocks = new Map<string, BasicBlock<SchemeNode>>();
  private readonly id: string;
  private n = 0;

  constructor(id: string) {
    this.id = id;
  }

  tmp(): ValueId {
    return `%${this.n++}`;
  }

  block(id: string, body: (b: Blk) => void): this {
    const b = new Blk(this, id);
    this.blocks.set(id, b.block);
    if (this.entry === undefined) this.entry = id;
    body(b);
    return this;
  }

  /** The first block declared, unless `done` is told otherwise. */
  private entry: string | undefined;

  done(entry = this.entry ?? "entry"): SSAFunction<SchemeNode> {
    // Variables with two writes become phis here, exactly as they do for compiled code.
    return toSSA({ id: this.id, blocks: this.blocks, entry }, schemeOps);
  }
}

/** Start a function. The entry block is the first `block()` call unless one is named. */
export function fn(id: string): Fn {
  return new Fn(id);
}

/** A module of hand-written functions, plus the built-ins the interpreter needs. */
export function module(functions: readonly SSAFunction<SchemeNode>[]): Map<string, SSAFunction<SchemeNode>> {
  const m = new Map<string, SSAFunction<SchemeNode>>();
  for (const [name, f] of BUILTINS) m.set(name, f);
  for (const f of functions) m.set(f.id, f);
  return m;
}

export { Fn, Blk };
