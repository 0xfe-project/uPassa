/**
 * A direct interpreter for S0 — the source language, with no compiler involved.
 *
 * This is the baseline that answers a different question from the hand-written one. The hand-written
 * rows in `bench/baselines.ts` are *other programs*: the same computation written in C style, which
 * measures what the choice of algorithm costs. This measures what **compiling** costs — the same
 * source text, run without going through the nanopass passes, the lowering, or the SSA layer.
 *
 * Three things follow from interpreting the tree, and all three are what the compiler exists to
 * remove:
 *
 * - a variable reference is a lookup through a chain of frames, at run time
 * - a `let` allocates a frame; a `lambda` allocates a closure holding its environment
 * - every construct in the source language is still there — `cond`, `and`, `or`, `when`, `let*` —
 *   and is resolved by walking the tree each time it runs
 *
 * ── What is counted, and the direction of the error
 *
 * One step per node evaluated, plus one step per variable reference resolved. Nothing else: not the
 * depth of the chain a lookup walks, not the frame a `let` allocates, not the dispatch on which
 * primitive was named.
 *
 * Those omissions are deliberate and they are all in the same direction — they make the interpreter
 * look *cheaper* than it is, so any advantage the compiler shows over this row is a lower bound. A
 * counter tuned to flatter the compiler would not be worth reading.
 *
 * The unit is coarser than an IR instruction: a tree node may expand to several instructions, and
 * vice versa. The comparison is about the order of magnitude and the trend, not a precise factor.
 */

import type { S0_Expr, S0_Program } from "./langs/chain.ts";
import { V_BOOL, V_INT, V_NIL, V_VOID, show, type Value } from "./interp.ts";

export class TreeError extends Error {}

// ───────────────────────── Environment ─────────────────────────

/**
 * A frame chain.
 *
 * The compiler's alpha-renaming pass makes every name unique so that a name can be an identity.
 * Here it cannot: an inner binding shadows an outer one, so a lookup walks outward until it finds
 * the innermost frame that binds the name. That walk is the work the compiler removes.
 */
class Env {
  private readonly vars = new Map<string, Value>();
  private readonly parent: Env | undefined;

  constructor(parent?: Env) {
    this.parent = parent;
  }

  extend(): Env {
    return new Env(this);
  }

  bind(name: string, value: Value): void {
    this.vars.set(name, value);
  }

  /** Resolve a name, walking outward. The walk is the work the compiler removes. */
  lookup(name: string): Value {
    for (let e: Env | undefined = this; e !== undefined; e = e.parent) {
      const v = e.vars.get(name);
      if (v !== undefined) return v;
    }
    throw new TreeError(`unbound variable: ${name}`);
  }
}

// ───────────────────────── Procedures ─────────────────────────

interface Primitive {
  readonly tag: "primitive";
  readonly name: string;
}

interface Closure {
  readonly tag: "closure";
  readonly params: readonly string[];
  readonly body: S0_Expr;
  readonly env: Env;
}

type Callable = Primitive | Closure;

/**
 * The result of evaluating an expression in tail position.
 *
 * A tail call comes back as a request rather than as a recursive call, so the loop in `apply` can
 * reuse the frame. This is the interpreter's version of what the compiler does when it turns a self
 * tail call into a jump.
 */
type Step = { kind: "value"; value: Value } | { kind: "tailcall"; fn: Callable; args: Value[] };

function isCallable(v: Value | Callable): v is Callable {
  return v.tag === "primitive" || v.tag === "closure";
}

// ───────────────────────── The interpreter ─────────────────────────

/** Primitives, by source name. Arity is checked where it matters, not up front. */
const PRIMITIVES = [
  "+",
  "-",
  "*",
  "/",
  "modulo",
  "<",
  "<=",
  ">",
  ">=",
  "=",
  "null?",
  "cons",
  "car",
  "cdr",
  "print",
  "not",
] as const;

export interface TreeStats {
  /** Tree nodes evaluated, plus variable references resolved. See the note at the top. */
  steps: number;
  /**
   * Call frames allocated.
   *
   * The same thing the compiled row's `frames` counts, so the two are comparable — and the
   * difference is real rather than an artifact: see the note in `apply` for why the interpreter
   * cannot reuse a frame across a tail call and the compiler can. The extra frame a `let` allocates
   * here is not counted, which is in the direction of making this row look cheaper.
   */
  frames: number;
  /**
   * Heap allocations: pairs and closures.
   *
   * The same thing the compiled row's `allocs` counts, so the two are comparable. An interpreter
   * cannot avoid allocating a closure for a `lambda` — it has no way to know which lambdas are
   * `func-ref`s, because it never did the analysis that decides that.
   */
  allocs: number;
  /** Closures alone, for when the split matters. */
  closures: number;
}

export interface TreeRunResult {
  value: Value;
  output: string[];
  stats: TreeStats;
}

class TreeInterp {
  private readonly globals = new Env();
  private readonly output: string[] = [];
  private steps = 0;
  private frames = 0;
  private allocs = 0;
  private closures = 0;
  private readonly maxSteps: number;

  constructor(maxSteps: number) {
    this.maxSteps = maxSteps;
    for (const name of PRIMITIVES) {
      this.globals.bind(name, { tag: "primitive", name } as unknown as Value);
    }
  }

  private stats(): TreeStats {
    return {
      steps: this.steps,
      frames: this.frames,
      allocs: this.allocs,
      closures: this.closures,
    };
  }

  result(): TreeRunResult {
    return { value: V_VOID, output: this.output, stats: this.stats() };
  }

  run(program: S0_Program): TreeRunResult {
    // Definitions are evaluated in order, in the global frame — which is why a top-level function
    // can see the ones defined before it and not the ones after.
    for (const d of program.defs) {
      if (d.type === "DefFun") {
        // A top-level function is a closure with no captures. The compiler recognises this and
        // emits a bare code reference; the interpreter cannot, so it allocates.
        this.globals.bind(d.name, {
          tag: "closure",
          params: d.params,
          body: d.body,
          env: this.globals,
        } as unknown as Value);
        this.closures++;
        this.allocs++;
      } else {
        this.globals.bind(d.name, this.eval(d.value, this.globals));
      }
    }

    let value: Value = V_VOID;
    for (let i = 0; i < program.body.length; i++) {
      const e = program.body[i]!;
      if (i === program.body.length - 1) {
        // The last expression of the program is in tail position, the same as a function body.
        const step = this.evalTail(e, this.globals);
        value = step.kind === "value" ? step.value : this.apply(step.fn, step.args);
      } else {
        value = this.eval(e, this.globals);
      }
    }
    return { value, output: this.output, stats: this.stats() };
  }

  private tick(): void {
    if (++this.steps > this.maxSteps) {
      throw new TreeError(`exceeded ${this.maxSteps} steps; the program does not terminate`);
    }
  }

  private eval(e: S0_Expr, env: Env): Value {
    this.tick();

    switch (e.type) {
      case "Int":
        return V_INT(e.value);
      case "Bool":
        return V_BOOL(e.value);
      case "Nil":
        return V_NIL;
      case "Var":
        // One step for the reference itself. The depth of the walk is not counted — see the note at
        // the top of the file: the omissions are all in the direction of making this row cheaper.
        this.tick();
        return env.lookup(e.name);

      case "Lambda": {
        this.closures++;
        this.allocs++;
        return { tag: "closure", params: e.params, body: e.body, env } as unknown as Value;
      }

      case "App": {
        const fn = this.eval(e.func, env);
        if (!isCallable(fn)) throw new TreeError(`not a function: ${show(fn as Value)}`);
        const args = e.args.map((a) => this.eval(a, env));
        return this.apply(fn, args);
      }

      case "If": {
        const cond = this.eval(e.cond, env);
        return this.truthy(cond) ? this.eval(e.then, env) : this.eval(e.alt, env);
      }

      case "IfAlt":
        // One-armed `if` with no else: the value is `void` when the test fails.
        return this.truthy(this.eval(e.cond, env)) ? this.eval(e.then, env) : V_VOID;

      case "Let": {
        // The bindings are parallel: every value is evaluated in the *outer* frame.
        const inner = env.extend();
        this.frames++;
        const values = e.bindings.map((b) => this.eval(b.value, env));
        e.bindings.forEach((b, i) => inner.bind(b.name, values[i]!));
        return this.eval(e.body, inner);
      }

      case "LetStar": {
        // Sequential: each binding sees the ones before it.
        const inner = env.extend();
        this.frames++;
        for (const b of e.bindings) inner.bind(b.name, this.eval(b.value, inner));
        return this.eval(e.body, inner);
      }

      case "Cond": {
        for (const c of e.clauses) {
          if (c.test.type === "Var" && c.test.name === "else") return this.eval(c.body, env);
          if (this.truthy(this.eval(c.test, env))) return this.eval(c.body, env);
        }
        return V_VOID;
      }

      case "And": {
        let last: Value = V_BOOL(true);
        for (const a of e.args) {
          last = this.eval(a, env);
          if (!this.truthy(last)) return last;
        }
        return last;
      }

      case "Or": {
        for (const a of e.args) {
          const v = this.eval(a, env);
          if (this.truthy(v)) return v;
        }
        return V_BOOL(false);
      }

      case "Not":
        return V_BOOL(!this.truthy(this.eval(e.arg, env)));

      case "When":
        if (this.truthy(this.eval(e.cond, env))) return this.eval(e.body, env);
        return V_VOID;

      case "Unless":
        if (!this.truthy(this.eval(e.cond, env))) return this.eval(e.body, env);
        return V_VOID;

      case "Begin": {
        let last: Value = V_VOID;
        for (const x of e.exprs) last = this.eval(x, env);
        return last;
      }

      default: {
        const never: never = e;
        throw new TreeError(`no interpreter rule for ${(never as { type: string }).type}`);
      }
    }
  }

  /** Only `#f` is false. Everything else — including `()`, which Scheme also treats as true — is true. */
  private truthy(v: Value): boolean {
    return !(v.tag === "bool" && !v.b);
  }

  /**
   * Apply a closure, looping on tail calls.
   *
   * The interpreter implements tail calls, and that is a deliberate concession rather than a
   * cleverness. Without it a tail-recursive program of 100,000 iterations overflows the JS stack,
   * and the compiler's advantage would read as "it can run the program at all" — true, and the
   * single largest thing compiling buys, but it says nothing about how much *work* is saved. A
   * baseline that cannot run the program is not a baseline; the same mistake in the other direction
   * as comparing against a different algorithm.
   */
  private apply(fn: Callable, args: Value[]): Value {
    for (;;) {
      if (fn.tag === "primitive") return this.primitive(fn.name, args);

      // A **fresh** frame every iteration, including for a tail call. This looks like something a
      // smarter interpreter would avoid, and it is the one place where the interpreter cannot do
      // what the compiler does: a closure here holds a *reference* to the frame it was created in,
      // so reusing that frame would destroy the environment the closure still needs. Reusing it
      // safely requires knowing which variables each closure reads and copying them out at creation
      // time — which is exactly what closure conversion computes, and it is a compiler pass.
      //
      // So the interpreter allocates a frame per call where the compiled code reuses one. That is
      // not the interpreter being naive, it is the work the analysis removes.
      const frame = fn.env.extend();
      this.frames++;
      fn.params.forEach((p, i) => frame.bind(p, args[i] ?? V_VOID));

      const step = this.evalTail(fn.body, frame);
      if (step.kind === "value") return step.value;
      fn = step.fn;
      args = step.args;
    }
  }

  /**
   * Evaluate in tail position.
   *
   * The forms that pass tail position on to something inside them are `if`, `let`, `let*`, `begin`,
   * `cond`, `when` and `unless` — the same set the compiler's `mark-tail` pass has to know about.
   * Anything else is evaluated normally.
   */
  private evalTail(e: S0_Expr, env: Env): Step {
    this.tick();

    switch (e.type) {
      case "If": {
        const cond = this.eval(e.cond, env);
        return this.evalTail(this.truthy(cond) ? e.then : e.alt, env);
      }

      case "Let": {
        const inner = env.extend();
        const values = e.bindings.map((b) => this.eval(b.value, env));
        e.bindings.forEach((b, i) => inner.bind(b.name, values[i]!));
        return this.evalTail(e.body, inner);
      }

      case "LetStar": {
        const inner = env.extend();
        for (const b of e.bindings) inner.bind(b.name, this.eval(b.value, inner));
        return this.evalTail(e.body, inner);
      }

      case "Begin": {
        for (let i = 0; i < e.exprs.length - 1; i++) this.eval(e.exprs[i]!, env);
        const last = e.exprs[e.exprs.length - 1];
        return last === undefined ? { kind: "value", value: V_VOID } : this.evalTail(last, env);
      }

      case "Cond": {
        for (const c of e.clauses) {
          if (c.test.type === "Var" && c.test.name === "else") return this.evalTail(c.body, env);
          if (this.truthy(this.eval(c.test, env))) return this.evalTail(c.body, env);
        }
        return { kind: "value", value: V_VOID };
      }

      case "When":
        return this.truthy(this.eval(e.cond, env))
          ? this.evalTail(e.body, env)
          : { kind: "value", value: V_VOID };

      case "Unless":
        return !this.truthy(this.eval(e.cond, env))
          ? this.evalTail(e.body, env)
          : { kind: "value", value: V_VOID };

      case "App": {
        const fn = this.eval(e.func, env);
        if (!isCallable(fn)) throw new TreeError(`not a function: ${show(fn as Value)}`);
        return { kind: "tailcall", fn, args: e.args.map((a) => this.eval(a, env)) };
      }

      default:
        return { kind: "value", value: this.eval(e, env) };
    }
  }

  private primitive(name: string, args: Value[]): Value {
    if (name === "print") {
      this.output.push(show(args[0] ?? V_VOID));
      return V_VOID;
    }

    if (name === "cons") {
      this.allocs++;
      return { tag: "pair", car: args[0]!, cdr: args[1]! };
    }

    if (name === "car" || name === "cdr") {
      const p = args[0]!;
      if (p.tag !== "pair") throw new TreeError(`${name} of a non-pair: ${show(p)}`);
      return name === "car" ? p.car : p.cdr;
    }

    if (name === "null?") return V_BOOL(args[0]!.tag === "nil");

    if (name === "not") return V_BOOL(!this.truthy(args[0]!));

    // `(- x)` is negation. The compiler decides this in `resolve-primitives`; here it is decided
    // every time the subtraction runs.
    if (name === "-" && args.length === 1) {
      const a = args[0]!;
      if (a.tag !== "int") throw new TreeError(`- needs a number, got ${show(a)}`);
      return V_INT(-a.n);
    }

    const nums = args.map((a) => {
      if (a.tag !== "int") throw new TreeError(`${name} needs numbers, got ${show(a)}`);
      return a.n;
    });

    switch (name) {
      case "+":
        return V_INT(nums.reduce((a, b) => a + b, 0));
      case "*":
        return V_INT(nums.reduce((a, b) => a * b, 1));
      case "-":
        return V_INT(nums[0]! - nums[1]!);
      case "/": {
        if (nums[1] === 0) throw new TreeError("division by zero");
        return V_INT(Math.trunc(nums[0]! / nums[1]!));
      }
      case "modulo": {
        if (nums[1] === 0) throw new TreeError("modulo by zero");
        return V_INT(nums[0]! % nums[1]!);
      }
      case "<":
        return V_BOOL(nums[0]! < nums[1]!);
      case "<=":
        return V_BOOL(nums[0]! <= nums[1]!);
      case ">":
        return V_BOOL(nums[0]! > nums[1]!);
      case ">=":
        return V_BOOL(nums[0]! >= nums[1]!);
      case "=":
        return V_BOOL(nums[0]! === nums[1]!);
      default:
        throw new TreeError(`unknown primitive ${name}`);
    }
  }
}

/** Interpret a parsed program. `maxSteps` keeps a runaway program from hanging the test suite. */
export function runTree(program: S0_Program, maxSteps = 50_000_000): TreeRunResult {
  return new TreeInterp(maxSteps).run(program);
}
