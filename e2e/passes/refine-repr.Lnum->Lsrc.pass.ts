/**
 * 字面量细分：Lnum → Lsrc（t15）。
 *
 *   Num { value: 1,   repr: "1"   }  →  Int   { value: 1 }
 *   Num { value: 1.5, repr: "1.5" }  →  Float { value: 1.5 }
 *
 * 判据是 `repr`（源码原文），不是数值 —— 宿主里 `1` 和 `1.0` 都是同一个 number，
 * 只有原文能把它们分开。这也正是"读入器不该自己分"的原因（见 langs/Lnum.lang.ts）。
 *
 * ## 为什么要类型环境：这不是"每个字面量各判各的"
 *
 * 如果一个 pass 只是把每个 `Num` 按 `repr` 翻译一下，它不需要环境 —— 那就是个局部替换。
 * 但它还得回答一个**跨位置**的问题：同一条算术里的两个操作数是不是同一种数？
 *
 *     (+ x 1.5)   x 从 (let ((x 1)) …) 来 → Int；1.5 是 Float
 *
 * 这不是"两处各自拍脑袋"，是**对不上**。所以环境往下传（extra formals，不往上传）：
 * 绑定的地方把名字的表示记进去，用的地方拿出来对。对不上就报错，并带上位置。
 *
 * 往后传还是往上带？只要往下的。一趟深度优先 + 环境进出还原就够了 —— 一个名字的表示
 * 由**它的绑定**唯一决定，不需要从子节点往上汇合。所以 `sig` 只有一个值、arity = 1。
 *
 * ## 环境用"可变 + 还原"，不是每层复制
 *
 * 和 const-prop / global-const 一样的手法（同一个可变 Map 进出作用域保存/还原）。
 * 每层 `new Map(env)` 是 O(k²) —— t26 还过的那个债。
 */

import type { NodeOf } from "../../src/lang.ts";
import { pass, sig } from "../../src/pass.ts";
import { looksFloat } from "../s-expr.ts";
import { Lnum } from "../langs/Lnum.lang.ts";
import { Lsrc } from "../langs/Lsrc.lang.ts";

/** 一个东西的数字表示。整个优化层只认这两种。 */
export type Repr = "Int" | "Float";

type OutExpr = NodeOf<typeof Lsrc, "Expr">;
type OutBind = NodeOf<typeof Lsrc, "Bind">;

type Env = Map<string, Repr>;
type Ctx = [env: Env];
/**
 * arity = 1，所以 handler 返回 [节点, 环境]。
 *
 * **不要写成两个元组的联合**（比如 `[OutExpr, Env] | [OutDef, Env]`）—— 那样 TS 会在
 * 联合里挑错一支，报出 "Two different types with this name exist"，而那个报错看起来
 * 像是在说语言类型有问题（t24）。这里只有 Expr 的规则，所以就一个形状。
 */
type Res = [OutExpr, Env];

export class ReprError extends Error {}

/**
 * 这条 pass **显式写了 handler** 的那些 tag（t15 验收①要用的）。
 *
 * Lnum 的每个 tag 都得有个归宿：要么 Lsrc 里本来就有（identity 过去），要么在这里有规则。
 * 两边都没有的话 codegen 当场就报错（"产生式在 to 里没有对应项，而你又没给 handler"）——
 * 这个常量是给测试用的，让它能机械地验这一条，而不是靠"跑一遍看看崩不崩"。
 */
export const REFINED_TAGS: readonly string[] = ["Num", "Var", "Prim", "Let", "Letrec", "Lam"];

/** 读节点上的位置信息，报错要用。 */
function whereOf(x: unknown): string {
  const m = (x as { __meta__?: { file?: string; line?: number; col?: number } } | null)?.__meta__;
  if (m === undefined) return "（没有位置信息）";
  return `${m.file ?? "?"}:${m.line ?? "?"}${m.col !== undefined ? `:${m.col}` : ""}`;
}

/** 源码原文 → 表示。就这一条判据，和读入器用的是同一个函数（不另抄一份）。 */
export function reprOf(repr: string): Repr {
  return looksFloat(repr) ? "Float" : "Int";
}

/**
 * 会**提升**的算术：`Int ⊑ Float`。一条算术里只要有一个操作数是 Float，
 * 其余的就跟着当 Float 用（`(* 1.5 2)` 就是 —— 这是这语言本来的语义，
 * 也是 README 里的例子）。提升之后这条算术里就没有"混着"的字面量了。
 */
const PROMOTING = new Set(["+", "-", "*", "/"]);

/**
 * **只收整数**的原语。这才是"Int 位置"。
 *
 * 用户能看见的区别就在这：算术是"你自己看着办"（提升），而取模是真要整数的。
 * 给 `modulo` 一个 Float 就是实打实的类型错，报错、带位置。
 */
const INT_ONLY = new Set(["modulo"]);

export const refineRepr = pass({
  from: Lnum,
  to: Lsrc,
  sig: sig(new Map<string, Repr>()),
  init: (): Ctx => [new Map()],

  rules: {
    Expr: {
      // 这条就是整个 pass 的目的：笼统 → 具体
      Num: (n, _rec, env): Res => {
        const r = reprOf(n.repr);
        return [{ type: r, value: n.value } as OutExpr, env];
      },

      // 环境里记着的名字，直接取出来用（节点本身不变，还是 Var）
      Var: (n, _rec, env): Res => [{ type: "Var", name: n.name } as OutExpr, env],

      // 算术：算出每个操作数的表示，该提升的提升，该拦的拦
      Prim: (n, rec, env): Res => {
        const args: OutExpr[] = [];
        for (const a of n.args) {
          const [a2] = rec(a, env);
          args.push(a2);
        }

        const reprs = args.map((a) => reprOfNode(a, env));

        // ① 只收整数的原语：给它 Float 就是类型错
        if (INT_ONLY.has(n.op)) {
          const bad = reprs.findIndex((r) => r === "Float");
          if (bad >= 0) {
            throw new ReprError(
              `[refine-repr] ${whereOf(args[bad] ?? n)}：${n.op} 要整数，给了一个 Float。\n` +
                `  这条语言里 modulo 只收 Int —— 把 4.5 写成 4，或者改用能收小数的运算。`,
            );
          }
        }

        // ② 会提升的算术：有一个 Float，整条就是 Float
        if (PROMOTING.has(n.op) && reprs.some((r) => r === "Float")) {
          for (let i = 0; i < args.length; i++) {
            const a = args[i]!;
            // 能改的只有**字面量** —— 一个 Var 的表示在它的绑定处就定了，这里改不了
            // （那是往上带的方向，这条 pass 刻意只要往下传）
            if (a.type === "Int") args[i] = { type: "Float", value: a.value } as OutExpr;
          }
        }

        return [{ type: "Prim", op: n.op, args } as OutExpr, env];
      },

      // let 是平行的：绑定值在**外层**环境里求
      Let: (n, rec, env): Res => {
        const saved: [string, Repr | undefined][] = [];
        const bindings = n.bindings.map((b) => {
          const [b2] = rec(b, env);
          const r = reprOfNode(b2.value, env);
          saved.push([b.name, env.get(b.name)]);
          if (r !== undefined)
            env.set(b.name, r); // 记下来给体里用
          else env.delete(b.name);
          return b2;
        });
        const [body] = rec(n.body, env);
        for (const [name, old] of saved) {
          if (old === undefined) env.delete(name);
          else env.set(name, old);
        }
        return [{ type: "Let", bindings, body } as OutExpr, env];
      },

      Letrec: (n, rec, env): Res => {
        // letrec 的绑定互相可见：先全部登记再走（拿不到表示的按"不知道"处理）
        const saved: [string, Repr | undefined][] = [];
        const bindings = n.bindings.map((b) => {
          const [b2] = rec(b, env);
          const r = reprOfNode(b2.value, env);
          saved.push([b.name, env.get(b.name)]);
          if (r !== undefined) env.set(b.name, r);
          else env.delete(b.name);
          return b2;
        });
        const [body] = rec(n.body, env);
        for (const [name, old] of saved) {
          if (old === undefined) env.delete(name);
          else env.set(name, old);
        }
        return [{ type: "Letrec", bindings, body } as OutExpr, env];
      },

      // lambda 参数遮蔽外层同名；参数的表示这一层推不出来，所以标成"不知道"
      Lam: (n, rec, env): Res => {
        const saved: [string, Repr | undefined][] = [];
        for (const p of n.params) {
          saved.push([p.name, env.get(p.name)]);
          env.delete(p.name); // 参数会是什么数，这里不知道
        }
        const [body] = rec(n.body, env);
        for (const [name, old] of saved) {
          if (old === undefined) env.delete(name);
          else env.set(name, old);
        }
        return [{ type: "Lam", params: n.params, body } as OutExpr, env];
      },
    },
  },
});

/**
 * 一个已经细分好的节点是什么数字表示？
 *
 * 三种情况：字面量直接看 tag；`Var` 去环境里查（这是"类型环境往下传"真正被用到的
 * 地方）；其余一律 `undefined`（不知道）。**不知道不是冲突** —— 只比对知道的那些。
 */
function reprOfNode(x: unknown, env: Env): Repr | undefined {
  const n = x as { type?: string; name?: string } | null;
  const t = n?.type;
  if (t === "Int" || t === "Float") return t;
  if (t === "Var" && n?.name !== undefined) return env.get(n.name);
  return undefined;
}
