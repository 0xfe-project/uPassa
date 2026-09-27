/**
 * tlispi —— 这门 tiny lisp 的交互式解释器。
 *
 *   pnpm e2e:tlispi         交互式
 *   pnpm e2e:tlispi -e '(+ 1 2)'   跑一次就退出（给脚本/测试用）
 *
 * 每喂一句就打印：
 *   ① 每个 pass 跑完的中间结果（逐门语言，带语言名和 tag）
 *   ② 最后那条语句的运行返回值
 *
 * 输出带颜色；管道 / 非 TTY 时自动关（见 ansi.ts）。
 */

import { createInterface } from "node:readline";

import { readProgram } from "./read.ts";
import { parse, type Sexp, SyntaxError_ } from "./s-expr.ts";
import { prettyAst } from "./pretty.ts";
import { Env, runProgram, show } from "./eval.ts";
import { color, langColor } from "./ansi.ts";
import { PIPELINE_STEPS } from "./pipeline.ts";
import { runPipeline } from "./linked.ts";

/** 语言名 → 它拿到的那个颜色。按管线顺序分配，一门语言一个色。 */
const LANG_ORDER: string[] = ["Lsrc"];
for (const s of PIPELINE_STEPS) if (LANG_ORDER[LANG_ORDER.length - 1] !== s.to) LANG_ORDER.push(s.to);
const LANG_COLOR = new Map(LANG_ORDER.map((name, i) => [name, langColor(i)]));

function colorOf(lang: string): (s: string) => string {
  return LANG_COLOR.get(lang) ?? color.grey;
}

// ───────────────────────── 跑一段源码 ─────────────────────────

/**
 * 跑一遍：源码 → 每步的中间结果 → 最后一条语句的值。
 *
 * 返回 false 表示出错（报错已经打出来了）。调用方决定要不要把这句话丢掉。
 */
export interface RunOpts {
  quiet?: boolean;
  showAll?: boolean;
  /** 跨多次输入存活的环境。REPL 靠它实现"前面定义的后面能用"。 */
  env?: Env;
}

/**
 * 跑一段源码。
 *
 * **每个顶层形式各跑一个程序，共用一个环境** —— 这才是 REPL 的语义
 * （Racket / Scheme 的 REPL 也是每次输入当一个独立程序、在共享的命名空间里求值）。
 *
 * 为什么必须这样：`Program` 这个形状本身要求"定义在前、表达式在后"
 * （见 e2e/README.md），所以要是把整个会话攒成一个程序，就会出现
 *
 *     > (+ 1 2)
 *     > (define (adder n) (lambda (x) (+ x n)))
 *     语法错误 define 出现在其它表达式之后。定义要放在前面。
 *
 * ——在 REPL 里这说不通：用户只是"又输入了一句"。
 * **一个文件**是一个程序（那条规则管的是它）；**一次会话**是一串程序。
 */
export function runSource(src: string, file: string, opts: RunOpts = {}): boolean {
  const env = opts.env ?? new Env();

  let forms: Sexp[];
  try {
    forms = parse(src, file).forms;
  } catch (e) {
    if (opts.quiet !== true)
      console.log(`${color.red("语法错误")} ${e instanceof SyntaxError_ ? e.message : String(e)}`);
    return false;
  }

  let ok = true;
  for (const form of forms) {
    if (!runOneProgram([form], file, env, opts)) ok = false;
  }
  return ok;
}

/** 一个由若干形式组成的程序（就是"一个文件"那种形态）。 */
function runOneProgram(forms: Sexp[], file: string, env: Env, opts: RunOpts): boolean {
  const log = (s: string): void => {
    if (opts.quiet !== true) console.log(s);
  };

  let ast: unknown;
  try {
    ast = readProgram(forms, file);
  } catch (e) {
    const msg = e instanceof SyntaxError_ ? e.message : String(e);
    log(`${color.red("语法错误")} ${msg}`);
    return false;
  }

  let stages: { name: string; lang: string; ast: unknown }[];
  try {
    stages = runPipeline(ast);
  } catch (e) {
    log(`${color.red("编译错误")} ${(e as Error).message}`);
    return false;
  }

  // ① 每个 pass 跑完的结果
  if (opts.showAll === true) {
    for (const st of stages) {
      const c = colorOf(st.lang);
      log(`${c(st.lang.padEnd(7))} ${color.dim(`← ${st.name}`)}`);
      log(prettyAst(st.ast));
    }
  } else {
    // 默认只显示**每一门语言**的最后一步（同一门语言连续几步不重复打）
    const lastOfLang = new Map<string, (typeof stages)[number]>();
    for (const st of stages) lastOfLang.set(st.lang, st);
    for (const [lang, st] of lastOfLang) {
      const c = colorOf(lang);
      log(`${c(lang.padEnd(7))} ${color.dim(`← ${st.name}`)}`);
      log(prettyAst(st.ast));
    }
  }

  // ② 最后一条语句的值
  const final = stages[stages.length - 1]!.ast;
  try {
    const v = runProgram(final as never, env);
    log(`${color.green("值")} ${color.green(show(v))}`);
  } catch (e) {
    log(`${color.red("运行期错误")} ${(e as Error).message}`);
    return false;
  }
  return true;
}

// ───────────────────────── 交互 ─────────────────────────

function banner(): void {
  console.log(`${color.bold("tlispi")} —— nanopass-ts 的 tiny lisp`);
  console.log(
    color.dim(
      `管线：${LANG_ORDER.join(" → ")}（${PIPELINE_STEPS.length} 个 pass）\n` +
        `输入 (:help 看帮助，:q 退出，:all 打开/关闭逐步显示)\n` +
        `每次输入都是一个独立的程序、共用一个环境 —— 所以随时可以 define`,
    ),
  );
  console.log("");
}

function help(): void {
  console.log(`${color.bold("常用")}`);
  console.log(`  (+ 1 2)                 ${color.dim("→ 3")}`);
  console.log(`  (define (f x) (* x x))  ${color.dim("定义函数")}`);
  console.log(`  (cond [c1 e1] [else e]) ${color.dim("cond → 嵌套 if")}`);
  console.log(`  :all                    ${color.dim("打开/关闭「每一步 pass」的显示")}`);
  console.log(`  :src                    ${color.dim("显示这次会话输入过的内容")}`);
  console.log(`  :reset                  ${color.dim("清空会话（定义也一起清）")}`);
  console.log(`  :q                      ${color.dim("退出")}`);
  console.log("");
  console.log(color.dim("完整语法见 e2e/README.md"));
  console.log("");
}

export function repl(): void {
  banner();
  /**
   * 这次会话输入过的内容。
   *
   * 注意它**不是"待重跑的整个程序"**（以前是）—— 每句输入各跑各的、共享一个 `env`。
   * 攒成一个程序的话，`define` 就只能在第一句了（`Program` 要求定义在前），
   * 而 REPL 里 `define` 必须随时能写。
   */
  let history: string[] = [];
  /** 跨句存活的环境 —— "前面定义的后面能用"就是靠它。 */
  let env = new Env();
  let showAll = false;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: color.cyan("> "),
    completer: undefined,
  });

  rl.prompt();
  rl.on("line", (raw) => {
    const line = raw.trim();

    if (line === ":q" || line === ":quit") {
      rl.close();
      return;
    }
    if (line === ":help") {
      help();
      rl.prompt();
      return;
    }
    if (line === ":all") {
      showAll = !showAll;
      console.log(color.dim(`逐步显示：${showAll ? "开" : "关"}`));
      rl.prompt();
      return;
    }
    if (line === ":src") {
      console.log(history.length === 0 ? color.dim("（这次会话还什么都没输入）") : history.join("\n"));
      rl.prompt();
      return;
    }
    if (line === ":reset") {
      history = [];
      env = new Env(); // 定义也一起清掉 —— 不然"清空了"却还能用旧名字
      console.log(color.dim("已清空（定义也清掉了）"));
      rl.prompt();
      return;
    }
    if (line === "") {
      rl.prompt();
      return;
    }

    // 一次输入可能有好几个形式（比如粘一整段进来）。每个形式各跑一个程序，
    // 但它们共用这一句里的环境 —— 所以 `(define k 1) k` 一次粘进来也对。
    const ok = runSource(line, "<repl>", { showAll, env });
    if (ok) history.push(line);
    else console.log(color.dim("（这句话没有生效）"));
    console.log("");
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(color.dim("再见"));
  });
}

/*
 * ── 这个文件是**库**，不是入口（踩过，代价很大）
 *
 * CLI 入口（`-e` / 管道 / REPL 的分派）原来住在这个文件末尾，是**模块级副作用**。
 * `run.ts` import 这个文件只为拿 `runSource` —— 于是它的入口也被触发了：stdin 不是 TTY
 * 时走"读 stdin"分支，读完写 `process.exitCode = 0`，**把断言失败设的退出码清掉**。
 *
 * 后果：`pnpm e2e` 有失败也返回 0 —— 一个永远说"通过"的门禁。查了很久（`exitCode` 明明
 * 设成了 1，退出码却是 0；microtask 时还是 1，macrotask 时变 0）。现在入口搬到
 * `e2e/cli.ts`，这个文件只导出函数，import 它没有任何副作用。
 */
