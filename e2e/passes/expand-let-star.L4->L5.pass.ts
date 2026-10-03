/**
 * let*  →  嵌套的 let
 *
 *   (let* () body)          → body
 *   (let* ((x e)) body)     → (let ((x e)) body)
 *   (let* ((x1 e1) rest) b) → (let ((x1 e1)) (let* (rest) b))
 *
 * 注意 rec 是在构造过程中被调的（每个绑定一次、体一次），不是在返回的字面量里。
 */

import type { NodeOf } from "../../src/nanopass/lang.ts";
import { pass } from "../../src/nanopass/pass.ts";
import { L4 } from "../langs/L4.lang.ts";
import { L5 } from "../langs/L5.lang.ts";

type OutExpr = NodeOf<typeof L5, "Expr">;

export const expandLetStar = pass({
  from: L4,
  to: L5,
  rules: {
    Expr: {
      LetStar: (n, rec): OutExpr => {
        const binds = n.bindings;
        const build = (from: number): OutExpr => {
          const b = binds[from];
          if (b === undefined) return rec(n.body);
          return {
            type: "Let",
            bindings: [{ type: "Bind", name: b.name, value: rec(b.value) }],
            body: build(from + 1),
          };
        };
        return build(0);
      },
    },
  },
});
