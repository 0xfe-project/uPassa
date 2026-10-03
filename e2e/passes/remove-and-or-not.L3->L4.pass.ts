/**
 * and / or / not  →  if
 *
 *   (and)        → #t
 *   (and a b...) → (if a (and b...) #f)
 *   (or)         → #f
 *   (or a)       → a
 *   (or a b...)  → (let (($orN a)) (if $orN $orN (or b...)))
 *   (not a)      → (if a #f #t)
 *
 * or 为什么要造一个临时名字：`(if a a (or b...))` 会把 a 求值两次，有副作用就错了。
 * 所以老老实实 let 一个临时变量。
 *
 * 临时名字用 `$` 开头 —— reader 的符号词法允许它，但那是**保留前缀**：
 * 真要让用户能写 `$or1` 这个变量，就得改成真 gensym（拿不到源位置那种）。
 *
 * 计数器走 extra formal，不是模块级变量 —— 模块级的计数器会让整条链**不确定**
 * （跑两次名字不一样），而且不可重入。放 ctx 里就每次 run 都从 0 开始，顺带把
 * G1 的线程模型用在一门 from-to 的 pass 上。
 */

import type { NodeOf } from "../../src/nanopass/lang.ts";
import { pass, sig } from "../../src/nanopass/pass.ts";
import { L3 } from "../langs/L3.lang.ts";
import { L4 } from "../langs/L4.lang.ts";

type InExpr = NodeOf<typeof L3, "Expr">;
type OutExpr = NodeOf<typeof L4, "Expr">;

function freshName(hint: string, n: number): string {
  return `$${hint}${n}`;
}

type Res = [OutExpr, number];

export const removeAndOrNot = pass({
  from: L3,
  to: L4,
  // extra formal：临时名字的计数器（线程的，所以每次 run 从 0 开始）
  sig: sig(0),
  init: (): [number] => [0],
  rules: {
    Expr: {
      And: (n, rec, c): Res => {
        if (n.exprs.length === 0) return [{ type: "Bool", value: true }, c];
        let cur = c;
        let acc: OutExpr;
        {
          const last = n.exprs[n.exprs.length - 1]!;
          const [node, c1] = rec(last, cur);
          acc = node;
          cur = c1;
        }
        for (let i = n.exprs.length - 2; i >= 0; i--) {
          const [node, c1] = rec(n.exprs[i]!, cur);
          cur = c1;
          acc = { type: "If", cond: node, then: acc, alt: { type: "Bool", value: false } };
        }
        return [acc, cur];
      },

      Or: (n, rec, c): Res => {
        let cur = c;
        const exprs = n.exprs;
        // 用**下标**而不是 exprs.slice(1)：slice 会对一个 k 元的 or 造出 k-1 个递减的
        // 数组，总共 O(k²) 的内存流量（还有 k 层栈）。下标版是 O(k)。
        //
        // 求值顺序不变：先 rec(第 from 个)，再递归 build(from + 1)。
        const build = (from: number): OutExpr => {
          if (from >= exprs.length) return { type: "Bool", value: false };
          const [first, c1] = rec(exprs[from]!, cur);
          cur = c1;
          if (from === exprs.length - 1) return first;
          cur += 1;
          const name = freshName("or", cur);
          return {
            type: "Let",
            bindings: [{ type: "Bind", name, value: first }],
            body: {
              type: "If",
              cond: { type: "Var", name },
              then: { type: "Var", name },
              alt: build(from + 1),
            },
          };
        };
        return [build(0), cur];
      },

      Not: (n, rec, c): Res => {
        const [cond, c1] = rec(n.expr, c);
        return [
          { type: "If", cond, then: { type: "Bool", value: false }, alt: { type: "Bool", value: true } },
          c1,
        ];
      },
    },
  },
});
