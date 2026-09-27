/**
 * 全局常量传播，跑到不动点（t14）。
 *
 *   (define x 1)        (define x 1)
 *   (define y x)        (define y 1)        ← 把已知常量代进去
 *   (define z (+ y 1))  (define z (+ 1 1))  ← 还没折，但下一轮就知道 y 是常量了
 *   z                   z
 *
 * ── 和 const-prop 的区别：那个是单遍，这个是跑到不动点
 *
 * 单遍那个（`const-prop.L6.pass.ts`）够用是因为它只做**往下看**的事：走一遍树，手里拿着
 * "现在哪些名字的值已知"，看见 `Var` 就替换。往下看走一遍就是终点。
 *
 * 这条不一样：它推的是**全局定义之间的链**。`z` 依赖 `y`，`y` 依赖 `x` —— 代进去之后
 * 定义本身变成了新的字面量，那又给下一轮提供了新信息。所以要么拓扑序一次到位，
 * 要么反复跑到不动点。这里选**跑到不动点**（`fixpoint` 驱动），因为它对定义顺序不敏感：
 * 前面有定义引用了后面才定义的常量，也能收敛。
 *
 * ── 结论存在一个带类型的格里
 *
 * 见 `lattice.ts`。要点：同一个名字可能从几个地方推出结论，`join` 取共同信息。
 * `(define x (if c 1 2))` 里 c 不知道 → 两支 join：
 *
 *     Const(1, Int) ⊔ Const(2, Int) = Ty(Int)
 *
 * **值丢了（不再拿它替换变量），类型还在。** 验收里说"merge 成 ⊤"，说的是同一件事
 * ——"值不再往下传"。多留的那点类型信息正是格带了类型才有的，所以这里不是 ⊤。
 * 真的 ⊤ 留给"类型都推不出来"的情况（两支类型不同）。
 *
 * ── 作用域：不能替换被遮蔽的名字
 *
 * `(let ((x 1)) x)` 里的 `x` 是局部绑定，不能换成外层的常量。做法跟 const-prop 一样：
 * 进作用域把局部名字设成 ⊥（"不知道"），出来还原。**同一个可变 Map 保存/还原**，
 * 不是每层复制一份 —— 复制就是 O(k²)（t26 还过的那个债）。
 *
 * ── 位置：放在 uncover-free **之前**
 *
 * 它替掉一个变量引用，那个名字就不再是"自由变量"了。要是放在 uncover-free 后面，
 * `BindFree.names` 就会留下来一份**过期的**自由变量表。放在前面就没这个问题。
 *
 * ── from === to，而且真的"没改就返回原对象"
 *
 * 这样 `fixpoint` 的判定才是一次 `===`（t13）。`Prog` 那个 handler 自己盯着 changed，
 * 其余节点交给生成的 identity 路径（它已经会"子节点都没变就返回原节点"）。
 */

import type { NodeOf } from "../../src/lang.ts";
import { pass, sig } from "../../src/pass.ts";
import { evalPrimConst } from "../eval.ts";
import { step } from "../runner.ts";
import { fixpoint } from "../fixpoint.ts";
import { L6 } from "../langs/L6.lang.ts";
import { BOT, TOP, join, latOfLit, litNode, tyOfValue, type Lat } from "../lattice.ts";

type Expr = NodeOf<typeof L6, "Expr">;
type Def = NodeOf<typeof L6, "Def">;
type Program = NodeOf<typeof L6, "Program">;

/** 名字 → 推出来的结论。不在表里 = ⊥。可变，进出作用域时保存/还原。 */
type Env = Map<string, Lat>;

type Ctx = [env: Env];

/** arity > 0 时 handler 必须返回元组：[节点, extra]。 */
type Res = [Expr, Env];

const ARITH = new Set(["+", "-", "*", "/"]);
const CMP = new Set(["<", "="]);

/** 一个表达式的抽象求值：能推出多少信息就推多少。 */
function latFromExpr(e: unknown, env: Env): Lat {
  const lit = latOfLit(e);
  if (lit.k === "const") return lit;
  if (e === null || typeof e !== "object" || Array.isArray(e)) return BOT;

  const n = e as Record<string, unknown>;
  switch (n["type"]) {
    case "Var":
      return env.get(String(n["name"])) ?? BOT;

    case "Lam":
      // 不知道是哪个函数，但知道**是个**函数 —— 这就是格带类型的好处
      return { k: "ty", ty: "Fn" };

    case "Prim": {
      const op = String(n["op"]);
      const lats = ((n["args"] ?? []) as unknown[]).map((a) => latFromExpr(a, env));
      if (lats.every((l) => l.k === "const")) {
        try {
          const v = evalPrimConst(op, lats.map((l) => (l as Extract<Lat, { k: "const" }>).value) as never);
          const ty = tyOfValue(v);
          if (ty !== null) return { k: "const", value: v as never, ty };
        } catch {
          // 参数是常量但算不出来（比如 "(+ "hi" 1)"）—— 这是运行期错误，交给真跑
        }
        return TOP;
      }
      // 值不全知道，但类型可能推得出来
      if (CMP.has(op)) return { k: "ty", ty: "Bool" };
      if (ARITH.has(op)) {
        const anyFloat =
          lats.some((l) => l.k === "ty" && l.ty === "Float") ||
          lats.some((l) => l.k === "const" && l.ty === "Float");
        return { k: "ty", ty: anyFloat ? "Float" : "Int" };
      }
      return TOP;
    }

    case "If": {
      const c = latFromExpr(n["cond"], env);
      const a = latFromExpr(n["then"], env);
      const b = latFromExpr(n["alt"], env);
      if (c.k === "const") {
        if (c.value === true) return a;
        if (c.value === false) return b;
        return TOP; // 条件不是布尔 —— 运行期会报错，这里不猜
      }
      // 条件不知道：取两支的共同信息。**值丢了，类型可能还在**
      return join(a, b);
    }

    default:
      return TOP;
  }
}

/**
 * 扫一遍顶层定义，求出全局环境。
 *
 * 按**定义顺序**扫，后面的定义能看到前面的结论 —— 这在没有前向引用时一次就够，
 * 有前向引用时靠 `fixpoint` 再来一轮。
 */
function globalEnv(defs: readonly Def[]): Env {
  const env: Env = new Map();
  for (const d of defs) {
    if (d.type !== "DefVal") continue;
    const lat = latFromExpr(d.value, env);
    env.set(d.name, join(env.get(d.name) ?? BOT, lat));
  }
  return env;
}

/** 设一组名字为 ⊥（遮蔽），返回还原用的现场。 */
function shadow(env: Env, names: readonly string[]): [string, Lat | undefined][] {
  const saved: [string, Lat | undefined][] = [];
  for (const name of names) {
    saved.push([name, env.get(name)]);
    env.set(name, BOT);
  }
  return saved;
}

function restore(env: Env, saved: readonly [string, Lat | undefined][]): void {
  for (const [name, old] of saved) {
    if (old === undefined) env.delete(name);
    else env.set(name, old);
  }
}

const raw = pass({
  from: L6,
  to: L6,
  sig: sig(new Map<string, Lat>()),
  // 入口处还没有任何全局信息，给个空环境；真的环境由下面那条 Program 规则算出来往下穿。
  init: (): Ctx => [new Map<string, Lat>()],

  rules: {
    /**
     * 「先扫一遍顶层定义，再带着这份环境往下走」—— 终于写在它该在的地方。
     *
     * 以前这条规则**写不出来**（在 `Program` 上挂规则 + 这个 pass 有 `sig` → TS2589，
     * t24），只能把全局环境藏在 `run` 里用闭包喂给 extra 的初值。代价是这条 pass 不是
     * 纯 `pass()` 的产物，而是手搭的 Step（`opaque` / `rebuild` / 后来的 `loop.setup`
     * 都是这么欠下来的债）。`NoInfer` 修掉之后，它就是一条普通规则。
     *
     * 顺带修掉一个**真错**：环境现在**每一轮重算**（不动点每轮都会重新进这里），
     * 而以前是每次 `run` 算一次、后面几轮用的是第一轮的旧环境。
     */
    Program: {
      Prog: (n, rec, env): [Program, Env] => {
        const genv = globalEnv(n.defs);
        let changed = false;
        // 挂了 Program 规则就得自己往下走（不再是"没挂所以框架走"那条路）
        const defs = n.defs.map((d) => {
          const [d2] = rec(d, genv);
          if (d2 !== d) changed = true;
          return d2;
        });
        const body = n.body.map((e) => {
          const [e2] = rec(e, genv);
          if (e2 !== e) changed = true;
          return e2;
        });
        return [changed ? ({ ...n, defs, body } as Program) : n, env];
      },
    },

    Expr: {
      Var: (n, _rec, env): Res => {
        const lat = env.get(n.name);
        if (lat !== undefined && lat.k === "const") return [litNode(lat) as Expr, env];
        return [n, env];
      },

      // let 是**平行**的：绑定值在**外层**环境里求（let* 已经被展开成嵌套 let 了）
      Let: (n, rec, env): Res => {
        const saved: [string, Lat | undefined][] = [];
        const bindings = n.bindings.map((b) => {
          const [b2] = rec(b, env);
          saved.push([b.name, env.get(b.name)]);
          env.set(b.name, BOT); // 体里这个名字是局部的
          return b2;
        });
        let changed = bindings.some((b, i) => b !== n.bindings[i]);
        const [body] = rec(n.body, env);
        if (body !== n.body) changed = true;
        restore(env, saved);
        return [changed ? ({ type: "Let", bindings, body } as Expr) : n, env];
      },

      // letrec 的绑定互相可见，一律按"不知道"处理（跟 const-prop 一致）
      Letrec: (n, rec, env): Res => {
        const saved = shadow(
          env,
          n.bindings.map((b) => b.name),
        );
        let changed = false;
        const bindings = n.bindings.map((b) => {
          const [b2] = rec(b, env);
          if (b2 !== b) changed = true;
          return b2;
        });
        const [body] = rec(n.body, env);
        if (body !== n.body) changed = true;
        restore(env, saved);
        return [changed ? ({ type: "Letrec", bindings, body } as Expr) : n, env];
      },

      // lambda 的参数遮蔽外层同名
      Lam: (n, rec, env): Res => {
        const saved = shadow(
          env,
          n.params.map((p) => p.name),
        );
        const [body] = rec(n.body, env);
        restore(env, saved);
        return [body === n.body ? n : ({ type: "Lam", params: n.params, body } as Expr), env];
      },
    },
  },
});

/**
 * 这条 pass 现在**就是一个普通的 `pass()`**，由 `fixpoint` 驱动跑不动点。
 *
 * 手搭 Step 那一整套都不用了：全局环境由 `Program` 规则算出来往下穿，循环交给
 * `fixpoint`，从 spec 重建得回来（所以 `opaque` / `rebuild` 不需要了），产物也能自己
 * 重建这一步（所以 `loop.setup` 也不需要了）。
 *
 *   opaque    ← 原来"全局环境在 run 里算、不动点循环也在 run 里，重建会丢"
 *   rebuild   ← 原来蹦床路径要手动把环境再算一遍（现在规则在 spec 里，蹦床版自己就会）
 *   loop.setup← 原来链接产物绕过 run 会漏掉环境准备（现在没有"run 里的准备"这回事了）
 *
 * 这三笔债都是**同一个坑欠下的**（t24：`Program` 上挂规则 + 有 `sig` → TS2589）。
 */
export const globalConst = fixpoint("global-const", step("global-const-raw", raw));
