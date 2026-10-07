/**
 * Lowering: S14 to the SSA IR.
 *
 * This is the last nanopass-shaped step. What comes out is basic blocks with explicit jumps and
 * branches — the shape the SSA layer works on. After this point there are no trees.
 *
 * ── Where the frames come from
 *
 * `convert-closures` already arranged that a lifted function's parameters *are* its frame slots,
 * `f0, f1, ...` for captures then `p0, p1, ...` for arguments. So a parameter needs no instruction:
 * the interpreter seeds a frame with those names, and a reference to one lowers to a bare use of
 * that name. That is also why the SSA framework has to tolerate a read that no definition reaches
 * — parameters and globals arrive from outside the function.
 *
 * ── Blocks
 *
 * `if` is the only node that splits control flow. Lowering one creates three blocks: the two
 * branches and a join, with a phi in the join for the value. In tail position there is no join: both
 * branches end the block, one with a `ret` and one with a `tailcall`.
 *
 * A block's terminator is filled in by whoever created it, and the builder refuses to emit an
 * instruction into a block that already has one. A block left without a terminator is an internal
 * error rather than something a later pass has to guess about.
 */

import type { BasicBlock, BlockId, Instruction, SSAFunction, ValueId } from "../../src/ssa/ir.ts";
import type { PrimOp, SchemeInstr, SchemeNode } from "./ir.ts";
import type { S14_Expr, S14_Program } from "./langs/chain.ts";

/** Every function, keyed by name, plus the name to start at. */
export interface LoweredProgram {
  readonly functions: Map<string, SSAFunction<SchemeNode>>;
  /** The function that runs the program body. */
  readonly entry: string;
}

export class LoweringError extends Error {}

const ENTRY = "$main";

/**
 * Operators that look like calls in the source but are not functions anywhere in the program.
 *
 * `print` is the only one, and it is the program's only observable effect. It gets a real function
 * with a real frame rather than a special case in the interpreter's call path: a call is a call, and
 * nothing downstream has to know which names are built in.
 */
function builtinFunctions(): Map<string, SSAFunction<SchemeNode>> {
  const print: SSAFunction<SchemeNode> = {
    id: "print",
    entry: "entry",
    blocks: new Map([
      [
        "entry",
        {
          id: "entry",
          instructions: [{ type: "print", value: "p0" }],
          terminator: { type: "ret" },
          predecessors: [],
          successors: [],
        },
      ],
    ]),
  };
  return new Map([["print", print]]);
}

/** The built-in functions, so anything assembling a module can include them. */
export const BUILTINS = builtinFunctions();

export function lower(program: S14_Program): LoweredProgram {
  const functions = new Map<string, SSAFunction<SchemeNode>>();

  // Names bound at the top level. A reference to one of these from inside a function is a
  // reference to a global, not to a local that happens to be missing.
  const fnNames = new Set<string>();
  const globalNames = new Set<string>();
  for (const d of program.defs) {
    if (d.type === "DefFun") fnNames.add(d.name);
    else globalNames.add(d.name);
  }

  for (const [name, fn] of BUILTINS) {
    functions.set(name, fn);
    fnNames.add(name);
  }

  const main = new FnBuilder(ENTRY, fnNames, globalNames);

  // Top-level bindings are evaluated once, before the body, in the order they were written.
  for (const d of program.defs) {
    if (d.type === "DefFun") {
      functions.set(d.name, lowerFunction(d, fnNames, globalNames));
    } else {
      main.emit({ type: "global-set", name: d.name, value: main.lowerExpr(d.value) });
    }
  }

  const body = program.body;
  if (body.length === 0) {
    main.terminateRet(undefined);
  } else {
    for (let i = 0; i < body.length - 1; i++) main.lowerExpr(body[i]!);
    main.lowerTail(body[body.length - 1]!);
  }
  functions.set(ENTRY, main.finish());

  return { functions, entry: ENTRY };
}

function lowerFunction(
  def: { name: string; params: string[]; body: S14_Expr },
  fnNames: ReadonlySet<string>,
  globalNames: ReadonlySet<string>,
): SSAFunction<SchemeNode> {
  const b = new FnBuilder(def.name, fnNames, globalNames);
  // A parameter needs no instruction: `convert-closures` already named every parameter after the
  // frame slot it lives in, and the interpreter seeds a frame with those names. So the binding is
  // the identity, and a read of `p0` lowers to a bare use of `p0`.
  for (const p of def.params) b.bind(p, p);
  b.lowerTail(def.body);
  return b.finish();
}

// ───────────────────────── The builder ─────────────────────────

class FnBuilder {
  private readonly id: string;
  private readonly fnNames: ReadonlySet<string>;
  private readonly globalNames: ReadonlySet<string>;
  private readonly blocks = new Map<BlockId, BasicBlock<SchemeNode>>();
  private readonly closed = new Set<BlockId>();
  /** The block currently being filled. `goto` and the `terminate*` methods move it. */
  private readonly entryId: BlockId;
  private current: BasicBlock<SchemeNode>;
  private nextBlock = 0;
  private nextValue = 0;
  private nextVar = 0;

  constructor(
    id: string,
    fnNames: ReadonlySet<string> = new Set(),
    globalNames: ReadonlySet<string> = new Set(),
  ) {
    this.id = id;
    this.fnNames = fnNames;
    this.globalNames = globalNames;
    this.current = this.newBlock("entry");
    this.entryId = this.current.id;
  }

  finish(): SSAFunction<SchemeNode> {
    // A block that was created but never given a terminator still carries the `unreachable`
    // placeholder. That is a bug in the builder, not a fact about the program, and a later pass
    // would happily propagate it — so say so here instead.
    for (const bid of this.blocks.keys()) {
      if (!this.closed.has(bid)) throw new LoweringError(`${this.id}:${bid} was never terminated`);
    }
    return { id: this.id, blocks: this.blocks, entry: this.entryId };
  }

  // ── Structure ──

  private newBlock(hint: string): BasicBlock<SchemeNode> {
    const id = `${hint}${this.nextBlock++}`;
    const b: BasicBlock<SchemeNode> = {
      id,
      instructions: [],
      terminator: { type: "unreachable" },
      predecessors: [],
      successors: [],
    };
    this.blocks.set(id, b);
    return b;
  }

  emit(inst: Instruction<SchemeNode>): void {
    this.freshGuard();
    this.current.instructions.push(inst);
  }

  private freshGuard(): void {
    if (this.closed.has(this.current.id)) {
      throw new LoweringError(`${this.id}:${this.current.id} already ended, cannot emit more`);
    }
  }

  private fresh(): ValueId {
    return `%${this.nextValue++}`;
  }

  /**
   * A name for a value that is produced in more than one place.
   *
   * The `$` prefix marks it as the compiler's, not the program's, and keeps it out of the way of
   * the `%` names the SSA construction generates.
   */
  private freshVariable(): ValueId {
    return `$v${this.nextVar++}`;
  }

  /**
   * Give the current block a terminator and make `next` current.
   *
   * The builder holds one "current" block, so this is how control flows from here on. Predecessor
   * and successor lists are maintained here rather than derived later: an edge that is never
   * recorded is an edge Braun would not see, and a phi missing an operand is a runtime failure.
   */
  private split(hint: string): BasicBlock<SchemeNode> {
    return this.newBlock(hint);
  }

  // ── Terminators ──

  terminateRet(value: ValueId | undefined): void {
    this.freshGuard();
    this.current.terminator = value === undefined ? { type: "ret" } : { type: "ret", value };
    this.closed.add(this.current.id);
  }

  private terminateJump(target: BasicBlock<SchemeNode>): void {
    this.freshGuard();
    this.current.terminator = { type: "jump", target: target.id };
    this.current.successors.push(target.id);
    target.predecessors.push(this.current.id);
    this.closed.add(this.current.id);
  }

  private terminateBranch(cond: ValueId, t: BasicBlock<SchemeNode>, f: BasicBlock<SchemeNode>): void {
    this.freshGuard();
    this.current.terminator = { type: "branch", cond, ifTrue: t.id, ifFalse: f.id };
    this.current.successors.push(t.id, f.id);
    t.predecessors.push(this.current.id);
    f.predecessors.push(this.current.id);
    this.closed.add(this.current.id);
  }

  private terminateTailcall(callee: ValueId, args: readonly ValueId[]): void {
    this.freshGuard();
    this.current.terminator = { type: "tailcall", callee, args: [...args] };
    this.closed.add(this.current.id);
  }

  // ── Expressions, producing a value ──

  /**
   * Lower `e` so that it produces a value.
   *
   * Never called on a `Tail` node: those only appear where a block ends, and `lowerTail` is what
   * handles them.
   */
  lowerExpr(e: S14_Expr): ValueId {
    switch (e.type) {
      case "Int": {
        const d = this.fresh();
        this.emit({ type: "const", dest: d, value: e.value });
        return d;
      }

      case "Bool": {
        const d = this.fresh();
        this.emit({ type: "const", dest: d, value: e.value });
        return d;
      }

      case "Void": {
        const d = this.fresh();
        this.emit({ type: "void", dest: d });
        return d;
      }

      case "Nil": {
        const d = this.fresh();
        this.emit({ type: "nil", dest: d });
        return d;
      }

      case "Var":
        return this.lowerVar(e.name);

      case "Prim": {
        const args = e.args.map((a) => this.lowerExpr(a));
        const d = this.fresh();

        // `cons`, `car` and `cdr` are their own node kinds in the IR — they are the allocation and
        // the two projections, which the benchmarks count — so they do not go through `prim`.
        switch (e.op) {
          case "cons":
            this.emit({ type: "cons", dest: d, car: args[0]!, cdr: args[1]! });
            return d;
          case "car":
            this.emit({ type: "car", dest: d, pair: args[0]! });
            return d;
          case "cdr":
            this.emit({ type: "cdr", dest: d, pair: args[0]! });
            return d;
          default:
            this.emit({ type: "prim", dest: d, op: e.op as PrimOp, args });
            return d;
        }
      }

      case "Let": {
        const v = this.lowerExpr(e.value);
        // Names are unique after alpha-rename, so a binding never shadows: the environment can be
        // a flat map with no save and restore.
        this.env.set(e.name, v);
        return this.lowerExpr(e.body);
      }

      case "If": {
        const cond = this.lowerExpr(e.cond);
        const thenBlock = this.split("then");
        const altBlock = this.split("else");
        const joinBlock = this.split("join");
        this.terminateBranch(cond, thenBlock, altBlock);

        // Both arms name their result the same thing. That is the whole trick: the SSA construction
        // sees one variable defined twice and puts a phi where the definitions meet. Emitting the
        // phi here instead would be wrong twice over — the framework's input is variable-based and
        // its walk skips phis it did not create.
        const merged = this.freshVariable();

        this.current = thenBlock;
        this.emit({ type: "copy", dest: merged, src: this.lowerExpr(e.then) });
        this.terminateJump(joinBlock);

        this.current = altBlock;
        this.emit({ type: "copy", dest: merged, src: this.lowerExpr(e.alt) });
        this.terminateJump(joinBlock);

        this.current = joinBlock;
        return merged;
      }

      case "MakeClosure": {
        const d = this.fresh();
        this.emit({
          type: "make-closure",
          dest: d,
          fn: e.fn,
          free: e.free.map((f) => this.lowerExpr(f)),
        });
        return d;
      }

      case "Call": {
        const d = this.fresh();
        this.emit({
          type: "call",
          dest: d,
          callee: this.lowerExpr(e.fn),
          args: e.args.map((a) => this.lowerExpr(a)),
        });
        return d;
      }

      case "Tail":
        throw new LoweringError("a Tail node reached lowerExpr; tail position goes through lowerTail");

      default: {
        // `e` is a never here if the switch above covers S14_Expr. Reaching this means the chain
        // gained a node the lowering does not know, which should be a compile error rather than a
        // silent miscompile.
        const unreachable: never = e;
        throw new LoweringError(`no lowering for ${(unreachable as { type: string }).type}`);
      }
    }
  }

  /** A bare name: a local, a top-level function, or a global. */
  private lowerVar(name: string): ValueId {
    const local = this.env.get(name);
    if (local !== undefined) return local;

    const d = this.fresh();
    if (this.fnNames.has(name)) {
      this.emit({ type: "func-ref", dest: d, fn: name });
      return d;
    }
    if (this.globalNames.has(name)) {
      this.emit({ type: "global-ref", dest: d, name });
      return d;
    }
    throw new LoweringError(`${this.id}: ${name} is not a parameter, a let binding, or top-level`);
  }

  private readonly env = new Map<string, ValueId>();

  /** Record a name as already holding a value — a parameter, whose slot the frame seeds. */
  bind(name: string, value: ValueId): void {
    this.env.set(name, value);
  }

  // ── Expressions, ending a block ──

  /**
   * Lower `e` as the last thing a function does.
   *
   * `mark-tail` marks tail positions, but it does not wrap a node that has no value of its own, so
   * an `if` and a `let` are seen here unwrapped. Their insides are in tail position; everything else
   * arrives wrapped in `Tail`.
   */
  lowerTail(e: S14_Expr): void {
    if (e.type === "If") {
      const cond = this.lowerExpr(e.cond);
      const thenBlock = this.split("then");
      const altBlock = this.split("else");
      this.terminateBranch(cond, thenBlock, altBlock);

      // No join block: each branch leaves the function, so there is no value to merge.
      this.current = thenBlock;
      this.lowerTail(e.then);

      this.current = altBlock;
      this.lowerTail(e.alt);
      return;
    }

    if (e.type === "Let") {
      const v = this.lowerExpr(e.value);
      this.env.set(e.name, v);
      this.lowerTail(e.body);
      return;
    }

    if (e.type !== "Tail") {
      throw new LoweringError(`${this.id}: ${e.type} in tail position was not marked by mark-tail`);
    }

    const x = e.expr;
    if (x.type === "Call") {
      // The whole point of tail position: this call replaces the frame instead of growing the
      // stack, and a self call is what the loop-conversion pass later turns into a jump.
      this.terminateTailcall(
        this.lowerExpr(x.fn),
        x.args.map((a) => this.lowerExpr(a)),
      );
      return;
    }

    this.terminateRet(this.lowerExpr(x));
  }
}
