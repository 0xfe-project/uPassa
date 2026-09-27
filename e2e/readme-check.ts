/**
 * 校验 README.md 里的例子真的能跑。
 *
 * 格式约定（写在 README 里，也是这里的解析规则）：
 *
 *   ```lisp
 *   > (+ 1 2)          ← 输入。括号没配平的话，下面几行是续行
 *   3                  ← 期望输出（紧跟输入的那一行）
 *   ```
 *
 * 一个代码块里的多个用例是**累积**的（跟 REPL 一样）：前面的 define 后面能用。
 * 期望输出以「语法错误 / 编译错误 / 运行期错误」开头的，意思就是"这一句必须失败"。
 *
 * 为什么要有这个：文档和实现漂了很难发现 —— 例子写着能跑，实际早就不跑了。
 * 让 pnpm e2e 把 README 一起跑掉，漂了立刻红。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readProgram } from "./read.ts";
import { parse, SyntaxError_ } from "./s-expr.ts";
import { runPipeline } from "./linked.ts";
import { Env, runProgram, show } from "./eval.ts";

const ERR_PREFIXES = ["语法错误", "编译错误", "运行期错误"];

function isErrorLine(line: string): boolean {
  return ERR_PREFIXES.some((p) => line.startsWith(p));
}

/** 括号配平吗？（用来判断一行输入是不是还有续行） */
function balanced(src: string): boolean {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === ";")
      break; // 注释后面不管
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
  }
  return depth <= 0;
}

interface Case {
  readonly input: string;
  readonly want: string;
  readonly line: number;
  /** 第一个用例的行号（用来在报错时说"哪个代码块"）。 */
  readonly block: number;
}

/** 从 README 里抽出所有 ```lisp 块里的用例。 */
export function extractCases(md: string): { block: number; cases: Case[] }[] {
  const lines = md.split("\n");
  const blocks: { block: number; cases: Case[] }[] = [];
  let i = 0;
  let inBlock = false;
  let cur: Case[] = [];
  let acc = "";
  let curInput = "";
  let curLine = 0;
  let blockStart = 0;

  const flushInput = (): void => {
    if (curInput !== "") {
      // 还没读到期望输出 —— 下一个非续行就是它
    }
  };
  void flushInput;

  for (i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) {
      if (inBlock) {
        if (curInput !== "" && balanced(curInput)) {
          cur.push({ input: curInput, want: "", line: curLine, block: blockStart });
        }
        blocks.push({ block: blockStart, cases: cur });
        inBlock = false;
        cur = [];
        acc = "";
        curInput = "";
      } else {
        inBlock = line.trim().toLowerCase().startsWith("```lisp");
        blockStart = i + 1;
      }
      continue;
    }
    if (!inBlock) continue;

    if (line.startsWith("> ")) {
      // 上一个输入如果还没等到期望输出（比如 `(define ...)` 这种下一行直接是新输入的），
      // 就按"没有期望输出"收尾 —— 意思是"这句只要求不报错"。
      if (curInput !== "" && balanced(curInput)) {
        cur.push({ input: curInput, want: "", line: curLine, block: blockStart });
      }
      curInput = line.slice(2);
      curLine = i + 1;
      continue;
    }

    if (curInput !== "") {
      if (!balanced(curInput)) {
        curInput += "\n" + line;
        continue;
      }
      cur.push({ input: curInput, want: line.trim(), line: curLine, block: blockStart });
      curInput = "";
      continue;
    }
    // 块里的空行 / 说明文字，忽略
  }
  if (inBlock) {
    if (curInput !== "" && balanced(curInput)) {
      cur.push({ input: curInput, want: "", line: curLine, block: blockStart });
    }
    blocks.push({ block: blockStart, cases: cur });
  }
  return blocks.filter((b) => b.cases.length > 0);
}

/**
 * 跑一个用例：返回实际输出（值或报错信息），以及成功与否。
 *
 * `env` 是**跨用例存活**的环境 —— README 里的 `> ` 块本来就是一段 REPL 记录，
 * 所以模型必须是"每次输入一个独立程序、共用一个环境"，不是"把整个块攒成一个程序"。
 *
 * 顺手也说明了为什么：攒成一个程序的话，`Program` 那条"定义要在前面"的规则会落到
 * 整段会话上 —— 于是 `(+ 1 2)` 之后再来一句 `(define ...)` 就报语法错误，
 * 而 REPL 里那完全正常（用户只是"又输入了一句"）。
 */
function runCase(program: string, env: Env): { ok: boolean; output: string } {
  let ast: unknown;
  try {
    ast = readProgram(parse(program, "<readme>").forms, "<readme>");
  } catch (e) {
    return { ok: false, output: `语法错误 ${e instanceof SyntaxError_ ? e.message : String(e)}` };
  }
  let stages: { ast: unknown }[];
  try {
    stages = runPipeline(ast);
  } catch (e) {
    return { ok: false, output: `编译错误 ${(e as Error).message}` };
  }
  try {
    return { ok: true, output: show(runProgram(stages[stages.length - 1]!.ast as never, env)) };
  } catch (e) {
    return { ok: false, output: `运行期错误 ${(e as Error).message}` };
  }
}

export interface ReadmeResult {
  readonly total: number;
  readonly failures: { case: Case; got: string }[];
}

/** 跑完 README 里所有用例。 */
export function checkReadme(): ReadmeResult {
  const md = readFileSync(fileURLToPath(new URL("./README.md", import.meta.url)), "utf8");
  const blocks = extractCases(md);
  const failures: { case: Case; got: string }[] = [];
  let total = 0;

  for (const b of blocks) {
    // 一个块 = 一次会话：环境跨用例存活，每个用例是**独立的一个程序**（见 runCase 的注释）
    const env = new Env();
    for (const c of b.cases) {
      total += 1;
      const { ok, output } = runCase(c.input, env);
      // want === "" → 没写期望输出（比如 `(define ...)`），只要求不报错
      const pass =
        c.want === ""
          ? ok
          : isErrorLine(c.want)
            ? !ok && output.startsWith(c.want.split(" ")[0]!)
            : ok && output === c.want;
      if (!pass) failures.push({ case: c, got: output });
      // 失败了就把这句丢掉 —— 但环境是共享的，所以失败那句里**已经执行的 define**
      // 会留下来。跟真 REPL 一样（真 REPL 也是这样：报错不影响之前的效果）。
    }
  }
  return { total, failures };
}
