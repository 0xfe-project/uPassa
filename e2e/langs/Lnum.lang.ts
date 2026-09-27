/**
 * Lnum：**字面量还没有分种类**的那门语言（t15）。
 *
 * 和 Lsrc 只差一处：数字不是 `Int` / `Float` 两种，而是一种笼统的 `Num`。
 *
 *   Lnum:  Num { value: 1,   repr: "1"   }     ← 笼统：这是个数
 *          Num { value: 1.5, repr: "1.5" }     ← 笼统：这是个数
 *
 *   Lsrc:  Int { value: 1 }   Float { value: 1.5 }
 *
 * 谁去做这个细分？一个 pass（`refine-repr.Lnum->Lsrc.pass.ts`），不是读入器。
 *
 * ## 为什么要分成两门语言
 *
 * 因为"这是个整数"**不是读进来的事实，是编译器的一个决定**。宿主语言里 `1` 和 `1.0`
 * 都是同一个 number —— 读入器手里其实只有数字本身，它没法诚实地说"这是 Int"。
 * 它真正知道的是**字面量长什么样**（`repr`：源码里的原文）。
 *
 * 所以：读入器产出 `Num { value, repr }`（它知道的），`refine-repr` 拿 `repr` 去做判断
 * （它该做的），而且**判断要在一个类型环境里做** —— 一处是 Int 另一处是 Float，
 * 那是要报错的事，不是两处各自拍脑袋。
 *
 * 这就是"derive 的正好归宿"：Lnum 是 Lsrc 减两个产生式、加一个，一条 `derive` 就够。
 * 而且**语言变了**，不是给同一个 tag 打个标记 —— 于是"细分"这一步是类型系统看得见、
 * codegen 也看得见的一步，不可能被跳过。
 *
 * ## 为什么只笼统了数字（说清范围）
 *
 * `Str` 和 `Bool` 留在 Lnum 里没动。理由不是省事：**笼统只对"宿主表示有歧义"的东西有意义**。
 * `"abc"` 和 `#t` 在源码里写法唯一，读入器当场就知道是什么；只有数字会 `1` / `1.0`
 * 塌成同一个 number。所以这里笼统的范围**正好**是宿主表示丢失信息的那些。
 */

import { derive } from "../../src/lang.ts";
import { Lsrc } from "./Lsrc.lang.ts";

export const Lnum = derive({
  id: "Lnum",
  base: Lsrc,
  remove: ["Int", "Float"],
  add: {
    Expr: {
      /**
       * 一个还没分种类的数字。
       *
       * `value` 是数值（求值用），`repr` 是源码里的原文（细分用）—— 两个都要：
       * 少了 `repr` 就没法把 `1` 和 `1.0` 分开，少了 `value` 每一步都得重新解析。
       */
      Num: { value: "number", repr: "string" },
    },
  },
});
