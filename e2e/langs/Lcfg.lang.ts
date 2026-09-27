/**
 * Lcfg：**基本块 + 终结子**（t16）。框架里第一门"不是树"的语言。
 *
 * 前面每一门语言都是树，遍历就是递归下树 —— handler 里 `rec(子节点)` 就够了。
 * 这一门不是：块之间是**跳转**，跳转的目标是**标号字符串**，不是子节点。
 *
 *   Unit {
 *     name: "fact", params: [n],
 *     entry: "b0",
 *     blocks: [
 *       Block { label: "b0", stmts: [t0 = (= n 0)], term: Branch(t0, "b1", "b2") }
 *       Block { label: "b1", stmts: [],                    term: Ret(1) }
 *       Block { label: "b2", stmts: [t1 = (- n 1)],        term: Jump("b3") }
 *       ...
 *     ]
 *   }
 *
 * ## 为什么"跳转是引用"这件事是新的
 *
 * 因为 codegen 的 `walk_X` 是**顺着字段往下递归**的。它会把 `target: "b1"` 当成
 * 一个字符串字段复制过去 —— 也就是说，**换语言/改块的 pass 必须自己保证标号还对得上**。
 * 框架在这里帮不上忙，所以：
 *
 *   - 标号的**存在性**（跳转指向的块在不在）由 `e2e/cfg.ts` 的校验负责，不是类型系统
 *   - 数据流要的是**前驱/后继表**，那得从块列表现算 —— 见 `cfg.ts`
 *
 * ## 为什么不是给 Expr 加个 Goto 产生式
 *
 * 那样"控制流"还是藏在表达式里，数据流分析就得自己在树上找分支 —— 那正是 CFG 要免掉的事。
 * 块 + 终结子的形态是：**每个块只有一条出路**（除了 Ret），所以前驱/后继是有限的、可枚举的。
 *
 * ## Atom：不会分支的那些表达式
 *
 * 块里的语句是 `x = <Atom>`：Atom 是**不含分支**的表达式（变量、字面量、原语、调用、
 * lambda 值）。`if` 已经变成块之间的 Branch 了，所以块内不需要再判断控制流。
 * 于是"每个块只有一条出路"是真的。
 *
 * 嵌套 lambda 的体不在这个 Atom 里 —— 它有自己的 Unit，Atom 只留一个 `unit` 名字引用它。
 * 这跟"跳转是引用"是同一个手法，也一样需要校验（别指向不存在的 unit）。
 */

import { language, list } from "../../src/lang.ts";

export const Lcfg = language({
  id: "Lcfg",
  entry: "Prog",
  rules: {
    Prog: {
      Prog: { units: list("Unit") },
    },

    /** 一个函数（顶层定义或者嵌套 lambda）一个 Unit。 */
    Unit: {
      Unit: {
        name: "string",
        params: list("Param"),
        /** 入口块的标号。 */
        entry: "string",
        blocks: list("Block"),
      },
    },

    Block: {
      Block: { label: "string", stmts: list("Stmt"), term: "Term" },
    },

    /** 块里的语句：只赋值，不分支。 */
    Stmt: {
      Assign: { name: "string", value: "Atom" },
    },

    /** 终结子：一个块唯一的出路。 */
    Term: {
      Jump: { target: "string" },
      Branch: { cond: "Atom", then: "string", alt: "string" },
      Ret: { value: "Atom" },
    },

    /** 不会分支的表达式。 */
    Atom: {
      AVar: { name: "string" },
      AInt: { value: "number" },
      AFloat: { value: "number" },
      ABool: { value: "boolean" },
      AStr: { value: "string" },
      AVoid: {},
      /** 原语。参数全是 Atom —— 不分支，所以求值顺序就是参数顺序。 */
      APrim: { op: "string", args: list("Atom") },
      ACall: { fn: "Atom", args: list("Atom") },
      /**
       * lambda 值：它的体是**另一个 Unit**，这里只存名字（和跳转一样是引用）。
       *
       * `free` 是它捕获的外层变量 —— 从 L7 的 `BindFree.names` 带下来的
       * （`uncover-free` 那一步算的）。**活跃性分析要用它**：一个 lambda 值在创建的位置
       * 就"用到"了它捕获的那些名字（真做闭包转换时它们要被打包进去）。
       */
      ALam: { params: list("Param"), unit: "string", free: list("string") },
    },

    Param: { Param: { name: "string" } },
  },
});
