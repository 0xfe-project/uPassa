/**
 * `pnpm gen`：把每条管线编成 `e2e/__out__/<名字>.pipeline.js`（t33）。
 *
 * 这是一步**构建**。改了 pass / 语言 / 融合逻辑之后必须重跑 —— 不然跑的是旧产物。
 * 靠"重新生成 + `git diff --exit-code`"盯住（t34 的过期检查），不靠自觉。
 *
 * 用真 node 跑（`node e2e/gen.ts`）：产物是 ES 模块，`.js` 里 import `.ts` 靠 node 的
 * strip-only 模式。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { linkPipeline } from "./link.ts";
import { PIPELINES } from "./pipeline.ts";

const OUT = new URL("./__out__/", import.meta.url);

// 旧的单 pass / 单组转储不再保留：链接产物是**唯一**的生成物。
// 留两套的话，人会分不清哪份才算数（这正是走编译要解决的第二个问题）。
rmSync(new URL("gen/", OUT), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const p of PIPELINES) {
  const { fileName, source, types } = linkPipeline(p);
  writeFileSync(new URL(fileName, OUT), source);
  writeFileSync(new URL(fileName.replace(/\.js$/, ".d.ts"), OUT), types);
  console.log(`  ${fileName}   ${p.entry} → ${p.exit}，${p.steps.length} 步`);
}
console.log(`\n${PIPELINES.length} 条管线 → e2e/__out__/`);
