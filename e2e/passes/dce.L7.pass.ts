/**
 * 局部死代码消除：把没人用的 let 绑定删掉。
 *
 *   (let ((x (f 1)) (y (g 2))) y)          → (let ((y (g 2))) y)
 *   (let ((x (f 1))) (let ((x (g 2))) x))  → (let ((x (g 2))) x)   ← 内层遮蔽，外层没人用
 *   (let ((x (f 1))) (lambda (x) x))       → (lambda (x) x)        ← 参数遮蔽
 *   (let () body)                          → body
 *
 * ── 为什么不是"把 used 集合往上传"
 *
 * 第一版自底向上收一个 used 集合，每遇到一个 Let 就复制一遍。那是 O(节点数 × 活跃变量数)：
 * k 层嵌套 let 就是 O(k²)，放大 k 时实测比值到 8.66。
 *
 * 现在换成一个**可变的活跃绑定表**（名字 → 这个绑定的 mark），引用直接标到**最内层**的
 * 那个绑定上：
 *
 *   进作用域：给这些名字装上新 mark，同时记下旧的那个
 *   遇到引用：active.get(name).ref = true —— O(1)，而且自动找对最内层
 *   出作用域：还原旧值。这一层自己的绑定，看自己 mark 有没有被标过
 *
 * 每个引用 O(1)，每个绑定 O(1)，整体线性。遮蔽也自然对了。
 *
 * 副作用是"把 used 往上传"这个需求整个消失：引用直接标在**拥有它的那个绑定**上，
 * 不需要一层层传上去。
 *
 * 已知的限制（刻意不做）：
 * - **只删 let，不删 letrec**。letrec 的绑定互相可见，删一个之前得先确认它没被别的绑定
 *   用到 —— 那要不动点。留给全局 DCE（t14）。
 * - 删掉一个绑定，它的值里的引用也就不算了。因为整个值被丢掉，这是对的（Lcore 无副作用）。
 */

import type { NodeOf } from "../../src/nanopass/lang.ts";
import { pass, sig } from "../../src/nanopass/pass.ts";
import { L7 } from "../langs/L7.lang.ts";

type OutExpr = NodeOf<typeof L7, "Expr">;

/** 一个绑定"被引用过吗"。每个绑定一个独立的对象。 */
interface Mark {
  ref: boolean;
}

/** 名字 → 当前可见的那个绑定的 mark。可变，进出作用域时保存/还原。 */
type Active = Map<string, Mark>;

type Ctx = [active: Active];
type Res = readonly [OutExpr, Active];

interface Scope {
  /** 这次新装上的 mark（按名字），出作用域后用它查"被引用过吗"。 */
  readonly marks: Map<string, Mark>;
  /** 用来还原的旧值。 */
  readonly saved: (readonly [string, Mark | undefined])[];
}

function pushScope(active: Active, names: readonly string[]): Scope {
  const saved: (readonly [string, Mark | undefined])[] = [];
  const marks = new Map<string, Mark>();
  for (const name of names) {
    saved.push([name, active.get(name)]);
    const mark: Mark = { ref: false };
    marks.set(name, mark);
    active.set(name, mark);
  }
  return { marks, saved };
}

function popScope(active: Active, scope: Scope): void {
  for (const [name, prev] of scope.saved) {
    if (prev === undefined) active.delete(name);
    else active.set(name, prev);
  }
}

export const dce = pass({
  from: L7,
  to: L7,
  sig: sig(new Map<string, Mark>()),
  init: (): Ctx => [new Map()],

  rules: {
    Expr: {
      Var: (n, _rec, active): Res => {
        // 标到**当前可见**的那个绑定 —— active 表已经保证了它是最内层的
        const m = active.get(n.name);
        if (m !== undefined) m.ref = true;
        return [{ type: "Var", name: n.name }, active];
      },

      Lam: (n, rec, active): Res => {
        const params = n.params.map((p) => rec(p, active)[0]);
        // 参数在体里遮蔽外层。参数本身不是"可以被删掉的绑定"，所以它的 mark 不用看。
        const scope = pushScope(
          active,
          n.params.map((p) => p.name),
        );
        const [body] = rec(n.body, active);
        popScope(active, scope);
        return [{ type: "Lam", params, body }, active];
      },

      Let: (n, rec, active): Res => {
        const names = n.bindings.map((b) => b.name);

        // 先走体。这一层绑定的引用会被标在各自的 mark 上（遮蔽由 active 表处理）。
        const scope = pushScope(active, names);
        const [body] = rec(n.body, active);
        popScope(active, scope);

        // 体走完才知道谁活着。死的连值都不走（Lcore 无副作用）。
        const kept: { type: "Bind"; name: string; value: OutExpr }[] = [];
        for (const b of n.bindings) {
          if (scope.marks.get(b.name)?.ref !== true) continue;
          const [value] = rec(b.value, active);
          kept.push({ type: "Bind", name: b.name, value });
        }

        // (let () body) 没有意义 —— 直接还体
        if (kept.length === 0) return [body, active];
        return [{ type: "Let", bindings: kept, body }, active];
      },

      Letrec: (n, rec, active): Res => {
        // 不删东西（删一个得先确认它没被别的绑定用 —— 那要不动点）。遮蔽照样处理。
        const scope = pushScope(
          active,
          n.bindings.map((b) => b.name),
        );
        const bindings = n.bindings.map((b) => {
          const [value] = rec(b.value, active);
          return { type: "Bind" as const, name: b.name, value };
        });
        const [body] = rec(n.body, active);
        popScope(active, scope);
        return [{ type: "Letrec", bindings, body }, active];
      },
    },
  },
});
