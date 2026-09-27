/**
 * L7：Lam 的体变成一个 BindFree 节点，上面挂着自由变量。
 *
 * 对应 nanopass 的
 *   (define-language L9 ...
 *     (BindFree (bf-body) (bind-free (x1 x2 ...) body)))
 *
 * 这是 derive 的 **add** 路径第一次被真的用到 —— 前面六门语言全是删。
 */

import { derive } from "../../src/lang.ts";
import { L6 } from "./L6.lang.ts";

export const L7 = derive({
  id: "L7",
  base: L6,
  add: {
    Expr: {
      // Lam 的体从 Expr 换成 Body —— 中间隔一层，好把自由变量挂上去
      Lam: { params: { list: "Param" }, body: "Body" },
    },
    Body: {
      BindFree: { names: { list: "string" }, body: "Expr" },
    },
  },
});
