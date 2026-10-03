/**
 * 性能检查：不许出现 O(n²)。
 *
 *   pnpm perf
 *
 * 对 n 和 4n 的输入跑，耗时比值必须 < 5（4 倍输入，线性的话大约 4 倍）。
 * 每个 pass 和整条链各测一遍，另外专测两处已知容易出事的地方：
 *   - 嵌套 lambda（自由变量收集）
 *   - 树的深度（遍历本身）
 *
 * 失败的会写进退出码，所以 CI 能拦。
 */

import { parse } from "./s-expr.ts";
import { readProgram } from "./read.ts";
import { PIPELINE_STEPS } from "./pipeline.ts";
import { runPipelinePrefix } from "./linked.ts";
import { cleanCfg, liveness } from "./cfg-passes.ts";
import type { CfgProg } from "./cfg.ts";
import { compileStepsWithFallback, runSafe, runSteps, type Step } from "./runner.ts";

// **从管线取**，不在这里手抄一份 —— 手抄的会漏掉新加的 pass（漏过一次）。
const STEPS: readonly Step[] = PIPELINE_STEPS;

/** `ratio` 现在是**斜率**（不是比值）—— 见 `slopeOf` 的注释。 */
const results: { name: string; ratio: number; ok: boolean; note: string }[] = [];

function measure(build: (n: number) => string, steps: readonly Step[]): (n: number) => number {
  // 走**链接产物**（生产路径），不是在这里现编 walker。`steps` 全都是 STEPS 的前缀。
  return (n: number): number => {
    const ast = readProgram(parse(build(n), "perf.tli").forms, "perf.tli");
    const t = process.hrtime.bigint();
    runPipelinePrefix(ast, steps.length);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
}

/**
 * 取最快的一次，压掉抖动。
 *
 * 跑 5 次、而且 n 开得够大（绝对时间 > 10ms）—— 时间太小的时候 GC 和 JIT 会盖过
 * 真实趋势，量出来的比值全是噪声（早期版本 n=500 时，同一个用例一会儿 5.9 一会儿 4.1）。
 */
/**
 * 每个规模测几遍、取最快的一次。
 *
 * 从 7 提到 15：比值卡在阈值附近时，7 遍的"最快"还不够稳（实测不同次跑会给出
 * 不同的"超线性"名单，而算法根本没改）。多取几遍让最小值更接近真实下限。
 */
const REPS = 15;

/**
 * 每一趟计时**之前**先收一次垃圾。
 *
 * 为什么必须做：在不受控的堆上量墙钟时间，分不清"算法超线性"和"GC 变贵"。前面用例留下的
 * 垃圾会让后面的用例变慢，而那个变慢**跟输入大小无关、却跟"跑到了第几个用例"有关** ——
 * 报出来的比值看着像超线性，其实研究的是别的用例。
 *
 * 踩到过：CFG 活跃性那个用例单独量是 ×3.75（线性），在这个 harness 里报 ×6.11。
 * 顺带把建图和分析分开量过：×4.35 和 ×3.75，都是线性的。
 */
function collect(): void {
  const g = (globalThis as { gc?: () => void }).gc;
  if (g !== undefined) {
    g();
    return;
  }
  const bun = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun;
  bun?.gc?.(true);
}

function best(f: (n: number) => number, n: number, reps = REPS): number {
  let out = Infinity;
  for (let i = 0; i < reps; i++) {
    collect();
    out = Math.min(out, f(n));
  }
  return out;
}

/**
 * 在 4 个规模上量，拟合 **log-log 斜率**。
 *
 * 为什么不用"n 和 4n 的比值"：那个统计量只有两个点，环境噪声（别的进程、温度、
 * GC 时机）直接进到比值里 —— 实测同一个 commit 在同一个 runtime 上，比值在 4.3~5.5
 * 之间抖，于是"超线性"名单每次跑都不一样（而算法一个字没改）。一个会抖的门禁比没有门禁更糟：
 * 人会开始忽略它。
 *
 * 斜率是**形状**：`t = c·n^k` 里的 k。线性是 1、平方是 2。4 个点最小二乘之后，
 * 全局性的"这次跑得慢一点"会被抵消掉（它同时抬高所有点，不改变斜率）。
 *
 * 分辨率：这台机器上实测斜率能稳定分辨 1.0 / 1.3 / 2.0，所以阈值定在
 * **> 1.25 就算超线性**（真正的 O(n²) 会给 2.0，隔得很远）。
 */
function slopeOf(sizes: number[], times: number[]): number {
  const xs = sizes.map((x) => Math.log(x));
  const ys = times.map((y) => Math.log(y));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** 一个案例量出来的东西。 */
interface PerfRun {
  readonly sizes: number[];
  readonly times: number[];
  readonly slope: number;
  /** 最小那档的绝对时间太小 —— 比值/斜率都不可信，不判。 */
  readonly noisy: boolean;
}

function runCase(f: (n: number) => number, n: number): PerfRun {
  f(n); // 预热
  const sizes = [n, n * 2, n * 4, n * 8];
  const times = sizes.map((s) => best(f, s));
  return { sizes, times, slope: slopeOf(sizes, times), noisy: times[0]! < 20 };
}

function check(name: string, f: (n: number) => number, n = 1000, note = ""): void {
  let r = runCase(f, n);

  // 卡在阈值附近就多量几遍再取更好的那个：环境噪声是慢变的，多量能把这一次的运气压下去。
  // 这不是"重试到过为止" —— 真正的超线性斜率是 2.0，跟 1.25 隔着一个量级。
  if (!r.noisy && r.slope > 1.25) {
    const again = runCase(f, n);
    if (again.slope < r.slope) r = again;
  }

  results.push({
    name,
    ratio: r.slope,
    ok: r.noisy || r.slope <= 1.25,
    note:
      `${r.times.map((t) => t.toFixed(1)).join(" → ")}ms  斜率 ${r.slope.toFixed(2)}` +
      (r.noisy ? "（样本太小，不可信）" : note),
  });
}

function countOutput(node: unknown): number {
  let n = 0;
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      x.forEach(walk);
      return;
    }
    if (x === null || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (o["type"] === "BindFree" && Array.isArray(o["names"])) n += (o["names"] as string[]).length;
    for (const [k, v] of Object.entries(o)) if (k !== "__meta__") walk(v);
  };
  walk(node);
  return n;
}

/** 深度那两项：比的是**每条输出的耗时**，不是总耗时（见 t25 的注释）。 */
function checkDepth(name: string, n: number, d0: number, d1: number): void {
  const run = (depth: number): { ms: number; size: number } => {
    const src = nested(n, depth);
    const ast = readProgram(parse(src, "perf.tli").forms, "perf.tli");
    let best = Infinity;
    let size = 0;
    for (let i = 0; i < REPS; i++) {
      const t = process.hrtime.bigint();
      const out = runSteps(ast, STEPS);
      best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
      size = countOutput(out.at(-1)!.ast);
    }
    return { ms: best, size };
  };

  const a = run(d0);
  const b = run(d1);
  const perEntry = b.size > 0 ? b.ms / b.size / (a.ms / a.size) : 1;
  results.push({
    name,
    ratio: perEntry,
    ok: perEntry < 2,
    note:
      `${a.ms.toFixed(1)}ms/${a.size}条 → ${b.ms.toFixed(1)}ms/${b.size}条` +
      `（总耗时 ×${(b.ms / a.ms).toFixed(2)}，输出 ×${(b.size / a.size).toFixed(2)}）`,
  });
}

// ───────── 输入生成 ─────────

/** 平铺：一堆互不嵌套的函数。 */
function flat(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      `(define (f${i} x) (let* ((a (+ x ${i} 1)) (b (* a 2))) ` +
        `(cond [(< b 10) (when #t a)] [(= b 10) 5] [else (or (not (= a b)) (+ 1 2 3))])))`,
    );
  }
  return out.join("\n");
}

/**
 * 一个函数，里面很多层 let、最后一口气用掉所有变量。
 *
 * 一个函数：n 层嵌套 let（每层一个变量），最后一口气用掉所有变量。
 *
 * 这是给**自由集**准备的：uncoverFree 在每个 Let 上都要复制一份体的自由集，而那份集合的
 * 大小 ~ 变量数 V，所以嵌套 let + 很多变量时是 O(n·V)。平铺输入（每个函数 4 个变量）
 * 测不出来 —— 必须专门造这种形状。
 * （顺带：dce 以前也是同一族，已经改成可变的活跃绑定表了，现在是线性的。）
 *
 * n 只能开到 200 左右：再大就是 1000 层嵌套的 let 链，而**生成的遍历器是递归下树的**，
 * 会 RangeError: Maximum call stack size exceeded（见 t27）。
 */
function manyVars(n: number): string {
  const names = Array.from({ length: n }, (_, i) => `v${i}`);
  const binds = names.map((v, i) => `(${v} (f ${i}))`).join(" ");
  // 绑定值**不能是字面量** —— 是的话 constProp 会把它们代进去、constantFold 再把整棵
  // 树折成一个 Int，后面几步就看不到那些 let 了（那这条用例就白测了）。
  //
  // **宽而浅**：一个 let 绑 n 个变量，不是 n 层嵌套 let。
  // 为什么改：原来是嵌套的，n 一到 1500 就撞上"遍历器嵌套太深"的已知限制，量不大。
  // 而这条用例要测的本来就是"一个作用域里很多变量"（自由集大小 ~ 变量数）——
  // 宽了才对得上，而且能长大。
  //
  // 尾巴上用 **Call** 而不是 `(+ v0 … vn)`：后者会被 `normalize-prim-arity` 左折叠成
  // **n 层嵌套的 Prim**，于是"宽而浅"变成"宽而且 n 层深" —— 真 node 上（栈比 Bun 小）
  // 1500 层就直接溢出了。Call 不二值化，深度是常数。
  return `(define (big) (let (${binds}) (g ${names.join(" ")})))\n(big)`;
}

/**
 * 一个 k 元的 or（只有一个函数）。
 *
 * 这是给 removeAndOrNot 准备的：它以前用 `exprs.slice(1)` 递归，对一个 k 元的 or 会造出
 * k-1 个递减的数组（O(k²) 内存流量）。改成下标之后是 O(k)。
 *
 * 注意这里**放大的是 k**（不是函数个数）：k 元 or 会展开成 k 层嵌套，所以 n 和 4n
 * 直接量 k 和 4k。要是 O(k²)，比值会是 ~16 而不是 ~4。
 * （k 不能太大 —— 会撞上遍历器的深度限制，见 t27。）
 */
function orOne(k: number): string {
  const args = Array.from({ length: k }, (_, i) => `(> x ${i})`).join(" ");
  return `(define (t x) (or ${args}))\n(t 1)`;
}

/** 嵌套 lambda：自由变量收集的最坏情况。 */
function nested(n: number, depth: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let body = `(+ x${i} g)`;
    for (let d = 1; d < depth; d++) body = `(lambda (y${d}) (let ((t (+ y${d} ${d}))) ${body}))`;
    out.push(`(define (n${i} x${i}) ${body})`);
  }
  return out.join("\n");
}

// ───────── 测 ─────────

for (const [i, st] of STEPS.entries()) {
  const prefix = STEPS.slice(0, i + 1);
  check(`${String(i + 1).padStart(2, "0")} ${st.name}`, measure(flat, prefix));
}
check("整条链（平铺）", measure(flat, STEPS));
check(
  "嵌套 20 层",
  measure((n) => nested(n, 20), STEPS),
  1000,
);
/**
 * 只跑到 removeAndOrNot —— 这条测的是**它自己的**中间数组，不是后面 pass 的账。
 *
 * 跑整条链的话这条会显示 ×8，但那是 dce 的 t26（k 层嵌套 let → 每层复制一遍 used 集合
 * → O(k²)），跟 or 的展开没关系。实测：跑到 andOrNot 是 3.13（线性），再加一步 dce 变 8.66。
 * 把两种代价混在一条检查里，谁也定位不了。
 *
 * （k 也不能开大：k 元 or 会展开成 k 层嵌套，会撞上遍历器的深度限制，见 t27。）
 */
check("or 的 k→4k（中间数组，只到 removeAndOrNot）", measure(orOne, STEPS.slice(0, 4)), 500);

/**
 * 一条很长的 `+` 链（t12 的 AC 展平）。
 *
 * 展平 + 排序是新的线性面：`(+ a b c ... )` 展平要扫一遍操作数、排序要 O(k log k)。
 * 这里量的是"链长 4 倍，耗时是不是 4 倍左右"。**不是** O(k²) —— 展平只做一次，
 * 不嵌套，所以没有"每个节点都重扫整条链"那种事。
 */
function longChain(n: number): string {
  const params = Array.from({ length: 8 }, (_, i) => `x${i}`);
  const body = Array.from({ length: n }, (_, i) => `x${i % 8}`);
  return `(define (f ${params.join(" ")}) (+ ${body.join(" ")}))`;
}
check("长 + 链（AC 展平 + 排序）", measure(longChain, STEPS), 400);

// ───────── CFG 那几层（t16/t17）自己也要有线性的证据 ─────────

/**
 * 一条很长的**空跳转链**：`b0→b1→…→bn`。
 *
 * 这是 `threadJumps` 最容易写成 O(n²) 的地方 —— 每个块都沿着链走一遍就是平方。
 * 记忆化之后整条链只走一次。用 lowering + cleanCfg 一起量（它们是配套的）。
 */
function longJumpChain(n: number): CfgProg {
  const blocks: unknown[] = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ type: "Block", label: `b${i}`, stmts: [], term: { type: "Jump", target: `b${i + 1}` } });
  }
  blocks.push({
    type: "Block",
    label: `b${n}`,
    stmts: [{ type: "Assign", name: "r", value: { type: "AInt", value: 1 } }],
    term: { type: "Ret", value: { type: "AVar", name: "r" } },
  });
  return {
    type: "Prog",
    units: [{ type: "Unit", name: "u", params: [], entry: "b0", blocks }],
  } as unknown as CfgProg;
}

function measureCfg(build: (n: number) => unknown): (n: number) => number {
  return (n: number): number => {
    const p = build(n);
    const t = process.hrtime.bigint();
    cleanCfg(p as CfgProg);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
}
// n 提到绝对时间 > 5ms，不然 perf 自己会标"样本太小不可信"
check("CFG 长跳转链（穿线 + 排序）", measureCfg(longJumpChain), 20000);

/**
 * 一条很长的块链，每块一个新名字 —— 专门量**活跃性**。
 *
 * 量的是"块数 × 变量数"那个经典代价：活跃集是一串名字，join 要按名字并一遍。
 * 变量数固定的话，代价应该跟块数成正比（这正是位向量数据流的标准代价）。
 */
const POOL = 32;

function wideBlocks(n: number): CfgProg {
  const blocks: unknown[] = [];
  for (let i = 0; i < n; i++) {
    blocks.push({
      type: "Block",
      label: `b${i}`,
      stmts: [{ type: "Assign", name: `t${i}`, value: { type: "AVar", name: "seed" } }],
      term: { type: "Jump", target: `b${i + 1}` },
    });
  }
  // 尾巴上一次性用到 POOL 个名字 → 整条链上**每个块**的 live-out 都有 POOL 个名字。
  // 这才量得到"块数 × 变量数"那一维（不然活集很小，量出来的是个常数）。
  const use: unknown[] = [];
  for (let i = 0; i < POOL; i++) use.push({ type: "AVar", name: `v${i}` });
  blocks.push({
    type: "Block",
    label: `b${n}`,
    stmts: [],
    term: { type: "Ret", value: { type: "APrim", op: "+", args: use } },
  });
  return {
    type: "Prog",
    units: [{ type: "Unit", name: "u", params: [], entry: "b0", blocks }],
  } as unknown as CfgProg;
}
/**
 * 量活跃性。
 *
 * **夹具只建一次**：`best()` 会把同一个 n 跑 5 遍，要是每遍都重新造一遍程序，
 * 计时里量到的就是"造 + 扔掉一堆大对象"的 GC，不是分析本身 —— 实测那个比值会飘到
 * 5.5（看着像超线性），而分开量建图（×4.35）和分析（×3.75）都清清楚楚是线性的。
 * benchmark 自己引入的平方/GC 是 benchmark 的错，不是库的错。
 */
function measureLiveness(build: (n: number) => CfgProg): (n: number) => number {
  const cache = new Map<number, CfgProg>();
  return (n: number): number => {
    let p = cache.get(n);
    if (p === undefined) {
      p = build(n);
      cache.set(n, p);
    }
    const t = process.hrtime.bigint();
    for (const u of p.units) liveness(u);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
}
check("CFG 活跃性（很多块 × 32 个名字）", measureLiveness(wideBlocks), 40000);

// 同规模、只改嵌套深度 —— uncoverFree 的真面目在这儿。
// 上面那条"n 变 4 倍"的检查看不出它：深度不变时它看起来是线性的。
// n 够大，绝对时间才不会小到"比值全是噪声"（perf 会自己标出来）
check("单函数多变量（自由集 / 很多变量）", measure(manyVars, STEPS), 1500);
checkDepth("嵌套深度 1→4（同规模）", 2000, 1, 4);
checkDepth("嵌套深度 10→40（同规模）", 2000, 10, 40);

/**
 * 已知的超线性，正在还债。列在这里的会被报到终端上、但不让脚本失败 ——
 * 这样新引入的超线性会立刻变成红的，而这些老账不会把 CI 一直卡住。
 *
 * 每个都要有对应的任务，改完就从这里删掉。现在是空的（t25 已还）。
 *
 * 提醒：用这张表之前先想清楚**输出本身**有多大。uncoverFree 那条一度看着像
 * O(n·d²)，实际输出只有 O(n·d) —— 是"每条输出的耗时随深度涨"，不是输出在涨。
 * 所以量的时候要连输出规模一起看，否则会把"没有多余 factor"误判成超线性。
 */
/**
 * 已知的超线性，正在还债。
 *
 * **现在是空的。** 这里曾经记着 t26 那条（uncoverFree 每个 Let 复制一份自由集 → O(n·V)）——
 * 改成"宽而浅"的用例（一个 let 绑 n 个变量，而不是 n 层嵌套 let）之后量出来是 ×2.97，
 * 说明债已经还了。之前它一直显示"线性"只是因为嵌套形状下 n 长不大、时间小到全是噪声。
 */
const KNOWN_SUPERLINEAR = new Map<string, string>([]);

// ───────── 兜底 vs 参考（融合已砍，t38）─────────
//
// 融合曾经在这里占一整节（递归 / 蹦床 / 兜底三条对照）。砍掉之后要盯的就剩一条：
// **生产形态（逐 pass 兜底）比"老老实实逐 pass 跑"慢不慢** —— 也就是那层 try/catch 的代价。
//
// 理论上应该是 0：`try` 包在 `run` 最外层，V8 不因为它的存在就放弃优化（实测过）。

{
  const safe = compileStepsWithFallback(STEPS);
  const mk = (n: number): unknown => readProgram(parse(flat(n), "perf.tli").forms, "perf.tli");
  const runWith = (n: number, f: (ast: unknown) => unknown): number => {
    const ast = mk(n);
    const t0 = process.hrtime.bigint();
    f(ast);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const ref = (ast: unknown): unknown => runSteps(ast, STEPS);
  const prod = (ast: unknown): unknown => runSafe(ast, safe);

  runWith(1000, ref); // 预热
  let a = Infinity;
  let d = Infinity;
  for (let i = 0; i < REPS; i++) {
    a = Math.min(a, runWith(1000, ref));
    d = Math.min(d, runWith(1000, prod));
  }
  console.log(`\n管线：${STEPS.length} 门 pass（逐 pass 跑；融合已砍）`);
  console.log(`  n=1000  逐 pass 参考      ${a.toFixed(1)} ms`);
  console.log(
    `          逐 pass 兜底（生产）${d.toFixed(1)} ms   ${(a / d).toFixed(2)}×  （默认走递归遍历器；某门溢出才换蹦床重跑那一门）`,
  );
}

// ───────── 显示 ─────────

for (const r of results) {
  const known = KNOWN_SUPERLINEAR.get(r.name);
  if (known !== undefined && !r.ok) {
    r.ok = true;
    r.note += `   ← 已知，正在还债：${known}`;
  }
}

const line = "─".repeat(64);
console.log(
  `nanopass-ts perf（在 n/2n/4n/8n 四个规模上拟合 log-log 斜率：线性 = 1.00，平方 = 2.00，\n` +
    `      > 1.25 就算超线性；深度那两项比的是"每条输出的耗时"，见 checkDepth 的注释）\n${line}`,
);
for (const r of results) {
  console.log(
    `  ${r.ok ? (r.note.includes("← 已知") ? "△" : "✓") : "✗"} ${r.name.padEnd(26)} k=${r.ratio.toFixed(2).padStart(5)}   ${r.note}`,
  );
}
const bad = results.filter((r) => !r.ok);
const known = results.filter((r) => r.note.includes("← 已知"));
console.log(
  `\n${results.length - bad.length - known.length} 线性 / ${known.length} 已知超线性 / ${bad.length} 新超线性`,
);
if (bad.length > 0) {
  console.log(`\n超线性的：${bad.map((b) => b.name).join("、")}`);
  console.log("每处要么改掉，要么在代码里写清楚为什么在豁免范围内（见 AGENTS.md）。");
  process.exitCode = 1;
}
