/**
 * The interpreter for the micro-Scheme compiler's SSA IR.
 *
 * This is the last link in the chain, and the reason the SSA layer is actually exercised: it runs
 * the **optimized SSA**, not the source tree. Every earlier stage — the nanopass passes, the
 * lowering, Braun, the SSA passes — is only correct if the program still produces the same answer
 * here.
 *
 * ── Why it counts things
 *
 * Wall-clock time measures the interpreter, not the compiled code, so it says nothing about whether
 * the output is "C-like". What is meaningful is what the *program* does: how many IR instructions it
 * executes and how many allocations it performs. Those are the numbers the benchmarks compare
 * between unoptimized, optimized, and a hand-written C-style baseline.
 *
 * One unit is one instruction executed — phis included, since the interpreter really does resolve
 * one — or one frame slot written when a call is entered. The second half matters: a frame is not
 * free, and a loop that calls itself pays for one every iteration where a real loop would not.
 *
 * ── Tail calls
 *
 * A `tailcall` replaces the current frame instead of pushing one, so a tail-recursive program runs
 * in constant stack. That is what makes "the self tail call became a loop" observable.
 *
 * ── Calling convention (the interpreter's contract with the lowering)
 *
 * A frame's values are seeded by name:
 *
 *   `p0`, `p1`, ...   the call arguments
 *   `f0`, `f1`, ...   the closure's captured values
 *
 * So the lowering emits reads of `p0..` for parameters and `f0..` for captured variables, and the
 * interpreter binds them. Nothing else about a frame is pre-populated.
 */

import type { SSAFunction, BasicBlock, BlockId, ValueId } from "../../src/ssa/ir.ts";
import type { SchemeInstr, SchemeNode } from "./ir.ts";

// ───────────────────────── Values ─────────────────────────

export type Value =
  | { tag: "int"; n: number }
  | { tag: "bool"; b: boolean }
  | { tag: "pair"; car: Value; cdr: Value }
  | { tag: "closure"; fn: string; free: Value[] }
  | { tag: "func"; fn: string }
  | { tag: "nil" }
  | { tag: "void" };

export const V_INT = (n: number): Value => ({ tag: "int", n });
export const V_BOOL = (b: boolean): Value => ({ tag: "bool", b });
export const V_VOID: Value = { tag: "void" };
export const V_NIL: Value = { tag: "nil" };

/** Render a value the way a REPL would. */
export function show(v: Value): string {
  switch (v.tag) {
    case "int":
      return String(v.n);
    case "bool":
      return v.b ? "#t" : "#f";
    case "nil":
      return "()";
    case "void":
      return "#<void>";
    case "func":
      return `#<func ${v.fn}>`;
    case "closure":
      return `#<closure ${v.fn}>`;
    case "pair": {
      const parts: string[] = [];
      let cur: Value = v;
      for (;;) {
        if (cur.tag !== "pair") {
          if (cur.tag !== "void") parts.push(`. ${show(cur)}`);
          break;
        }
        parts.push(show(cur.car));
        cur = cur.cdr;
      }
      return `(${parts.join(" ")})`;
    }
  }
}

// ───────────────────────── Errors, stats, options ─────────────────────────

export class SchemeRuntimeError extends Error {}

export interface Stats {
  /** IR instructions executed, phi nodes included. */
  instructions: number;
  /** Heap allocations: `cons` and `make-closure`. */
  allocs: number;
  /** Non-tail calls performed. */
  calls: number;
  /** Tail calls performed. */
  tailcalls: number;
  /**
   * Frames created.
   *
   * A frame is the storage a call needs, so this is the third thing a program allocates — next to
   * pairs and closures. It is the number that shows whether a self tail call became a loop: the
   * loop reuses one frame, the call does not.
   */
  frames: number;
}

export interface RunResult {
  value: Value;
  output: string[];
  stats: Stats;
}

/** A program: every function, keyed by name. */
export type Module = Map<string, SSAFunction<SchemeNode>>;

export interface RunOptions {
  /** Abort after this many instructions. Keeps a runaway program from hanging the test suite. */
  maxSteps?: number;
}

// ───────────────────────── Interpreter ─────────────────────────

type Outcome =
  | { kind: "ret"; value: Value }
  | { kind: "tailcall"; callee: ValueId; args: ValueId[]; values: Map<ValueId, Value> };

class Interp {
  private readonly module: Module;
  private readonly stats: Stats = { instructions: 0, allocs: 0, calls: 0, tailcalls: 0, frames: 0 };
  private readonly output: string[] = [];
  /** Top-level bindings that are not functions. Shared by every frame. */
  private readonly globals = new Map<string, Value>();
  private readonly maxSteps: number;
  private steps = 0;

  constructor(module: Module, opts: RunOptions = {}) {
    this.module = module;
    this.maxSteps = opts.maxSteps ?? 50_000_000;
  }

  result(): { output: string[]; stats: Stats } {
    return { output: this.output, stats: this.stats };
  }

  /**
   * Run a function to completion. Tail calls loop here rather than recursing, so a tail-recursive
   * program uses constant stack.
   */
  run(fnName: string, args: Value[], free: Value[] = []): Value {
    let fn = this.function(fnName);
    let argv = args;
    let env = free;

    for (;;) {
      const outcome = this.execBody(fn, argv, env);
      if (outcome.kind === "ret") return outcome.value;

      this.stats.tailcalls++;
      const target = this.resolveCallee(outcome.callee, outcome.values);
      fn = this.function(target.fn);
      argv = outcome.args.map((a) => outcome.values.get(a) ?? V_VOID);
      env = target.free;
    }
  }

  private function(name: string): SSAFunction<SchemeNode> {
    const f = this.module.get(name);
    if (f === undefined) throw new SchemeRuntimeError(`no function named ${name}`);
    return f;
  }

  private execBody(fn: SSAFunction<SchemeNode>, args: Value[], free: Value[]): Outcome {
    this.stats.frames++;

    // Seeding a frame is one store per slot, and it is counted. A program that calls in a loop
    // pays it every iteration; a C loop does not. Leaving it out of the count would make the
    // comparison systematically favour the calling form, which is the thing being measured.
    this.stats.instructions += args.length + free.length;

    const values = new Map<ValueId, Value>();
    for (let i = 0; i < free.length; i++) values.set(`f${i}`, free[i]!);
    for (let i = 0; i < args.length; i++) values.set(`p${i}`, args[i]!);

    let blockId: BlockId = fn.entry;
    let from: BlockId | undefined = undefined;

    for (;;) {
      // Count block entries as well as instructions. A block with no instructions whose terminator
      // jumps back to itself — an empty loop body, which real compilers do produce — would
      // otherwise spin without ever advancing the step counter.
      this.tick();

      const block = this.block(fn, blockId);
      this.execBlock(fn, block, values, from);

      const term = block.terminator;
      switch (term.type) {
        case "jump":
          from = blockId;
          blockId = term.target;
          break;

        case "branch": {
          const cond = values.get(term.cond);
          if (cond === undefined) throw new SchemeRuntimeError(`branch on uncomputed value ${term.cond}`);
          if (cond.tag !== "bool") {
            throw new SchemeRuntimeError(`branch condition must be a boolean, got ${show(cond)}`);
          }
          from = blockId;
          blockId = cond.b ? term.ifTrue : term.ifFalse;
          break;
        }

        case "ret":
          return {
            kind: "ret",
            value: term.value === undefined ? V_VOID : this.get(values, term.value, fn),
          };

        case "unreachable":
          throw new SchemeRuntimeError(`reached an unreachable block (${fn.id}:${blockId})`);

        case "tailcall":
          return { kind: "tailcall", callee: term.callee, args: term.args, values };
      }
    }
  }

  private block(fn: SSAFunction<SchemeNode>, id: BlockId): BasicBlock<SchemeNode> {
    const b = fn.blocks.get(id);
    if (b === undefined) throw new SchemeRuntimeError(`no block ${id} in ${fn.id}`);
    return b;
  }

  private execBlock(
    fn: SSAFunction<SchemeNode>,
    block: BasicBlock<SchemeNode>,
    values: Map<ValueId, Value>,
    from: BlockId | undefined,
  ): void {
    for (const inst of block.instructions) {
      this.stats.instructions++;

      if (inst.type === "phi") {
        // A phi's value depends on which edge we arrived along.
        const pair = inst.incoming.find(([pred]) => pred === from);
        if (pair === undefined) {
          throw new SchemeRuntimeError(
            `phi ${inst.dest} in ${fn.id}:${block.id} has no operand for the edge from ${from ?? "<entry>"}`,
          );
        }
        values.set(inst.dest, this.get(values, pair[1], fn));
        continue;
      }

      // The instruction slot never holds a terminator; the framework keeps the two apart. Checking
      // rather than casting, so a malformed module says so instead of misbehaving.
      if (inst.type === "tailcall") {
        throw new SchemeRuntimeError(
          `a tail call appeared in an instruction position (${fn.id}:${block.id})`,
        );
      }

      // `print` and `global-set` are the instructions with no destination.
      if (inst.type === "print" || inst.type === "global-set") {
        this.evalInstr(fn, values, inst);
        continue;
      }

      values.set(inst.dest, this.evalInstr(fn, values, inst));
    }
  }

  /** Advance the step budget. Called per block entry and per instruction. */
  private tick(): void {
    if (++this.steps > this.maxSteps) {
      throw new SchemeRuntimeError(`exceeded ${this.maxSteps} steps; the program does not terminate`);
    }
  }

  private get(values: Map<ValueId, Value>, name: ValueId, fn: SSAFunction<SchemeNode>): Value {
    const v = values.get(name);
    if (v === undefined) {
      throw new SchemeRuntimeError(`value ${name} was read before it was computed (in ${fn.id})`);
    }
    return v;
  }

  private evalInstr(fn: SSAFunction<SchemeNode>, values: Map<ValueId, Value>, inst: SchemeInstr): Value {
    switch (inst.type) {
      case "const":
        return typeof inst.value === "boolean" ? V_BOOL(inst.value) : V_INT(inst.value);

      case "void":
        return V_VOID;

      case "copy":
        return this.get(values, inst.src, fn);

      case "nil":
        return V_NIL;

      case "prim":
        return this.evalPrim(values, fn, inst.op, inst.args);

      case "cons": {
        this.stats.allocs++;
        return { tag: "pair", car: this.get(values, inst.car, fn), cdr: this.get(values, inst.cdr, fn) };
      }

      case "car": {
        const p = this.get(values, inst.pair, fn);
        if (p.tag !== "pair") throw new SchemeRuntimeError(`car of a non-pair: ${show(p)}`);
        return p.car;
      }

      case "cdr": {
        const p = this.get(values, inst.pair, fn);
        if (p.tag !== "pair") throw new SchemeRuntimeError(`cdr of a non-pair: ${show(p)}`);
        return p.cdr;
      }

      case "func-ref":
        return { tag: "func", fn: inst.fn };

      case "make-closure": {
        this.stats.allocs++;
        return { tag: "closure", fn: inst.fn, free: inst.free.map((v) => this.get(values, v, fn)) };
      }

      case "closure-ref": {
        const c = this.get(values, inst.closure, fn);
        if (c.tag !== "closure") throw new SchemeRuntimeError(`closure-ref of a non-closure: ${show(c)}`);
        const v = c.free[inst.index];
        if (v === undefined) throw new SchemeRuntimeError(`closure ${c.fn} has no slot ${inst.index}`);
        return v;
      }

      case "call": {
        this.stats.calls++;
        const target = this.resolveCallee(inst.callee, values);
        const argv = inst.args.map((a) => this.get(values, a, fn));
        return this.run(target.fn, argv, target.free);
      }

      case "global-set": {
        this.globals.set(inst.name, this.get(values, inst.value, fn));
        return V_VOID;
      }

      case "global-ref": {
        const v = this.globals.get(inst.name);
        if (v === undefined) {
          throw new SchemeRuntimeError(`global ${inst.name} was read before it was set`);
        }
        return v;
      }

      case "print": {
        this.output.push(show(this.get(values, inst.value, fn)));
        return V_VOID;
      }
    }
  }

  private resolveCallee(name: ValueId, values: Map<ValueId, Value>): { fn: string; free: Value[] } {
    const v = values.get(name);
    if (v === undefined) throw new SchemeRuntimeError(`callee ${name} was read before it was computed`);
    if (v.tag === "func") return { fn: v.fn, free: [] };
    if (v.tag === "closure") return { fn: v.fn, free: v.free };
    throw new SchemeRuntimeError(`not a function: ${show(v)}`);
  }

  private evalPrim(
    values: Map<ValueId, Value>,
    fn: SSAFunction<SchemeNode>,
    op: string,
    args: readonly ValueId[],
  ): Value {
    if (op === "null?") {
      const x = this.get(values, args[0]!, fn);
      return V_BOOL(x.tag === "nil");
    }

    const a = this.get(values, args[0]!, fn);
    const b = this.get(values, args[1]!, fn);

    if (a.tag !== "int" || b.tag !== "int") {
      throw new SchemeRuntimeError(`primitive ${op} needs integers, got ${show(a)} and ${show(b)}`);
    }

    switch (op) {
      case "add":
        return V_INT(a.n + b.n);
      case "sub":
        return V_INT(a.n - b.n);
      case "mul":
        return V_INT(a.n * b.n);
      case "div":
        if (b.n === 0) throw new SchemeRuntimeError("division by zero");
        return V_INT(Math.trunc(a.n / b.n));
      case "mod":
        if (b.n === 0) throw new SchemeRuntimeError("modulo by zero");
        return V_INT(a.n % b.n);
      case "lt":
        return V_BOOL(a.n < b.n);
      case "le":
        return V_BOOL(a.n <= b.n);
      case "gt":
        return V_BOOL(a.n > b.n);
      case "ge":
        return V_BOOL(a.n >= b.n);
      case "num-eq":
        return V_BOOL(a.n === b.n);
      default:
        throw new SchemeRuntimeError(`unknown primitive ${op}`);
    }
  }
}

/** Run `entry` with `args`; returns the value, the printed output, and the counters. */
export function run(module: Module, entry: string, args: Value[] = [], opts: RunOptions = {}): RunResult {
  const interp = new Interp(module, opts);
  const value = interp.run(entry, args);
  const { output, stats } = interp.result();
  return { value, output, stats };
}
