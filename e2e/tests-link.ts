/**
 * link 期校验的**反例**测试（t19）。
 *
 * 光有"当前仓库是干净的"不够 —— 那样检查坏了也不会有人发现。这里造假目录，逐条验：
 *
 *   ① 有 pass 文件但管线没引用  → unused-pass
 *   ② 两个语言文件声明同一个 id  → name-mismatch / duplicate-lang-id
 *   ③ pass 文件名与声明的 from/to 不符 → name-mismatch
 *   ④ 语言文件名与声明的 id 不符 → name-mismatch
 *   ⑤ 干净的一对 → 0 个问题（不然上面四条可能是"反正都报"）
 *
 * 全在临时目录里造，不碰真仓库。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkLinks, type LinkProblem } from "./link-check.ts";
import type { Step } from "./runner.ts";

export interface LinkCase {
  readonly label: string;
  readonly files: Record<string, string>;
  readonly steps: readonly string[];
  /** 期望至少报出这些 kind。 */
  readonly want: readonly LinkProblem["kind"][];
  /** 期望的**最少**问题数（0 表示必须干净）。 */
  readonly wantCount: number;
}

const LANG_A = `export const A = language({ id: "A", entry: "E", rules: {} });`;
const LANG_B = `export const B = language({ id: "B", entry: "E", rules: {} });`;
const PASS_A = `import { pass } from "../../src/nanopass/pass.ts";
import { A } from "../langs/A.lang.ts";
export const foo = pass({ from: A, to: A, rules: {} });`;

export const LINK_CASES: readonly LinkCase[] = [
  {
    label: "① 有 pass 文件但管线没引用",
    files: {
      "A.lang.ts": LANG_A,
      "foo.A.pass.ts": PASS_A,
      "orphan.A.pass.ts": PASS_A.replace(/\bfoo\b/g, "orphan"),
    },
    steps: ["foo"],
    want: ["unused-pass"],
    wantCount: 1,
  },
  {
    label: "② 两个语言文件声明同一个 id",
    files: {
      "A.lang.ts": LANG_A,
      "A2.lang.ts": `export const A2 = language({ id: "A", entry: "E", rules: {} });`,
      "foo.A.pass.ts": PASS_A,
    },
    steps: ["foo"],
    want: ["name-mismatch"],
    wantCount: 1,
  },
  {
    label: "③ pass 文件名与声明的 from/to 不符",
    files: {
      "A.lang.ts": LANG_A,
      "B.lang.ts": LANG_B,
      "foo.A->B.pass.ts": PASS_A,
    },
    steps: ["foo"],
    want: ["name-mismatch"],
    wantCount: 1,
  },
  {
    label: "④ 语言文件名与声明的 id 不符",
    files: {
      "A.lang.ts": `export const A = language({ id: "WRONG", entry: "E", rules: {} });`,
      "foo.A.pass.ts": PASS_A,
    },
    steps: ["foo"],
    want: ["name-mismatch"],
    wantCount: 1,
  },
  {
    label: "⑤ 干净的一对（应当 0 个问题）",
    files: { "A.lang.ts": LANG_A, "foo.A.pass.ts": PASS_A },
    steps: ["foo"],
    want: [],
    wantCount: 0,
  },
];

/** 在临时目录里造一份文件树，跑一遍检查。 */
export function runLinkCase(c: LinkCase): LinkProblem[] {
  const d = mkdtempSync(join(tmpdir(), "np-link-"));
  const passDir = join(d, "passes");
  const langDir = join(d, "langs");
  mkdirSync(passDir);
  mkdirSync(langDir);
  for (const [name, body] of Object.entries(c.files)) {
    writeFileSync(join(name.includes(".pass.") ? passDir : langDir, name), body);
  }
  const steps = c.steps.map((name) => ({ name }) as unknown as Step);
  return checkLinks({ steps, passDir, langDir });
}
