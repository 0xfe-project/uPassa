/**
 * `pnpm mutate`：**变异测试** —— 唯一诚实的"这门 pass 有没有专属单测"的度量。
 *
 * ── 为什么不能靠"查名字"
 *
 * 这一轮我用了三种查法，**三种都是假的**：
 *
 *   按文件名查   `grep -rl "dce"` 匹配到了 `global-dce` —— 子串假阳性
 *   按导出符号查  取到的是 `REFINED_TAGS` 这类辅助导出 —— 指标本身就坏了
 *   按管线名字查  16/16 全中，但"名字出现在测试里"**不等于**"有断言"
 *
 * 真问题只有一个：**把这门 pass 改坏，测试会不会红。** 这个脚本就是把这句话做成命令。
 *
 * ── 怎么用
 *
 * 每条 `Mutation` 是"在某门 pass 里做一处**具体的**改动" —— 改的都是**语义**，不是
 * 排版（所以不需要精确匹配整行，只要那段文本还在）。对每条：
 *
 *   ① 改文件 ② 重跑 gen ③ 跑 e2e ④ **必须红** ⑤ 还原
 *
 * 三种结果，都要当回事：
 *
 *   ✓ 抓到      改坏了 → 测试红了（这条 pass 有专属断言在守着）
 *   ✗ 没抓到    **测试有洞** —— 补断言，不是把这条变异删掉
 *   ⚠ 变异点失效  那段代码搬走了 → 变异本身过期了，要更新（不然这个脚本会静默地什么都不验）
 *
 * 第 2 种这一轮真出现过：`dce` 和 `constant-fold` 一开始就是"没抓到"。
 *
 * ── 不放进 `pnpm e2e`
 *
 * 它要跑 N 次完整的 e2e，是个**审计**工具，不是门禁。要跑就显式跑。
 *
 * ── 两道保险：超时 + 退出时还原（这两条是踩出来的，不是想出来的）
 *
 * 这里真的会出现"变异之后代码不终止"的变异 —— 比如"纯跳转环不判环"就会让
 * `threadJumps` 永远转不完。那不是脚本的 bug，是**变异本身**就该被测出来。
 *
 * 但脚本必须能自己活下来：子进程**一定要有超时**，不然整条命令就那么挂着（踩过：
 * 挂住之后我按了中止，于是 `finally` 没跑到 —— **变异留在了工作区**，之后每一次
 * `node e2e/run.ts` 都跟着挂，看起来像"e2e 坏了"，查了很久才发现是残留的变异）。
 *
 * 所以：
 *   ① 子进程带 `timeout` 选项（超时算"抓到"—— 不终止就是一种可观察的坏行为）
 *   ② 进程退出时（正常退出 / 被信号杀）**一定**把所有文件还原
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

interface Mutation {
  /**
   * 文件路径（相对仓库根）。
   *
   * **不一定在 `e2e/passes/` 下**：CFG / 数据流那几门是独立函数（`e2e/cfg-passes.ts`
   * 之类），不在管线里，但同样需要"改坏了会不会红"这条证据。
   */
  readonly file: string;
  /** 变异点：必须原样出现（找不到就说明这段代码搬走了，变异过期）。 */
  readonly find: string;
  /** 改成什么。 */
  readonly replace: string;
  /** 这处改动**破坏了什么**（写清楚，不然以后看不懂为什么它该被抓到）。 */
  readonly breaks: string;
  /**
   * 要不要重跑 `pnpm gen`。默认要 —— 改的是 `e2e/passes/` 下被管线 import 的文件，
   * 产物会跟着变。改**不被管线引用**的文件（CFG / 数据流那几门）不用重跑，
   * 重跑了也只是白等。
   */
  readonly gen?: boolean;
}

const MUTATIONS: readonly Mutation[] = [
  // ── t35 那 8 门语法糖 / 规范形 ──
  {
    file: "e2e/passes/desugar-def-fun.Lsrc->L1.pass.ts",
    find: "params: rec(n.params),",
    replace: "params: [],",
    breaks: "参数全丢了（调用点立刻对不上）",
  },
  {
    file: "e2e/passes/remove-when-unless.L1->L2.pass.ts",
    find: `      Unless: (n, rec): OutExpr => ({
        type: "If",
        cond: rec(n.cond),
        then: { type: "Void" },
        alt: rec(n.body),
      }),`,
    replace: `      Unless: (n, rec): OutExpr => ({
        type: "If",
        cond: rec(n.cond),
        then: rec(n.body),
        alt: { type: "Void" },
      }),`,
    breaks: "unless 的 then/alt 写反（条件成立时不该执行）",
  },
  {
    file: "e2e/passes/remove-cond.L2->L3.pass.ts",
    find: "for (let i = n.clauses.length - 1; i >= 0; i--)",
    replace: "for (let i = 0; i < n.clauses.length; i++)",
    breaks: "分支顺序反了（第一个 clause 跑到最里层）",
  },
  {
    file: "e2e/passes/remove-and-or-not.L3->L4.pass.ts",
    find: `          const name = freshName("or", cur);
          return {
            type: "Let",
            bindings: [{ type: "Bind", name, value: first }],
            body: {
              type: "If",
              cond: { type: "Var", name },
              then: { type: "Var", name },
              alt: build(from + 1),
            },
          };`,
    replace: `          void cur;
          return { type: "If", cond: first, then: first, alt: build(from + 1) };`,
    breaks: "不造临时变量 → 第一个操作数被求值两次（有副作用就错）",
  },
  {
    file: "e2e/passes/expand-let-star.L4->L5.pass.ts",
    find: "const b = binds[from];",
    replace: "const b = binds[binds.length - 1 - from];",
    breaks: "绑定顺序反了（后面的绑定看不见前面的）",
  },
  {
    file: "e2e/passes/remove-one-armed-if.L5->L6.pass.ts",
    find: 'alt: { type: "Void" },',
    replace: "alt: rec(n.then),",
    breaks: "alt 补成了 then（条件不成立时不该执行 then）",
  },
  {
    file: "e2e/passes/normalize-begin.L6.pass.ts",
    find: "if (exprs.length === 1) return rec(first);",
    replace: 'if (exprs.length === 1) return { type: "Begin", exprs: rec(exprs) };',
    breaks: "一元的 begin 没塌掉（Begin 留在输出里）",
  },
  {
    file: "e2e/passes/normalize-prim-arity.L6.pass.ts",
    find: 'const LEFT_FOLD = new Set(["+", "-", "*", "/"]);',
    replace: 'const LEFT_FOLD = new Set(["+", "-", "*", "/", "<", "="]);',
    breaks: "把链式比较也压成二元 → ((1<2)<3)，意思完全变了",
  },
  // ── t36 那 4 门（环境类 / 局部优化）──
  {
    file: "e2e/passes/const-prop.L6.pass.ts",
    find: "binds.push([b.name, literalOf(value)]);",
    replace: "binds.push([b.name, env.get(b.name) ?? null]);",
    breaks: "let 绑定不遮蔽（局部同名会代成外层的常量）",
  },
  {
    file: "e2e/passes/uncover-free.L6->L7.pass.ts",
    find: `        restore(st, saved);
        const own = st.frames.pop()!;`,
    replace: `        const own = st.frames.pop()!;`,
    breaks: "出 lambda 不还原 active（内层绑的名字泄漏到同层）",
  },
  {
    file: "e2e/passes/dce.L7.pass.ts",
    find: "if (scope.marks.get(b.name)?.ref !== true) continue;",
    replace: "// 变异：不跳过任何绑定",
    breaks: "没人引用的绑定不删（死代码留在输出里）",
  },
  {
    file: "e2e/passes/constant-fold.L6.pass.ts",
    find: "if (vs.length === 2 && vs[1] === 0) return null; // 不折除零，留给运行期报错",
    replace: "",
    breaks: "折掉除零 → 把运行期错误变成了一个值",
  },
  // ── 剩下的（t14 / t15 / t12 那几轮写的）──
  {
    file: "e2e/passes/global-dce.L7.pass.ts",
    find: "const alive = reachableNames(n as never);",
    replace: "const alive = new Set(n.defs.map((d) => d.name));",
    breaks: "可达性退化成'全都可达' → 死定义一个都不删",
  },
  {
    file: "e2e/passes/global-const.L6.pass.ts",
    find: "const genv = globalEnv(n.defs);",
    replace: "const genv = new Map();",
    breaks: "全局环境永远是空的 → 一个常量都代不进去",
  },
  {
    file: "e2e/passes/refine-repr.Lnum->Lsrc.pass.ts",
    find: 'return looksFloat(repr) ? "Float" : "Int";',
    replace: 'return "Int";',
    breaks: "浮点字面量被当成 Int（类型细化整个失效）",
  },
  {
    file: "e2e/passes/algebraic-simplify.L6.pass.ts",
    find: `const isKind = (x: unknown, t: string): boolean =>
  x !== null && typeof x === "object" && (x as Node)["type"] === t;`,
    replace: `const isKind = (x: unknown, t: string): boolean => {
  void x;
  void t;
  return false;
};`,
    breaks: "规则全部认不出任何节点 → 一条代数规则都不生效",
  },
  // ── CFG 那几门（不在管线里，是独立函数；gen 不用重跑）──
  {
    file: "e2e/cfg-passes.ts",
    find: "const live = cp.cfg(u.name).reachable();",
    replace: "const live = new Set(u.blocks.map((b) => b.label));",
    breaks: "不可达判定退化成'全都可达' → 死块一个都不删",
    gen: false,
  },
  {
    file: "e2e/cfg-passes.ts",
    find: 'if (b.stmts.length > 0 || b.term.type !== "Jump") {\n        result = cur;\n        break;\n      }',
    replace: "if (false) {\n        result = cur;\n        break;\n      }",
    breaks: "穿线时连有语句/非 Jump 的块也穿过 → 跳过有内容的块",
    gen: false,
  },
  {
    file: "e2e/cfg-passes.ts",
    find: "if (onPath.has(next)) {\n        result = start; // 环：别动",
    replace: "if (false) {\n        result = start; // 环：别动",
    breaks: "纯跳转环不判环 → 穿线死循环（这条测的是'停不下来'能被抓到）",
    gen: false,
  },
  {
    file: "e2e/cfg-passes.ts",
    find: "const head = order.map((l) => byLabel.get(l)!);",
    replace: "const head = u.blocks;",
    breaks: "块顺序不按 BFS 排（顺序断言该红）",
    gen: false,
  },
  // ── 数据流驱动器 ──
  {
    file: "e2e/dataflow.ts",
    find: `  const seeds = forward
    ? [entry]
    : cfg.unit.blocks.filter((b) => cfg.succ(b.label).length === 0).map((b) => b.label);`,
    replace: "  const seeds = [entry];",
    breaks: "后向分析也从入口起 → 第一趟就没东西可变，整张图全是底（静默算错）",
    gen: false,
  },
  {
    file: "e2e/dataflow.ts",
    find: "const atBoundary = forward ? label === entry : neighbors.length === 0;",
    replace: "const atBoundary = label === entry;",
    breaks: "边界块写死成入口 → 后向分析的边界不对（同上，静默算错）",
    gen: false,
  },
  {
    file: "e2e/dataflow.ts",
    find: "merged = merged === undefined ? v : spec.join(merged, v);",
    replace: "merged = v;",
    breaks: "汇合退化成'取最后一个前驱'（顺序一变结果就变）",
    gen: false,
  },
  // ── 降低到 CFG ──
  {
    file: "e2e/lower-cfg.ts",
    find: 'this.term(cur, { type: "Ret", value: atom } as OutTerm);',
    replace: 'this.term(cur, { type: "Jump", target: cur.label } as OutTerm);',
    breaks: "unit 不以 Ret 收尾 → 后向分析的边界块找不到",
    gen: false,
  },
];

// ───────────────────────── 跑 ─────────────────────────

/**
 * 跑一个子进程。**一定带超时** —— 变异可能让代码不终止（那也是一种"被测出来的坏行为"），
 * 但脚本不能跟着挂。超时返回 `timedOut: true`，由调用方决定它算不算"抓到"。
 */
function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): { code: number; out: string; timedOut: boolean } {
  try {
    return {
      code: 0,
      out: execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      }),
      timedOut: false,
    };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    const timedOut = err.killed === true || err.signal === "SIGTERM";
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}`, timedOut };
  }
}

/** 每个子进程的时限（e2e 正常 1.3 秒，给足余量）。 */
const TIMEOUT_MS = 60_000;

/** 数一下 e2e 报了几条红（`✗`）。 */
const reds = (out: string): number => (out.match(/✗/g) ?? []).length;

const results: { file: string; verdict: "caught" | "missed" | "stale" | "broken"; note: string }[] = [];

/** 当前被改过的文件（路径 → 原文）。进程被杀时靠它还原。 */
const DIRTY = new Map<string, string>();

/**
 * 最后一道保险：不管怎么退出（正常 / 异常 / 被信号杀），都把文件还原回去。
 *
 * 光靠 `finally` 不够 —— 被 SIGINT / SIGTERM 打断时它不跑。这一轮就是因为这个把一处
 * 变异留在了工作区，代价是一次很久的排查。
 */
function restoreAll(): void {
  for (const [p, text] of DIRTY) {
    try {
      writeFileSync(p, text);
    } catch {
      /* 尽力而为 */
    }
  }
  DIRTY.clear();
}
process.on("exit", restoreAll);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    restoreAll();
    process.exit(130);
  });
}

for (const m of MUTATIONS) {
  const path = m.file;
  const original = readFileSync(path, "utf8");

  if (!original.includes(m.find)) {
    results.push({ file: m.file, verdict: "stale", note: "变异点找不到（那段代码搬走了）" });
    continue;
  }

  try {
    // 登记：万一进程被杀（Ctrl-C / 工具中止），下面的 exit 钩子也要还原它。
    // **这是踩过的坑**：挂住之后被中止 → `finally` 没跑到 → 变异留在工作区 →
    // 之后每次 `node e2e/run.ts` 都跟着挂。
    DIRTY.set(path, original);
    writeFileSync(path, original.replace(m.find, m.replace));

    // ① 需要的话重跑 gen，并且**必须成功** —— 失败说明这个变异把文件改成了语法错，
    //    那验的是"编译不过"，不是语义（踩过：一次变异把文件改坏了，脚本报"没抓到"）
    if (m.gen !== false) {
      const gen = run(process.execPath, ["e2e/gen.ts"], TIMEOUT_MS);
      if (gen.code !== 0) {
        results.push({ file: m.file, verdict: "broken", note: "变异之后 gen 跑不过（语法错，验不出语义）" });
        continue;
      }
    }

    // ② e2e 必须红（或者**卡住不返回** —— 那也是一种可观察的坏行为）
    const e2e = run(process.execPath, ["e2e/run.ts"], TIMEOUT_MS);
    const n = reds(e2e.out);
    if (e2e.timedOut) {
      results.push({
        file: m.file,
        verdict: "caught",
        note: `挂住不返回（超过 ${TIMEOUT_MS / 1000}s）—— 变异让代码不终止`,
      });
    } else if (e2e.code !== 0 && n > 0) {
      results.push({ file: m.file, verdict: "caught", note: `${n} 条红` });
    } else if (e2e.code !== 0) {
      // **退出码非 0 但一条 ✗ 都没数到** —— 不是"没抓到"，是**换了个死法**：
      // 变异让代码抛异常 / 撞到一个非法状态，进程在打印断言之前就死了。
      // （踩过：把这一档判成 missed，于是明明崩了的变异被报成"没抓到"。）
      const first = e2e.out.split("\n").find((l) => l.includes("error") || l.includes("Error"));
      results.push({
        file: m.file,
        verdict: "caught",
        note: `抛异常/崩溃（没有 ✗，但在打印断言之前就死了）：${(first ?? "").trim().slice(0, 60)}`,
      });
    } else {
      results.push({
        file: m.file,
        verdict: "missed",
        note: e2e.code === 0 ? "e2e 全绿（没有断言在守它）" : `退出码非 0 但没数到 ✗`,
      });
    }
  } finally {
    writeFileSync(path, original);
    DIRTY.delete(path);
  }
}

// 还原生成物（变异期间 gen 过好几次）
run(process.execPath, ["e2e/gen.ts"], TIMEOUT_MS);

const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - s.length));
let bad = 0;
for (const r of results) {
  const mark = r.verdict === "caught" ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  if (r.verdict !== "caught") bad++;
  console.log(`  ${mark} ${pad(r.file, 36)} ${pad(r.verdict, 8)} ${r.note}`);
}
console.log(
  `\n  ${results.length - bad}/${results.length} 处变异被抓到` +
    (bad > 0 ? `　\x1b[31m${bad} 处没被抓到 / 变异过期\x1b[0m` : ""),
);
if (bad > 0) process.exit(1);
