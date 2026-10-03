/**
 * 单遍常量传播：把「已知是字面量」的变量引用换成那个字面量。
 *
 *   (let ((x 5)) (+ x 1))            → (let ((x 5)) (+ 5 1))    然后 constantFold 折成 6
 *   (define k 7) … k                 → … 7                       （顶层定义进初始环境）
 *   ((lambda (x) (+ x 1)) 2)         → 参数不知道 → 不动
 *   (letrec ((f (lambda () 1))) (f)) → letrec 的绑定一律不知道 → 不动
 *
 * 用的是 G1 的**往下传**：一个环境（变量名 → 字面量节点，不在表里就是不认识）。
 *
 * 和 dce 正好是镜像 —— dce 只需要往上带（"这个子树引用了谁"），这个只需要往下传
 * （"现在是哪些名字的值已知"）。所以这三条 pass（uncoverFree 两条都用、dce 只用上、
 * 这条只用下）把 G1 的两个方向都压到了，而且各自都证明另一个方向不必要。
 *
 * ── 环境用「可变 + 还原」，不是每绑一个名字复制一份
 *
 * 第一版 `bind()` 是 `new Map(env)` —— k 层嵌套 let 就是 O(k²)（和 dce 同一族，
 * 实测放大 k 时比值 4.90）。现在进出作用域时保存/还原同一个 Map：
 * 每个绑定 O(1)，整体线性。
 *
 * ── 线程：环境**不参与线程**
 *
 * 线程模型的默认行为是"一个子节点吐出来的 extra 喂给下一个兄弟"。这里不能那样用 ——
 * 环境是**作用域**，兄弟节点看到的是同一个环境，不是前一个改过的。
 *
 * 做法：handler 显式把环境喂给子节点（`rec(child, env)`），然后**原样返回**手里的环境。
 * 这样自动线程传下去的永远是同一个环境，兄弟之间互不影响。
 *
 * 顺带：这是一条 **from === to** 的 pass（语言不变），优化层里这是主模式。
 */

import type { NodeOf } from "../../src/nanopass/lang.ts";
import { pass, sig } from "../../src/nanopass/pass.ts";
import { L6 } from "../langs/L6.lang.ts";

type Expr = NodeOf<typeof L6, "Expr">;
type Def = NodeOf<typeof L6, "Def">;
type Program = NodeOf<typeof L6, "Program">;

/** 名字 → 它已知的字面量。不在表里 = 不认识（⊤）。可变，进出作用域时还原。 */
type Env = Map<string, Expr>;

type Ctx = [env: Env];

/** 读节点上的框架字段。节点类型里没有 __meta__（那是刻意的，见 src/lang.ts）。 */
function metaOf(x: unknown): unknown {
  return (x as { __meta__?: unknown }).__meta__;
}

function literalOf(e: Expr): Expr | null {
  switch (e.type) {
    case "Int":
    case "Float":
    case "Bool":
    case "Str":
      return e;
    default:
      return null;
  }
}

interface Scope {
  readonly saved: (readonly [string, Expr | undefined])[];
}

/**
 * 把一批名字装进环境（值不是字面量的就删掉，避免用到旧的），返回用来还原的旧值。
 * O(每个名字)。
 */
function bindAll(env: Env, binds: readonly (readonly [string, Expr | null])[]): Scope {
  const saved: (readonly [string, Expr | undefined])[] = [];
  for (const [name, lit] of binds) {
    saved.push([name, env.get(name)]);
    if (lit === null) env.delete(name);
    else env.set(name, lit);
  }
  return { saved };
}

function restore(env: Env, scope: Scope): void {
  for (const [name, prev] of scope.saved) {
    if (prev === undefined) env.delete(name);
    else env.set(name, prev);
  }
}

export const constProp = pass({
  from: L6,
  to: L6,
  sig: sig(new Map<string, Expr>()),
  init: (): Ctx => [new Map()],

  rules: {
    // 顶层：定义按顺序过，字面量的记进环境，后面的定义和体都能看见
    Program: {
      Prog: (n, rec, env): [Program, Env] => {
        const defs: Def[] = [];
        const top: [string, Expr | null][] = [];
        for (const d of n.defs) {
          const [dd] = rec(d, env);
          defs.push(dd);
          if (d.type === "DefVal") {
            const value = ((dd as { value?: unknown }).value ?? { type: "Void" }) as Expr;
            top.push([d.name, literalOf(value)]);
          }
        }
        const scope = bindAll(env, top);
        const body = n.body.map((e) => rec(e, env)[0]);
        restore(env, scope);
        return [{ type: "Prog", defs, body }, env];
      },
    },

    Expr: {
      Var: (n, _rec, env): [Expr, Env] => {
        const known = env.get(n.name);
        // 换成字面量时保住位置 —— 不然报错就找不到它原来在哪了
        if (known !== undefined) {
          const copy = { ...known } as Expr;
          const m = metaOf(n);
          if (m !== undefined) (copy as { __meta__?: unknown }).__meta__ = m;
          return [copy, env];
        }
        return [{ type: "Var", name: n.name }, env];
      },

      Let: (n, rec, env): [Expr, Env] => {
        // let 的绑定值在**外层**作用域求值 —— 用 env，不用扩展过的
        const binds: [string, Expr | null][] = [];
        const bindings: { type: "Bind"; name: string; value: Expr }[] = [];
        for (const b of n.bindings) {
          const [value] = rec(b.value, env);
          bindings.push({ type: "Bind", name: b.name, value });
          binds.push([b.name, literalOf(value)]);
        }

        const scope = bindAll(env, binds);
        const [body] = rec(n.body, env);
        restore(env, scope);

        // 返回**原样**的 env：兄弟节点看到的是同一个环境
        return [{ type: "Let", bindings, body }, env];
      },

      Letrec: (n, rec, env): [Expr, Env] => {
        // letrec 的绑定值互相可见，任何静态都推不准 —— 一律当"不认识"。
        // （想做准就得不动点，那是 t13 的事。）
        const scope = bindAll(
          env,
          n.bindings.map((b) => [b.name, null] as [string, Expr | null]),
        );
        const bindings = n.bindings.map((b) => {
          const [value] = rec(b.value, env);
          return { type: "Bind" as const, name: b.name, value };
        });
        const [body] = rec(n.body, env);
        restore(env, scope);
        return [{ type: "Letrec", bindings, body }, env];
      },

      Lam: (n, rec, env): [Expr, Env] => {
        // 参数是此 lambda 自己的绑定，值不知道 —— 装成"不认识"
        const scope = bindAll(
          env,
          n.params.map((p) => [p.name, null] as [string, Expr | null]),
        );
        const params = n.params.map((p) => rec(p, env)[0]);
        const [body] = rec(n.body, env);
        restore(env, scope);
        return [{ type: "Lam", params, body }, env];
      },
    },
  },
});
