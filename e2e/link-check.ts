/**
 * link 期校验（t19）。
 *
 * 类型层已经能抓「链条断裂 / entry 与第一个 pass 不符」——那些在 tsc 就报了。
 * 这一层的活是**只有扫盘才知道**的事：
 *
 *   ① 某个 pass 文件存在、能编译，但没有任何管线引用它
 *   ② 两个入口的 id 撞了（同一个语言被起了两个名字）
 *   ③ 一个 pass 文件声明的东西和它的**文件名**不符（文件名是索引，体是真相）
 *
 * 为什么这些必须是**报错**不是警告：它们都是"编译通过、跑起来也对，但你说的和你做的
 * 不是一回事"。没人引用的 pass 是最典型的 —— 你以为它生效了，其实它一次都没跑过。
 *
 * 三条都靠"名字"来判：pass 文件名形如 `<who>.<From>-><To>.pass.ts`（同语言连做写
 * `<who>.<Lang>.pass.ts`），语言文件名形如 `<Lang>.lang.ts`。名字只是命名约定、不参与
 * 运行（t18 之前的讨论里定过），但既然是索引，就该和真相对得上。
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Step } from "./runner.ts";

const PASS_DIR = fileURLToPath(new URL("./passes/", import.meta.url));
const LANG_DIR = fileURLToPath(new URL("./langs/", import.meta.url));

export interface LinkProblem {
  readonly kind: "unused-pass" | "duplicate-lang-id" | "name-mismatch" | "no-pass-for-lang";
  readonly what: string;
  readonly detail: string;
}

/** 从 pass 文件名里解出 (who, from, to)。解不出来返回 null。 */
export function parsePassName(file: string): { who: string; from: string; to: string } | null {
  const m =
    /^(?<who>[^.]+)\.(?:(?<from>[A-Za-z0-9_]+)->(?<to>[A-Za-z0-9_]+)|(?<same>[A-Za-z0-9_]+))\.pass\.ts$/.exec(
      file,
    );
  if (m === null) return null;
  const g = m.groups!;
  const from = g["from"] ?? g["same"]!;
  const to = g["to"] ?? g["same"]!;
  return { who: g["who"]!, from, to };
}

/** 从语言文件名里解出语言 id。 */
export function parseLangName(file: string): string | null {
  const m = /^(?<id>[A-Za-z0-9_]+)\.lang\.ts$/.exec(file);
  return m === null ? null : m.groups!["id"]!;
}

/** 从 `export const X = pass({...})` 这类声明里抠出 from / to 的**语言 id**。 */
function declaredEnds(src: string): { from: string | null; to: string | null } {
  // 只看 from: <Ident> / to: <Ident>，或者 derive({ id: "X" }) 那种由 import 别名带出来的
  const from = /\bfrom:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(src)?.[1] ?? null;
  const to = /\bto:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(src)?.[1] ?? null;
  return { from, to };
}

/** 语言文件里声明的 id（`language({ id: "L1" })` 或 `derive({ id: "L1" })`）。 */
function declaredLangId(src: string): string | null {
  return /\bid:\s*"([^"]+)"/.exec(src)?.[1] ?? null;
}

export interface LinkCheckOptions {
  /** 只对这条管线做"没人引用"的检查。 */
  readonly steps: readonly Step[];
  readonly passDir?: string;
  readonly langDir?: string;
}

/**
 * 跑一遍 link 检查。返回所有问题（空数组 = 干净）。
 */
export function checkLinks(opts: LinkCheckOptions): LinkProblem[] {
  const passDir = opts.passDir ?? PASS_DIR;
  const langDir = opts.langDir ?? LANG_DIR;
  const problems: LinkProblem[] = [];

  const passFiles = readdirSync(passDir).filter((f) => f.endsWith(".pass.ts"));
  const langFiles = readdirSync(langDir).filter((f) => f.endsWith(".lang.ts"));

  // ── ① 每个 pass 文件都被管线引用了吗
  //
  // 判据：把文件名里的 who 拿出来，看它在管线里出现过没有。
  // （不去比对 import 路径 —— 那样一改布局就假红。）
  const usedWho = new Set(opts.steps.map((s) => s.name));
  for (const f of passFiles) {
    const parsed = parsePassName(f);
    if (parsed === null) {
      problems.push({
        kind: "name-mismatch",
        what: f,
        detail: `文件名不符合 \`<who>.<From>-><To>.pass.ts\`（同语言连做写 \`<who>.<Lang>.pass.ts\`）`,
      });
      continue;
    }
    // 管线里的名字是 kebab-case，文件名也是 —— 直接比
    if (!usedWho.has(parsed.who)) {
      problems.push({
        kind: "unused-pass",
        what: f,
        detail: `文件在，但没有任何管线引用 \`${parsed.who}\` —— 它一次都不会跑`,
      });
    }
  }

  // ── ② 语言 id 撞了吗
  const seenId = new Map<string, string>();
  for (const f of langFiles) {
    const fromName = parseLangName(f);
    const src = readFileSync(`${langDir}/${f}`, "utf8");
    const fromBody = declaredLangId(src);
    if (fromName === null) {
      problems.push({ kind: "name-mismatch", what: f, detail: `文件名不符合 \`<Id>.lang.ts\`` });
      continue;
    }
    if (fromBody !== null && fromBody !== fromName) {
      problems.push({
        kind: "name-mismatch",
        what: f,
        detail: `文件名说 id 是 "${fromName}"，文件里声明的是 "${fromBody}"`,
      });
    }
    const prev = seenId.get(fromName);
    if (prev !== undefined) {
      problems.push({
        kind: "duplicate-lang-id",
        what: f,
        detail: `语言 id "${fromName}" 已经有 ${prev} 了 —— 两个入口不能用同一个 id`,
      });
    }
    seenId.set(fromName, f);
  }

  // ── ③ pass 声明的 from/to 和文件名对得上吗
  for (const f of passFiles) {
    const parsed = parsePassName(f);
    if (parsed === null) continue; // 上面报过了
    const src = readFileSync(`${passDir}/${f}`, "utf8");
    const { from, to } = declaredEnds(src);
    // 从 import 里建一个「别名 → 语言 id」的表，把 `from: Lsrc` 翻成 "Lsrc"
    const aliasToId = new Map<string, string>();
    for (const m of src.matchAll(
      /import\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\s*from\s*"\.\.\/langs\/[^"]+\.lang\.ts"/g,
    )) {
      const alias = m[1]!;
      const src2 = readFileSync(`${langDir}/${alias}.lang.ts`.replace(/\/\//g, "/"), "utf8");
      const id = declaredLangId(src2);
      if (id !== null) aliasToId.set(alias, id);
    }
    const realFrom = from === null ? null : (aliasToId.get(from) ?? from);
    const realTo = to === null ? null : (aliasToId.get(to) ?? to);
    if (realFrom !== null && realFrom !== parsed.from) {
      problems.push({
        kind: "name-mismatch",
        what: f,
        detail: `文件名说 from 是 "${parsed.from}"，pass 声明的是 "${realFrom}"`,
      });
    }
    if (realTo !== null && realTo !== parsed.to) {
      problems.push({
        kind: "name-mismatch",
        what: f,
        detail: `文件名说 to 是 "${parsed.to}"，pass 声明的是 "${realTo}"`,
      });
    }
  }

  return problems;
}
