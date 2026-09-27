/**
 * `pnpm e2e:tlispi` 的入口 —— **CLI 的分派只住在这里**。
 *
 * 为什么和 `tlispi.ts`（库）分开：那个文件被 `run.ts` import（只为拿 `runSource`），
 * 入口要是住在它里面，就会被**顺带触发**。踩过：stdin 不是 TTY 时它走"读 stdin"分支，
 * 读完写 `process.exitCode = 0`，把断言失败设的退出码清掉 —— `pnpm e2e` 于是永远返回 0。
 *
 * 规矩：**库文件里不许有模块级副作用**。入口是入口，库是库。
 */

import { color } from "./ansi.ts";
import { repl, runSource } from "./tlispi.ts";

const argv = process.argv.slice(2);
const eIdx = argv.indexOf("-e");

if (eIdx >= 0) {
  const code = argv[eIdx + 1] ?? "";
  const ok = runSource(code, "<-e>");
  process.exitCode = ok ? 0 : 1;
} else if (process.stdin.isTTY !== true) {
  // 管道进来的一整段：**当成一串输入**（每个顶层形式一个程序、共享环境），
  // 和交互式一样 —— 这样 `... (define ...) ...` 在哪儿都能写。
  const chunks: string[] = [];
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c: string) => chunks.push(c));
  process.stdin.on("end", () => {
    const ok = runSource(chunks.join(""), "<stdin>", { showAll: argv.includes("--all") });
    process.exitCode = ok ? 0 : 1;
  });
} else {
  repl();
}

void color;
