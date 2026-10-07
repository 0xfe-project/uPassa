/**
 * The SSA IR the micro-Scheme compiler lowers to.
 *
 * This is the user's `T` for the SSA framework. The framework owns control flow (`jump`, `branch`,
 * `ret`, `unreachable`) and phi nodes; everything here is ours. The framework reads and rewrites
 * the operands below through `schemeOps`.
 *
 * The shape is chosen to look like something a C compiler would emit, because that is what the
 * benchmarks measure against: values in "registers" (SSA names), one operation per instruction,
 * explicit allocation, no hidden temporaries.
 *
 * ── Tail calls are a terminator
 *
 * A non-tail call produces a value, so it is an instruction. A tail call does not return to its
 * caller, so it is a terminator — and the interpreter can honour it by replacing the current frame
 * instead of pushing one. A self tail call is what the loop-conversion pass turns into a jump.
 */

import type { SSAOps, ValueId } from "../../src/ssa/ir.ts";

/**
 * Primitives. One node kind with an op tag, because the operand handling is identical for all of
 * them — adding a node kind per operator would mean touching `def`/`uses`/`setUse` every time.
 *
 * The arity is not fixed: arithmetic takes two operands, `null?` takes one.
 */
export type PrimOp = "add" | "sub" | "mul" | "div" | "mod" | "lt" | "le" | "gt" | "ge" | "num-eq" | "null?";

export type PrimInstr = { type: "prim"; dest: ValueId; op: PrimOp; args: ValueId[] };

export type SchemeInstr =
  | { type: "const"; dest: ValueId; value: number | boolean }
  /** The value of a form that is evaluated for effect only. Its own node so it is never a number. */
  | { type: "void"; dest: ValueId }
  /**
   * `dest := src`.
   *
   * Needed because a value produced in two places — the two arms of an `if` — has to be named the
   * same thing in both, so that the SSA construction can see one variable with two definitions and
   * put a phi where they meet. An arm whose value is already a name still needs the copy, because
   * the *name* is what carries the merge, not the instruction that produced it.
   *
   * Copy propagation removes these. They are in the IR on purpose, not as an artifact.
   */
  | { type: "copy"; dest: ValueId; src: ValueId }
  /** The empty list. Its own node rather than a special const, so it cannot be confused with a number. */
  | { type: "nil"; dest: ValueId }
  /** `(op a b)` — the only binary node, so `def`/`uses` do not have to grow per operator. */
  | PrimInstr
  /** Heap allocation of a pair. Counted by the benchmarks. */
  | { type: "cons"; dest: ValueId; car: ValueId; cdr: ValueId }
  | { type: "car"; dest: ValueId; pair: ValueId }
  | { type: "cdr"; dest: ValueId; pair: ValueId }
  /**
   * A bare reference to a top-level function: a code label with no captured environment.
   *
   * The callee of a call is always a value, so there is exactly one call shape. Whether a call is
   * direct is then *derivable* — it is direct when the callee's only definition is a `func-ref` —
   * instead of being a second node kind the passes have to keep in sync.
   */
  | { type: "func-ref"; dest: ValueId; fn: string }
  /**
   * Heap allocation of a closure: a code label plus the captured values.
   * Counted by the benchmarks — eliminating these is most of what "runs like C" means for FP.
   */
  | { type: "make-closure"; dest: ValueId; fn: string; free: ValueId[] }
  | { type: "closure-ref"; dest: ValueId; closure: ValueId; index: number }
  /** A non-tail call: it returns a value. `callee` is a `func-ref` or a closure. */
  | { type: "call"; dest: ValueId; callee: ValueId; args: ValueId[] }
  /**
   * A top-level binding that is not a function. Globals live outside every frame, so they need
   * their own read and write rather than being smuggled through the calling convention.
   */
  | { type: "global-set"; name: string; value: ValueId }
  | { type: "global-ref"; dest: ValueId; name: string }
  /** Write a value to the output. No destination. */
  | { type: "print"; value: ValueId };

export type SchemeTerm =
  /** A tail call: control leaves this function for good. `callee` is a `func-ref` or a closure. */
  { type: "tailcall"; callee: ValueId; args: ValueId[] };

export type SchemeNode = SchemeInstr | SchemeTerm;

/**
 * `SSAOops` for the IR above.
 *
 * `T` covers both instructions and terminators, so each method has to cope with nodes that do not
 * apply to it — `def` on a tail call, `setDef` on a print. That is the cost of one type parameter
 * covering both; it keeps the framework's signature simple.
 */
export const schemeOps: SSAOps<SchemeNode> = {
  def: (n) => ("dest" in n ? n.dest : undefined),

  uses: (n) => {
    switch (n.type) {
      case "const":
      case "void":
      case "nil":
      case "func-ref":
        return [];
      case "copy":
        return [n.src];
      case "prim":
        return n.args;
      case "cons":
        return [n.car, n.cdr];
      case "car":
      case "cdr":
        return [n.pair];
      case "make-closure":
        return n.free;
      case "closure-ref":
        return [n.closure];
      case "call":
      case "tailcall":
        return [n.callee, ...n.args];
      case "global-set":
        return [n.value];
      case "global-ref":
        return [];
      case "print":
        return [n.value];
    }
  },

  setDef: (n, name) => {
    if ("dest" in n) n.dest = name;
  },

  setUse: (n, from, to) => {
    const swap = (v: ValueId): ValueId => (v === from ? to : v);
    switch (n.type) {
      case "const":
      case "void":
      case "nil":
      case "func-ref":
      case "global-ref":
        break;
      case "copy":
        n.src = swap(n.src);
        break;
      case "prim":
        n.args = n.args.map(swap);
        break;
      case "cons":
        n.car = swap(n.car);
        n.cdr = swap(n.cdr);
        break;
      case "car":
      case "cdr":
        n.pair = swap(n.pair);
        break;
      case "make-closure":
        n.free = n.free.map(swap);
        break;
      case "closure-ref":
        n.closure = swap(n.closure);
        break;
      case "call":
      case "tailcall":
        n.callee = swap(n.callee);
        n.args = n.args.map(swap);
        break;
      case "global-set":
        n.value = swap(n.value);
        break;
      case "print":
        n.value = swap(n.value);
        break;
    }
  },

  /** Our terminators have no successors: a tail call leaves the function. */
  successors: () => [],
};

/**
 * True for a `copy` — the only instruction whose whole job is to name another value.
 *
 * The parameter is any tagged node rather than `SchemeNode`, because a caller walking a block sees
 * `Instruction<SchemeNode>`, which also includes the framework's phi.
 */
export function isCopy(n: { type: string }): n is { type: "copy"; dest: ValueId; src: ValueId } {
  return n.type === "copy";
}

/**
 * True when discarding the instruction changes nothing observable.
 *
 * `call` is not pure: the callee may print. `print` and `global-set` are effects themselves.
 * Everything else computes a value, allocates one, or names one — and an unused value is not an
 * effect. Allocation counts as pure here because dropping an allocation nobody reads is exactly
 * what the benchmarks want to see.
 */
export function isPure(n: { type: string }): boolean {
  return n.type !== "print" && n.type !== "global-set" && n.type !== "call" && n.type !== "tailcall";
}

/** The op tag of a `prim`, for passes that care about the operator. */
export function primOp(n: SchemeNode): PrimOp | undefined {
  return n.type === "prim" ? n.op : undefined;
}

/** True for nodes that allocate on the heap. The benchmarks count these. */
export function allocates(n: SchemeNode): boolean {
  return n.type === "cons" || n.type === "make-closure";
}
