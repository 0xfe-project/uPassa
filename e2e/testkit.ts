/**
 * pass 单测的**共享工具**（t35 / t36）。
 *
 * 抽出来的原因：`tests-sugar.ts` 和 `tests-passes.ts` 都要"源码 → 跑到某门 pass 之后"、
 * 都要数 tag / 数变量引用、都要拿手写期望值比最终值。这些是**测法**，不是某个 pass 的
 * 知识，复制一份的话两边会慢慢长歪（一边修了 bug 另一边没修）。
 *
 * 输入一律是**真实源码**（s-表达式 → 读 → 跑前缀），不是手搭的节点。手搭节点测不出
 * "语言定义改了"这种错 —— 而那正是单测最该红的地方。
 */

import { parse } from "./s-expr.ts";
import { readProgram } from "./read.ts";
import { runPipelineRange, runPipelinePrefix, linkedSteps } from "./linked.ts";
import { prettyInline } from "./pretty.ts";
import { runProgram } from "./eval.ts";

export type Check = (name: string, ok: boolean, detail?: string) => void;

// ───────────────────────── 工具 ─────────────────────────

export type Node = Record<string, unknown>;

/** 语言名 → 管线里的下标。查不到就抛（拼错了要立刻知道，不是静默跳过）。 */
export function idxOf(name: string): number {
  const i = linkedSteps.findIndex((s) => s.name === name);
  if (i < 0)
    throw new Error(`管线里没有名为 "${name}" 的 pass（有：${linkedSteps.map((s) => s.name).join(", ")}）`);
  return i;
}

/** 源码 → 读到 Lsrc → 跑前 `k` 步。 */
export function to(src: string, k: number): unknown {
  return runPipelinePrefix(readProgram(parse(src, "t35.tli").forms, "t35.tli"), k);
}

/** 源码 → 跑到 `name` 那门 pass **之后**。 */
export function after(src: string, name: string): unknown {
  return runPipelineRange(readProgram(parse(src, "t35.tli").forms, "t35.tli"), 0, idxOf(name) + 1);
}

/** 源码 → 跑到 `name` 那门 pass **之前**（也就是它的输入）。 */
function before(src: string, name: string): unknown {
  return to(src, idxOf(name));
}

/** 一行渲染，用来当断言失败时的 detail。 */
export const one = (x: unknown, max = 220): string => prettyInline(x, max).replace(/\s+/g, " ");

/** 树上所有 tag。 */
export function tagsIn(x: unknown, out: Set<string> = new Set()): Set<string> {
  if (x === null || typeof x !== "object") return out;
  if (Array.isArray(x)) {
    for (const y of x) tagsIn(y, out);
    return out;
  }
  const n = x as Node;
  if (typeof n["type"] === "string") out.add(n["type"]);
  for (const [k, v] of Object.entries(n)) {
    if (k.startsWith("__")) continue;
    tagsIn(v, out);
  }
  return out;
}

/** 树上某个 tag 出现几次。 */
export function countTag(x: unknown, tag: string): number {
  if (x === null || typeof x !== "object") return 0;
  if (Array.isArray(x)) return x.reduce<number>((a, y) => a + countTag(y, tag), 0);
  const n = x as Node;
  let c = n["type"] === tag ? 1 : 0;
  for (const [k, v] of Object.entries(n)) {
    if (k.startsWith("__")) continue;
    c += countTag(v, tag);
  }
  return c;
}

/** 顶层 body 的第 i 个表达式。 */
export function bodyAt(prog: unknown, i = 0): unknown {
  return ((prog as Node)["body"] as unknown[])[i];
}

/**
 * 整条管线跑完的值。
 *
 * 为什么不是"跳过这门 pass 再比一遍"：跨语言的 desugaring **没法跳过** —— 这门 pass 的
 * 输出语言就是下一门的输入语言，跳过它链路直接断（`L3` 的 `Or` 喂给要 `L4` 的 pass）。
 * 同语言的规范形 pass（`normalize-begin` 这种）能跳，但只有一半能用，不值得分两套。
 *
 * 所以值断言就写成**手写的期望值** —— 期望值来自语言语义，不来自管线。它抓的是"形状对
 * 但意思变了"（`or` 短路错、`cond` 分支反了、`let*` 绑定顺序错），而这些形状上看不出来。
 *
 * 注意：这条是**管线级**的（不是这门 pass 独有的）。这门 pass 独有的那部分在形状断言里
 * —— 尤其是"某个东西必须**不存在**"和"某个操作数只能出现**一次**"那两条。
 */
export function valueOf(src: string): unknown {
  return runProgram(
    runPipelineRange(readProgram(parse(src, "t35.tli").forms, "t35.tli"), 0, linkedSteps.length) as never,
  );
}

/** 值断言的包装：期望值手写，失败时把实际值印出来。 */
export function valueIs(check: Check, name: string, src: string, want: unknown): void {
  let got: unknown;
  let err = "";
  try {
    got = valueOf(src);
  } catch (e) {
    err = String((e as Error).message).slice(0, 80);
  }
  check(
    name,
    err === "" && JSON.stringify(got) === JSON.stringify(want),
    err !== "" ? err : `${src} → ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`,
  );
}

/** 某个名字在树里被引用几次（`Var` 节点的出现次数）。 */
export function countVar(x: unknown, name: string): number {
  if (x === null || typeof x !== "object") return 0;
  if (Array.isArray(x)) return x.reduce<number>((a, y) => a + countVar(y, name), 0);
  const n = x as Node;
  let c = n["type"] === "Var" && n["name"] === name ? 1 : 0;
  for (const [k, v] of Object.entries(n)) {
    if (k.startsWith("__")) continue;
    c += countVar(v, name);
  }
  return c;
}
