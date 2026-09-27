/**
 * 运行期入口：**一切都从链接产物走**（t33）。
 *
 *     e2e/__out__/main.pipeline.js   ← pnpm gen 生成，提交进仓库
 *
 * 为什么要有这个薄薄的一层（而不是各处直接 import 产物）：
 *
 * ① 产物是 `.js`，这一层给它一个**带类型的名字**（`runPipeline` / `runLinked` / …），
 *    调用点读起来还是本来的那套词。
 * ② 产物是按**管线名**命名的（`<名字>.pipeline.js`），"哪条管线"这件事收在这一层里 ——
 *    将来有第二条 entry 时，加一个 `export const exprPipeline = …` 就行，调用点不用动。
 * ③ 不这么做就得让 `pipeline.ts`（管线声明）去 import 产物，而产物又要 import 声明取
 *    handler —— 那是个循环。分开之后是单向的：**声明 → 产物 → 这一层 → 调用点**。
 */

import * as MAIN from "./__out__/main.pipeline.js";

/** 管线自述（名字、每步语言）—— 从产物里出，不在别处重算。 */
export const linkedSteps = MAIN.steps;

/** 不融合：逐步跑，把每一步的产物留下（第 0 步是输入）。 */
export const runPipeline = (ast: unknown): { name: string; lang: string; ast: unknown }[] =>
  MAIN.runStages(ast);

/** 跑前 k 步（perf 按前缀量每个 pass 用）。 */
export const runPipelinePrefix = (ast: unknown, k: number): unknown => MAIN.runPrefix(ast, k);

/** 跑 steps 里的 [from, to) —— "去糖那一段重跑不变"那条检查要的就是它。 */
export const runPipelineRange = (ast: unknown, from: number, to: number): unknown =>
  MAIN.runRange(ast, from, to);

/** 整条管线：融合 + **逐组兜底**（生产形态）。 */
export const runLinked = (ast: unknown): unknown => MAIN.run(ast);
