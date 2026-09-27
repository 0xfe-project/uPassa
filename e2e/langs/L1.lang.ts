/**
 * L1：`(define (f x) e)` 这种函数定义形式没有了。
 *
 * 不重抄一遍 —— 从 Lsrc 派生，只删掉 DefFun。
 */

import { derive } from "../../src/lang.ts";
import { Lsrc } from "./Lsrc.lang.ts";

export const L1 = derive({ id: "L1", base: Lsrc, remove: ["DefFun"] });
