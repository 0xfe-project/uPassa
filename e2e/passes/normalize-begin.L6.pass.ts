/**
 * begin 规范化（L6 → L6，语言不变）
 *
 *   (begin)      → (void)
 *   (begin e)    → e
 *   (begin e ...)→ 原样（两个以上才真的是"顺序执行"）
 *
 * 头一条要是 from === to 的 pass —— 优化层里这是主模式，不是例外。
 * 语言没变，所以这里不需要新的 .lang.ts。
 */

import type { NodeOf } from "../../src/nanopass/lang.ts";
import { pass } from "../../src/nanopass/pass.ts";
import { L6 } from "../langs/L6.lang.ts";

type OutExpr = NodeOf<typeof L6, "Expr">;

export const normalizeBegin = pass({
  from: L6,
  to: L6,
  rules: {
    Expr: {
      Begin: (n, rec): OutExpr => {
        const exprs = n.exprs;
        const first = exprs[0];
        if (first === undefined) return { type: "Void" };
        if (exprs.length === 1) return rec(first);
        return { type: "Begin", exprs: rec(exprs) };
      },
    },
  },
});
