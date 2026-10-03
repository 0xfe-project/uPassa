// 由 e2e/gen.ts 生成。管线 "main" 的接口 —— 实现是 ./main.pipeline.js。
export declare const steps: readonly { readonly name: string; readonly from: string; readonly to: string }[];
/** 兜底触发过哪些 pass（名字）。 */
export declare const fallbacks: string[];
/** 整条管线：逐 pass + 逐 pass 兜底。 */
export declare function run(ast: unknown): unknown;
/** 逐步跑，把每一步的产物留下（第 0 步是输入）。 */
export declare function runStages(ast: unknown): { name: string; lang: string; ast: unknown }[];
/** 跑前 k 步。 */
export declare function runPrefix(ast: unknown, k: number): unknown;
/** 跑 steps 里的 [from, to) 这一段。 */
export declare function runRange(ast: unknown, from: number, to: number): unknown;
