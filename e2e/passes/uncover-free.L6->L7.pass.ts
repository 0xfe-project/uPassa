/**
 * uncoverFree：算出每个 lambda 的自由变量，物化到 BindFree 上。
 *
 * 对应 nanopass 的
 *   (define-pass uncover-free : L7 (ir) -> L8 ()
 *     (LambdaExpr : LambdaExpr (ir free*) -> LambdaExpr (free*)
 *       [(lambda (,x* ...) ,[body free*])
 *        (let ([free* (difference free* x*)]) ...)]))
 *
 * ── 为什么不是"每个节点算一份自由集再合并"
 *
 * 第一版自底向上：每个节点算一份自由集（WeakMap 记忆化），父节点把子节点的集合并起来、
 * 减掉自己绑的名字。**每个 Let 都要复制一份体的自由集**，而那份集合的大小 ~ 变量数 V，
 * 所以嵌套 let + 很多变量时是 O(n·V)。实测放大到 ×10（那条形状里一个 Lam 都没有，
 * **输出几乎是空的**，中间却复制了 O(n) 份 O(n) 的集合）。
 *
 * ── 现在：每个「正在遍历的 lambda」一个帧，代价正比于输出
 *
 *   状态：active[name] = 这个名字**最内层绑定**所在的 lambda 深度（0 = 不在任何 lambda 里）
 *         frames        = 每个正在遍历的 lambda 一个自由集（栈）
 *         当前 lambda 深度 = frames.length
 *
 *   遇到引用 x：
 *     d = active[x]
 *     d 不存在（未绑定）或 d < 当前深度  →  x 对**当前这个** lambda 自由，记进栈顶帧
 *     d === 当前深度                      →  x 由这个 lambda 里面的东西绑着，不自由
 *
 *   进 lambda：压一个新帧，参数按新深度装进 active
 *   出 lambda：弹帧 = 这个 lambda 的自由集，再把它**并进外层帧**（外层绑着的不加）
 *
 * 为什么够：一个引用只需要记到**最内层**那个 lambda，外层靠帧弹出时的合并拿。合并的代价
 * 正比于被并入的集合大小，而那个集合就是外层 lambda 自由集的一部分 —— 也就是**输出本身**。
 * 所以总代价 O(引用数 + Σ|自由集|)，线性。
 *
 * 附带的好处：不需要记忆化，也不需要"往下传 bound 再往上带 seen"那两个槽。
 */

import type { NodeOf } from "../../src/nanopass/lang.ts";
import { pass, sig } from "../../src/nanopass/pass.ts";
import { L6 } from "../langs/L6.lang.ts";
import { L7 } from "../langs/L7.lang.ts";

type OutExpr = NodeOf<typeof L7, "Expr">;
type OutBody = NodeOf<typeof L7, "Body">;

interface St {
  /** 名字 → 它最内层绑定所在的 lambda 深度（0 = 不在任何 lambda 里）。 */
  readonly active: Map<string, number>;
  /** 每个正在遍历的 lambda 一个自由集。栈顶是最内层。 */
  readonly frames: Set<string>[];
}

function makeState(): St {
  return { active: new Map(), frames: [] };
}

type Ctx = [st: St];

/** 装一批名字（深度 = 当前 lambda 深度），返回用来还原的旧值。 */
function install(st: St, names: readonly string[]): (readonly [string, number | undefined])[] {
  const depth = st.frames.length;
  const saved: (readonly [string, number | undefined])[] = [];
  for (const name of names) {
    saved.push([name, st.active.get(name)]);
    st.active.set(name, depth);
  }
  return saved;
}

function restore(st: St, saved: readonly (readonly [string, number | undefined])[]): void {
  for (const [name, prev] of saved) {
    if (prev === undefined) st.active.delete(name);
    else st.active.set(name, prev);
  }
}

export const uncoverFree = pass({
  from: L6,
  to: L7,
  sig: sig(makeState()),
  init: (): Ctx => [makeState()],

  rules: {
    Expr: {
      Var: (n, _rec, st): [OutExpr, St] => {
        const frames = st.frames;
        if (frames.length > 0) {
          const d = st.active.get(n.name);
          // 未绑定、或者绑在这个 lambda **外面** → 对这个 lambda 自由
          if (d === undefined || d < frames.length) {
            frames[frames.length - 1]!.add(n.name);
          }
        }
        return [{ type: "Var", name: n.name }, st];
      },

      Lam: (n, rec, st): [OutExpr, St] => {
        st.frames.push(new Set());
        // 参数按**新**深度装进去 —— 它们绑在这个 lambda 里面，引用它们不算自由
        const saved = install(
          st,
          n.params.map((p) => p.name),
        );

        const params = n.params.map((p) => rec(p, st)[0]);
        const [body] = rec(n.body, st);

        restore(st, saved);
        const own = st.frames.pop()!;

        // 把这个 lambda 的自由集并进外层帧 —— 外层绑着的不加
        const outer = st.frames[st.frames.length - 1];
        if (outer !== undefined) {
          for (const name of own) {
            const d = st.active.get(name);
            if (d === undefined || d < st.frames.length) outer.add(name);
          }
        }

        const wrapped: OutBody = { type: "BindFree", names: [...own], body };
        return [{ type: "Lam", params, body: wrapped }, st];
      },

      Let: (n, rec, st): [OutExpr, St] => {
        // let 的绑定值在**外层**作用域求值 —— 还没装名字
        const bindings: { type: "Bind"; name: string; value: OutExpr }[] = [];
        for (const b of n.bindings) {
          const [value] = rec(b.value, st);
          bindings.push({ type: "Bind", name: b.name, value });
        }

        const saved = install(
          st,
          n.bindings.map((b) => b.name),
        );
        const [body] = rec(n.body, st);
        restore(st, saved);

        return [{ type: "Let", bindings, body }, st];
      },

      Letrec: (n, rec, st): [OutExpr, St] => {
        // letrec：绑定值和体都能看见这些名字
        const saved = install(
          st,
          n.bindings.map((b) => b.name),
        );
        const bindings = n.bindings.map((b) => {
          const [value] = rec(b.value, st);
          return { type: "Bind" as const, name: b.name, value };
        });
        const [body] = rec(n.body, st);
        restore(st, saved);

        return [{ type: "Letrec", bindings, body }, st];
      },
    },
  },
});
