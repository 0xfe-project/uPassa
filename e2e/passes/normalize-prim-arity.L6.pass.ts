/**
 * 算术原语的参数个数规范化（L6 → L6，语言不变）
 *
 *   (+ a b c)  →  (+ (+ a b) c)
 *   (- a b c)  →  (- (- a b) c)
 *   (* 2 x)    →  原样（已经是二元的）
 *
 * 一元/零元的：
 *   (+) → 0，(+) → 1  这种恒等元，交给 constantFold 和代数规则去处理，这里不动。
 *   (- a) 是一元取负，保留 —— 它不是"少了一个参数"，是另一种运算。
 *
 * **< 和 = 故意不动。** 它们是**链式比较**（(< 1 2 3) 意思是 1<2 且 2<3），
 * 表达不成嵌套的二元 < —— 那会变成 ((1<2)<3)，意思完全不同。要压成二元就得引入
 * 中间变量或 and，而 and 这时已经没了。所以这两条留成 n 元，是有意的，不是漏了。
 */

import type { NodeOf } from "../../src/nanopass/lang.ts";
import { pass } from "../../src/nanopass/pass.ts";
import { L6 } from "../langs/L6.lang.ts";

type OutExpr = NodeOf<typeof L6, "Expr">;

/** 结合性的、left-fold 得动的那些。 */
const LEFT_FOLD = new Set(["+", "-", "*", "/"]);

export const normalizePrimArity = pass({
  from: L6,
  to: L6,
  rules: {
    Expr: {
      Prim: (n, rec): OutExpr => {
        const args = rec(n.args);

        // 一元取负不是"参数少了一个"，别fold 它
        if (!LEFT_FOLD.has(n.op) || args.length <= 2) {
          return { type: "Prim", op: n.op, args };
        }

        // (+ a b c d) → (+ (+ (+ a b) c) d)
        let acc = args[0]!;
        for (let i = 1; i < args.length; i++) {
          acc = { type: "Prim", op: n.op, args: [acc, args[i]!] };
        }
        return acc;
      },
    },
  },
});
