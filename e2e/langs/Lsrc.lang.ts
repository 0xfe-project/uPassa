/**
 * Lsrc：糖最多的一门语言。
 *
 * 入口是 Program（不是 Expr）—— 这样"入口非终结符"是真的被用到的，不是装饰。
 *
 * 刻意把糖分得彼此独立：cond 里可以有 and，let* 里可以有 cond，但每条糖只由
 * 一个 pass 负责消掉，删的顺序不会互相牵扯。
 */

import { language, list, maybe } from "../../src/lang.ts";

export const Lsrc = language({
  id: "Lsrc",
  entry: "Program",
  rules: {
    Program: {
      Prog: { defs: list("Def"), body: list("Expr") },
    },

    // (define (f x) e) 与 (define f e) 两种定义形式
    Def: {
      DefFun: { name: "string", params: list("Param"), body: "Expr" },
      DefVal: { name: "string", value: "Expr" },
    },

    Param: { Param: { name: "string" } },

    // cond 的一个分支
    Clause: { Clause: { test: "Expr", body: "Expr" } },

    // 绑定对。s-expr 里写 (x e)，但我们的节点是带 tag 的联合类型，必须有 tag 才能判别
    Bind: { Bind: { name: "string", value: "Expr" } },

    Expr: {
      Void: {}, // 去掉糖之后会造出来（(when c e) 的 else 支、(cond) 的最里层）
      Int: { value: "number" },
      Float: { value: "number" },
      Bool: { value: "boolean" },
      Str: { value: "string" },
      Var: { name: "string" },

      If: { cond: "Expr", then: "Expr", alt: "Expr" },
      IfAlt: { cond: "Expr", then: "Expr" }, // 只有一条臂
      When: { cond: "Expr", body: "Expr" },
      Unless: { cond: "Expr", body: "Expr" },

      Cond: { clauses: list("Clause"), else: maybe("Expr") },
      And: { exprs: list("Expr") },
      Or: { exprs: list("Expr") },
      Not: { expr: "Expr" },

      Begin: { exprs: list("Expr") },
      Let: { bindings: list("Bind"), body: "Expr" },
      LetStar: { bindings: list("Bind"), body: "Expr" },
      Letrec: { bindings: list("Bind"), body: "Expr" },

      Lam: { params: list("Param"), body: "Expr" },
      Call: { fn: "Expr", args: list("Expr") },
      Prim: { op: "string", args: list("Expr") },
    },
  },
});
