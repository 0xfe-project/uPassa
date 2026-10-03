/**
 * (define (f x) e)  →  (define f (lambda (x) e))
 *
 * 只写这一条规则，其余产生式由框架递归重建。
 *
 * 对应 nanopass：
 *   (define-pass desugar-def-fun : Lsrc (ir) -> L1 ()
 *     (Def : Def (ir) -> Def ()
 *       [(define (,f ,x* ...) ,body) `(define ,f (lambda (,x* ...) ,body))]))
 */

import type { NodeOf } from "../../src/nanopass/lang.ts";
import { pass } from "../../src/nanopass/pass.ts";
import { Lsrc } from "../langs/Lsrc.lang.ts";
import { L1 } from "../langs/L1.lang.ts";

type OutDef = NodeOf<typeof L1, "Def">;

export const desugarDefFun = pass({
  from: Lsrc,
  to: L1,
  rules: {
    Def: {
      // `: OutDef` 不能省 —— 省了返回值的判别字面量会被拓宽成 string，检查就失效了
      DefFun: (n, rec): OutDef => ({
        type: "DefVal",
        name: n.name,
        value: {
          type: "Lam",
          params: rec(n.params),
          body: rec(n.body),
        },
      }),
    },
  },
});
