/**
 * Lcore（L7）的解释器。
 *
 * 这是判定标准的另一半：`eval(全链(src)) === 期望值`。
 * 没有它，多 pass 的链只能断言"tag 看着对"，那是装饰品。
 *
 * 用的是 JS 自己的 number / boolean / string，没有装箱，也没有类型标签 ——
 * 类型细化那期（Lnum → Lrepr）会把这门语言换掉，那时这里才需要分 int/float。
 */

import type { NodeOf } from "../src/nanopass/lang.ts";
import type { L7 } from "./langs/L7.lang.ts";

type Expr = NodeOf<typeof L7, "Expr">;
type Program = NodeOf<typeof L7, "Program">;

export class EvalError extends Error {}

export interface Closure {
  readonly kind: "closure";
  readonly name: string;
  readonly params: readonly string[];
  readonly body: Expr;
  readonly env: Env;
}

export type Value = number | boolean | string | undefined | Closure;

function isClosure(v: Value): v is Closure {
  return typeof v === "object" && v !== null && (v as Closure).kind === "closure";
}

/** 变量表。链式的，所以查一个变量是 O(作用域深度) —— 深度很小，且不随程序规模长。 */
export class Env {
  private readonly vars = new Map<string, Value>();
  private readonly parent: Env | null;

  // **不要用参数属性**（`constructor(private readonly parent: ...)`）—— node 的
  // strip-only 模式只擦类型、不生成代码，参数属性要求"生成一个赋值"，所以它不允许
  // （ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）。Bun 容忍，所以只有真 node 跑得出来。
  constructor(parent: Env | null = null) {
    this.parent = parent;
  }

  child(): Env {
    return new Env(this);
  }

  define(name: string, value: Value): void {
    this.vars.set(name, value);
  }

  lookup(name: string): Value {
    let e: Env | null = this;
    while (e !== null) {
      if (e.vars.has(name)) return e.vars.get(name);
      e = e.parent;
    }
    throw new EvalError(`未绑定的变量：${name}`);
  }
}

// ───────────────────────── 原语 ─────────────────────────

function numArith(op: string, args: Value[]): Value {
  const ns = args.map((a) => {
    if (typeof a !== "number") throw new EvalError(`${op}: 期望数字，拿到 ${show(a)}`);
    return a;
  });
  const first = ns[0];
  if (first === undefined) throw new EvalError(`${op}: 至少要一个操作数`);

  switch (op) {
    case "+":
      return ns.reduce((a, b) => a + b, 0);
    case "*":
      return ns.reduce((a, b) => a * b, 1);
    case "-":
      return ns.length === 1 ? -first : ns.slice(1).reduce((a, b) => a - b, first);
    case "/":
      return ns.length === 1 ? 1 / first : ns.slice(1).reduce((a, b) => a / b, first);
    case "modulo":
      if (ns.length !== 2) throw new EvalError("modulo: 要两个操作数");
      return first % ns[1]!;
    case "<":
      return ns.every((n, i) => i === 0 || ns[i - 1]! < n);
    case "=":
      return ns.every((n, i) => i === 0 || ns[i - 1]! === n);
    default:
      throw new EvalError(`不认识的原语：${op}`);
  }
}

/**
 * 值 → 给人看的样子。用 lisp 的写法（`#t` / `#f` / `#<void>` / `#<closure>`），
 * 因为输入里就是这么写的 —— 两边不一致会很难读。
 */
function show(v: Value): string {
  if (isClosure(v)) return "#<closure>";
  if (v === undefined) return "#<void>";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "#t" : "#f";
  return String(v);
}

export { show };

/**
 * 算术原语本身，给**常量传播的抽象求值**用。
 *
 * 导出来是为了只有一份真相：`(define x (+ 1 2))` 的抽象求值必须和真的跑一遍结果一致，
 * 各写一份迟早会分叉（比如 `-` 的一元取负、`<` 是链式比较这些细节）。
 */
export { numArith as evalPrimConst };

// ───────────────────────── 求值 ─────────────────────────

function evalExpr(e: Expr, env: Env): Value {
  switch (e.type) {
    case "Void":
      return undefined;
    case "Int":
    case "Float":
      return e.value;
    case "Bool":
      return e.value;
    case "Str":
      return e.value;

    case "Var":
      return env.lookup(e.name);

    case "If": {
      const c = evalExpr(e.cond, env);
      if (typeof c !== "boolean") throw new EvalError(`if 的条件必须是 bool，拿到 ${show(c)}`);
      return c ? evalExpr(e.then, env) : evalExpr(e.alt, env);
    }

    case "Begin": {
      let last: Value = undefined;
      for (const x of e.exprs) last = evalExpr(x, env);
      return last;
    }

    // let：绑定在**外层**环境里求值，所以是并行的
    case "Let": {
      const inner = env.child();
      for (const b of e.bindings) inner.define(b.name, evalExpr(b.value, env));
      return evalExpr(e.body, inner);
    }

    // letrec：先把名字全占上，再各自求值 —— 所以能互相递归
    case "Letrec": {
      const inner = env.child();
      for (const b of e.bindings) inner.define(b.name, undefined);
      for (const b of e.bindings) inner.define(b.name, evalExpr(b.value, inner));
      return evalExpr(e.body, inner);
    }

    // Lam 的体现在包着一层 BindFree（自由变量清单），运行期直接穿过去 ——
    // 它是给闭包转换用的元数据，不影响求值。
    case "Lam": {
      const cl: Closure = {
        kind: "closure",
        name: "lambda",
        params: e.params.map((p) => p.name),
        body: e.body.body,
        env,
      };
      return cl;
    }

    case "Call": {
      const fn = evalExpr(e.fn, env);
      const args = e.args.map((a) => evalExpr(a, env));
      return apply(fn, args, e.fn);
    }

    case "Prim":
      return numArith(
        e.op,
        e.args.map((a) => evalExpr(a, env)),
      );

    default: {
      // 有新产生式没在这里处理 —— 编译期就该拦住的，这里只是兜底
      const never: never = e;
      throw new EvalError(`解释器不认识这个产生式：${JSON.stringify(never).slice(0, 80)}`);
    }
  }
}

function apply(fn: Value, args: Value[], where: Expr): Value {
  if (!isClosure(fn)) {
    throw new EvalError(`不是函数：${show(fn)}（在 ${where.type} 位置调用）`);
  }
  if (fn.params.length !== args.length) {
    throw new EvalError(`参数个数不对：要 ${fn.params.length} 个，给了 ${args.length}`);
  }
  const inner = fn.env.child();
  fn.params.forEach((p, i) => inner.define(p, args[i]!));
  return evalExpr(fn.body, inner);
}

/**
 * 跑一个 Lcore 程序：定义进全局环境，体按顺序求值，返回最后一个的值。
 */
export function runProgram(prog: Program, globals: Env = new Env()): Value {
  for (const d of prog.defs) {
    if (d.type === "DefVal") globals.define(d.name, evalExpr(d.value, globals));
  }
  let last: Value = undefined;
  for (const e of prog.body) last = evalExpr(e, globals);
  return last;
}
