/**
 * 链接器：把一条管线编成**一个自包含的 ES 模块**（t33）。
 *
 *     e2e/__out__/<名字>.pipeline.js
 *
 * ## 为什么要走编译，而不是运行期 `new Function`
 *
 * 原来每个 pass / 每个融合组都是"生成源码字符串 → `new Function` → 拿到 build 函数"。
 * 两个实实在在的代价：
 *
 * ① **报错指不到行。** `new Function` 出来的代码在调用栈里是 `<anonymous>:27:15` ——
 *    这轮调深度溢出的时候就是被这个坑住的，看不出是哪一行。生成物是真文件的话，
 *    栈里直接是 `main.pipeline.js:123`。
 * ② **产物不是一个东西。** 现在 `__out__/gen/` 里落了一堆单 pass / 单组的转储，
 *    而真正在跑的是运行期重新编出来的那些 —— 两套，分不清哪份算数。
 *
 * 走编译之后：**产物就是唯一在跑的那份代码**（单一真相），能读、能 diff、进得了 code review。
 *
 * ## handler 从哪来
 *
 * 产物**不复制** pass 的逻辑，它 `import { MAIN } from "../pipeline.ts"`，从
 * `MAIN.steps[i].spec` 上取 `rules` / `init`。于是"产物对不对"和"pass 写的是什么"永远对得上
 * —— 改了 pass，产物里的**遍历结构**要重新生成（t34 的过期检查盯着这个），而**逻辑**天生就是同一份。
 *
 * ## 产物里有什么
 *
 *   - 每个**单 pass** 的遍历器（`PW[i]`）—— 给"逐步看每一门语言的产物"用（tlispi 的逐层显示、
 *     e2e 的逐 pass 断言）
 *   - 每个**融合组**的遍历器：递归版（快）+ 蹦床版（深）
 *   - `run(ast)`：融合 + **逐组兜底**（某组溢出就只换那一组）
 *   - `runStages(ast)`：不融合，逐步跑，把每一步的产物留下
 *   - `steps`：管线自述（名字、每步语言）
 *
 * 这些**不是字符串**，是文件里真的函数 —— 栈里能看到、编辑器能跳过去。
 */

import { emitFusedGroupRec, emitFusedGroupTramp, emitWalker } from "../src/codegen.ts";
import { fuseGroups } from "./runner.ts";
import type { Pipeline } from "./pipeline.ts";
import type { Step } from "./runner.ts";

/**
 * 这一步的逻辑是不是**不在 spec 里**。
 *
 * 手搭的 Step（`rewrite` / `fixpoint` / 整程序分析）标了 `opaque`：它们的 `run` 里还有
 * 不动点循环、环境、可达性分析这些东西，`spec` 只描述"怎么下树"。产物**没法**从 spec
 * 重建它们，只能调它们的 `run` —— 那些 `run` 是模块里的普通函数（不带 `new Function`）。
 */
const isOpaque = (st: Step): boolean => st.opaque === true;

/**
 * 一步的"遍历器 + 循环"怎么写成一行。
 *
 * 循环的语义从 `loops.ts` 拿（**只有一份实现**，产物不复制它）；这里是它的**参数**。
 */
function loopExpr(inner: string, loop: NonNullable<Step["loop"]>, stepIdx: number, name: string): string {
  const wrap =
    loop.kind === "fixpoint"
      ? `fixpointLoop((y) => w.run(y), ${loop.maxRounds}, ${JSON.stringify(name)})`
      : `rewriteLoop((y) => w.run(y), ${JSON.stringify(name)})`;
  // **先调 setup**：手搭的 Step 在 run 里除了跑循环还有每-run 的准备（重置计数器、
  // 算步数预算、装环境）。产物绕过 run，所以这一钩子必须显式调上。
  return `(x) => { MAIN.steps[${stepIdx}].loop.setup?.(x); const w = ${inner}; return ${wrap}(x); }`;
}

/** 把一个生成器吐出的源码包成"模块里的一个函数值"。 */
function embed(name: string, source: string): string {
  return `const ${name} = (function () {\n${source}\nreturn build;\n})();`;
}

export interface LinkedSource {
  readonly fileName: string;
  readonly source: string;
  /** 产物的类型外壳（`.d.ts`）。 */
  readonly types: string;
}

/** 编一条管线。 */
export function linkPipeline(p: Pipeline<readonly Step[]>): LinkedSource {
  const steps = p.steps;
  const groups = fuseGroups(steps);
  /** 每组在 steps 里的下标（产物里要按它取 handler）。 */
  const groupIdx: number[][] = [];
  {
    let cur = 0;
    for (const g of groups) {
      groupIdx.push(g.map((_, i) => cur + i));
      cur += g.length;
    }
  }

  const parts: string[] = [];
  parts.push(`// 由 e2e/gen.ts 生成，不要手改 —— 改 pass / 语言 / 融合逻辑，然后重跑 pnpm gen。`);
  parts.push(`//`);
  parts.push(`// 管线 "${p.name}"：${p.entry} → ${p.exit}，${steps.length} 步 → ${groups.length} 组。`);
  parts.push(`//`);
  parts.push(`// 这份文件**就是**在跑的那份代码（不是拿字符串再 new Function 编一遍）。`);
  parts.push(`// handler 从 e2e/pipeline.ts 的 steps 上取 —— 这里不复制 pass 的逻辑。`);
  parts.push(``);
  parts.push(`import { MAIN } from "../pipeline.ts";`);
  parts.push(`import { fixpointLoop, rewriteLoop } from "../loops.ts";`);
  parts.push(``);
  parts.push(`export const steps = MAIN.describe().steps;`);
  parts.push(``);

  // 单 pass 的遍历器
  for (let i = 0; i < steps.length; i++) {
    parts.push(embed(`PW${i}`, emitWalker(steps[i]!.spec)));
    parts.push(``);
  }

  // 融合组：递归版 + 蹦床版
  //
  // 单个 pass 的组**不能**走融合 emitter（它要求 arity 0，而带 extra 的 pass 得自己控制
  // 下降）—— 那种组用单 pass 的遍历器（`PW[i]`）。蹦床版可以，单元素组它支持 arity > 0。
  for (let g = 0; g < groups.length; g++) {
    const specs = groups[g]!.map((s) => s.spec);
    if (groups[g]!.length > 1) parts.push(embed(`GR${g}`, emitFusedGroupRec(specs)));
    parts.push(embed(`GT${g}`, emitFusedGroupTramp(specs)));
    parts.push(``);
  }

  // 取 handler / init 的小工具
  parts.push(`/** 第 i 步的 handler 表 / extra 初值 —— 从管线声明上取，不在这里复制。 */`);
  parts.push(`const rulesOf = (i) => MAIN.steps[i].spec.rules;`);
  parts.push(`const initOf = (i) => MAIN.steps[i].spec.init ?? (() => []);`);
  parts.push(``);

  // 建出每一步 / 每一组的 run
  parts.push(`/**
 * 一步怎么跑。
 *
 *   - 普通 pass：遍历器（PW i）就全部
 *   - **loop 步**（不动点 / 重写规则）：遍历器 + 一层循环，循环的语义从 loops.ts 拿
 *     （只有一份实现，产物不复制它）
 *   - opaque 又没有 loop 的（整程序分析那种）：它的逻辑不在 spec 里，只能调它的 run
 */
const stepRun = [`);
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i]!;
    if (st.loop !== undefined) {
      parts.push(`  ${loopExpr(`PW${i}(rulesOf(${i}), initOf(${i}))`, st.loop, i, st.name)},`);
    } else if (isOpaque(st)) {
      parts.push(`  (x) => MAIN.steps[${i}].run(x),`);
    } else {
      parts.push(`  (x) => PW${i}(rulesOf(${i}), initOf(${i})).run(x),`);
    }
  }
  parts.push(`];`);
  parts.push(``);

  parts.push(`/** 融合：每组的递归版（快）和蹦床版（深）。 */`);
  parts.push(`const groupFast = [`);
  for (let g = 0; g < groups.length; g++) {
    const idx = groupIdx[g]!;
    const list = idx.map((i) => `rulesOf(${i})`).join(", ");
    const first = idx[0]!;
    const st = steps[first]!;
    if (idx.length > 1) {
      parts.push(`  (x) => GR${g}([${list}], initOf(${first})).run(x),`);
    } else if (st.loop !== undefined) {
      parts.push(
        `  ${loopExpr(`PW${first}(rulesOf(${first}), initOf(${first}))`, st.loop, first, st.name)},`,
      );
    } else if (isOpaque(st)) {
      // 手搭的 Step：逻辑在它自己的 run 里，产物只能调它（见文件头"手搭的 Step"）
      parts.push(`  (x) => MAIN.steps[${first}].run(x),`);
    } else {
      parts.push(`  (x) => PW${first}(rulesOf(${first}), initOf(${first})).run(x),`);
    }
  }
  parts.push(`];`);
  parts.push(`/**
 * 兜底变体（蹦床）。**没有兜底的组是 null** —— 见 runGroup。
 */
const groupSlow = [`);
  for (let g = 0; g < groups.length; g++) {
    const idx = groupIdx[g]!;
    const list = idx.map((i) => `rulesOf(${i})`).join(", ");
    const first = idx[0]!;
    const st = steps[first]!;
    if (idx.length === 1 && st.loop === undefined && isOpaque(st)) {
      // 手搭又没 loop 的那些：真相是"这一组没有更深的变体"（它的逻辑不在这套生成器里）。
      // **不能**拿 GT 顶替 —— 那会静默地少做事（踩过：global-dce 在蹦床路径下变成纯 identity）。
      parts.push(`  null, // ${st.name}：手搭的 Step，没有兜底变体`);
    } else if (st.loop !== undefined) {
      // 兜底变体是**遍历器**；循环还得套上，不然兜底会静默地把"跑到不动点"变成"只跑一轮"
      parts.push(`  ${loopExpr(`GT${g}([${list}], initOf(${first}))`, st.loop, first, st.name)},`);
    } else {
      parts.push(`  (x) => GT${g}([${list}], initOf(${first})).run(x),`);
    }
  }
  parts.push(`];`);
  parts.push(``);

  // 逐组兜底
  parts.push(`/**
 * 兜底触发过哪些组（可观察，给测试和诊断用）。
 */
export const fallbacks = [];
`);
  parts.push(`/**
 * 逐组兜底：默认走递归（快），某一组溢出就**只把那一组**换成蹦床版重跑。
 *
 * 认出"溢出"靠生成的 guard 打的 \`name = "StackOverflow"\`（不是匹配报错文本 ——
 * 文本是给人看的、本来就该能改）。只兜一次：蹦床也溢出就把它的报错原样抛出，
 * 那条限制（handler 嵌套太深）是真的。
 */
function runGroup(g, x) {
  const slow = groupSlow[g];
  if (slow === null) return groupFast[g](x); // 没有兜底变体（手搭的 Step）
  try {
    return groupFast[g](x);
  } catch (e) {
    const overflow = e instanceof RangeError || (e instanceof Error && e.name === "StackOverflow");
    if (!overflow) throw e;
    fallbacks.push(g);
    return slow(x);
  }
}
`);
  parts.push(`/** 整条管线：融合 + 逐组兜底。 */`);
  parts.push(`export function run(ast) {
  let cur = ast;
  for (let g = 0; g < groupFast.length; g++) cur = runGroup(g, cur);
  return cur;
}
`);
  parts.push(`/**
 * 跑 steps 里的 [from, to) 这一段。
 *
 * 为什么要区间而不只是前缀：e2e 里有一条检查是"**去糖那一段**重跑一遍不该变"——
 * 它跑的不是第 0..k 步，而是中间的一段（从 Lsrc 那一步开始）。只有前缀的话那条检查
 * 会把整条管线从头再跑一遍，喂进去的是已经处理过的树，直接炸。
 */
export function runRange(ast, from, to) {
  let cur = ast;
  for (let i = from; i < to; i++) cur = stepRun[i](cur);
  return cur;
}
`);
  parts.push(`/** 跑前 k 步（perf 按前缀量每个 pass 用）。 */
export function runPrefix(ast, k) {
  return runRange(ast, 0, k);
}
`);
  parts.push(`/** 不融合：逐步跑，把每一步的产物留下（第 0 步是输入）。 */`);
  parts.push(`export function runStages(ast) {
  const out = [{ name: "(输入)", lang: ${JSON.stringify(p.entry)}, ast }];
  let cur = ast;
  for (let i = 0; i < stepRun.length; i++) {
    cur = stepRun[i](cur);
    out.push({ name: MAIN.steps[i].name, lang: MAIN.steps[i].to, ast: cur });
  }
  return out;
}
`);

  return {
    fileName: `${p.name}.pipeline.js`,
    source: parts.join("\n"),
    // 类型外壳：产物是 `.js`（tsconfig 里 allowJs: false，不看它的实现），
    // 但 import 它的人要有类型 —— 这份 .d.ts 就是它的**接口**。
    // （顺带回答"__out__ 里的东西没类型"：接口有类型，实现是纯 JS，各归各位。）
    types: `// 由 e2e/gen.ts 生成。管线 "${p.name}" 的接口 —— 实现是 ./${p.name}.pipeline.js。
export declare const steps: readonly { readonly name: string; readonly from: string; readonly to: string }[];
/** 兜底触发过哪些组（下标）。 */
export declare const fallbacks: number[];
/** 整条管线：融合 + 逐组兜底。 */
export declare function run(ast: unknown): unknown;
/** 不融合：逐步跑，把每一步的产物留下（第 0 步是输入）。 */
export declare function runStages(ast: unknown): { name: string; lang: string; ast: unknown }[];
/** 跑前 k 步。 */
export declare function runPrefix(ast: unknown, k: number): unknown;
/** 跑 steps 里的 [from, to) 这一段。 */
export declare function runRange(ast: unknown, from: number, to: number): unknown;
`,
  };
}
