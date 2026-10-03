/**
 * e2e —— 从源码到 AST 的第一步：纯 s-expr reader → 糖多的 Lsrc。
 *
 *   pnpm e2e
 *
 * 中间结果写在 e2e/__out__/（**进仓库**，所以能在 diff 里看 codegen 和 AST 怎么变）。
 *
 * 现在这一版只覆盖 reader。等 pass 立起来之后这里会串上整条管线 + 解释器。
 */

import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Lnum } from "./langs/Lnum.lang.ts";
import { Lsrc } from "./langs/Lsrc.lang.ts";
import { L1 } from "./langs/L1.lang.ts";
import { L2 } from "./langs/L2.lang.ts";
import { L3 } from "./langs/L3.lang.ts";
import { L4 } from "./langs/L4.lang.ts";
import { L5 } from "./langs/L5.lang.ts";
import { L6 } from "./langs/L6.lang.ts";
import { L7 } from "./langs/L7.lang.ts";
import { runProgram, show } from "./eval.ts";
import { MAIN, PIPELINES, PIPELINE_STEPS } from "./pipeline.ts";
import { execFileSync } from "node:child_process";
import * as LINKED from "./__out__/main.pipeline.js";
import { linkPipeline } from "./link.ts";
import { readFileSync } from "node:fs";
import { runPipelinePrefix, runPipelineRange } from "./linked.ts";
import { checkReadme } from "./readme-check.ts";
import { Env } from "./eval.ts";
import { runSource } from "./tlispi.ts";
import { checkLinks } from "./link-check.ts";
import { LINK_CASES, runLinkCase } from "./tests-link.ts";
import { rewriteChecks } from "./tests-rewrite.ts";
import { algebraicChecks } from "./tests-algebraic.ts";
import { fixpointChecks } from "./tests-fixpoint.ts";
import { g2Checks } from "./tests-g2.ts";
import { t35Checks as sugarChecks } from "./tests-sugar.ts";
import { t36Checks as passChecks } from "./tests-passes.ts";
import { refineChecks } from "./tests-refine.ts";
import { cfgChecks } from "./tests-cfg.ts";
import { dataflowChecks } from "./tests-dataflow.ts";
import { cfgPassChecks } from "./tests-cfg-passes.ts";
import { g1Checks } from "./tests-g1.ts";
import { readProgram } from "./read.ts";
import { compileStepsWithFallback, runSafe, runSteps, step, type Step } from "./runner.ts";
import { parse, SyntaxError_, unparse } from "./s-expr.ts";
import { color } from "./ansi.ts";

const OUT = fileURLToPath(new URL("./__out__/", import.meta.url));

/*
 * 生成物的后缀是 **`.js`**，不是 `.ts`。
 *
 * codegen 吐出来的是**纯 JS** —— 它要能直接喂给 `new Function`，里面一个类型注解都没有。
 * 顶着 `.ts` 后缀的话：① 名字和内容不符（这个仓库到处在修"名字和体要一致"，
 * 见 e2e/link-check.ts）；② 而且它还被 tsconfig 排除在类型检查之外，
 * 于是那个后缀在暗示一件它根本没提供的东西。
 *
 * 真要"给生成物加上类型"，那是另一件事（生成 TS 语法 + 把接口标注出来），
 * 不是把后缀改回去 —— 遍历器本身就是按字符串 tag 在 `any` 上调度的。
 */

/** 这些 tag 是糖 —— 走到终点之前必须全部消失。 */
const SUGAR = new Set(["DefFun", "When", "Unless", "Cond", "Clause", "And", "Or", "Not", "LetStar", "IfAlt"]);

/**
 * 每条 pass 允许让哪些 tag 消失。顺序与 STEPS 对齐。
 *
 * 同语言的 pass 是空的 —— 它们不该让任何 tag 消失。这条比"没有外来 tag"更强：
 * 它能抓到某个 pass 把不该丢的东西悄悄丢了（那种错误类型检查抓不到，因为
 * 输出语言里那个 tag 存在，只是这次的树里没有）。
 */
/** 每个 pass 允许丢哪些 tag。**按名字查**，不按下标 —— 下标会随管线增删漂移。 */
const REMOVES: Readonly<Record<string, readonly string[]>> = {
  "desugar-def-fun": ["DefFun"],
  "remove-when-unless": ["When", "Unless"],
  "remove-cond": ["Cond", "Clause"], // Clause 只挂在 Cond 底下，所以一起没了
  "remove-and-or-not": ["And", "Or", "Not"],
  "expand-let-star": ["LetStar"],
  "remove-one-armed-if": ["IfAlt"],
  // refine-repr：把笼统的 Num 细分成 Int / Float —— 丢的就是 Num 这一个 tag
  "refine-repr": ["Num"],
  "normalize-begin": [], // 同语言
  "normalize-prim-arity": [], // 同语言
  "algebraic-simplify": [], // 同语言，只改结构不改 tag 集合
  "const-prop": [], // 同语言，只把 Var 换成字面量
  // constant-fold 与 dce **不在这里** —— 它们各自会把整棵子树丢掉，所以任何 tag
  // 都可能合法地消失。这条限制对"只删指定糖"的去糖 pass 有意义，对会删代码的 pass 没意义。
  "uncover-free": [], // 只加一个产生式，tag 集合只增不减
};

/** 会删掉任意子树的 pass —— 它们的 tag 消失不该报错。 */
const WILD_REMOVES = new Set<string>(["constant-fold", "dce", "global-dce"]);

/** 还没写 pass 的糖。写完一个就从这里删一个 —— 别让它悄悄留着。 */
const PENDING_SUGAR = new Set<string>([]);

// ───────────────────────── 断言 ─────────────────────────

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
}

function write(name: string, contents: string): void {
  writeFileSync(new URL(`./__out__/${name}`, import.meta.url), contents);
}

function dump(name: string, value: unknown): void {
  write(name, JSON.stringify(value, null, 2) + "\n");
}

/** 走一遍树，把每个节点的 tag 收齐。 */
function tagsIn(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const x of node) tagsIn(x, into);
    return into;
  }
  if (node === null || typeof node !== "object") return into;
  const obj = node as Record<string, unknown>;
  if (typeof obj["type"] === "string") into.add(obj["type"]);
  for (const [k, v] of Object.entries(obj)) {
    if (k === "__meta__") continue;
    tagsIn(v, into);
  }
  return into;
}

/** 每个节点都得带 __meta__（除了上面贴好的那些）。返回缺的节点数。 */
function countMissingMeta(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((n, x) => n + countMissingMeta(x), 0);
  if (node === null || typeof node !== "object") return 0;
  const obj = node as Record<string, unknown>;
  if (typeof obj["type"] !== "string") return 0;
  let n = obj["__meta__"] === undefined ? 1 : 0;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "__meta__") continue;
    n += countMissingMeta(v);
  }
  return n;
}

// ───────────────────────── 测试程序 ─────────────────────────

const FILE = "demo.tli";

const SOURCE = `
; 一段把糖都用上的小程序
(define (fact n)
  (if (< n 2)
      1
      (* n (fact (- n 1)))))

(define (classify n)
  (cond [(< n 0) "neg"]
        [(= n 0) "zero"]
        [else "pos"]))

(define scale (lambda (x) (let* ((a (* x 2)) (b (+ a 1))) b)))

(define (even? n)
  (letrec ((ev? (lambda (k) (if (= k 0) #t (od? (- k 1)))))
           (od? (lambda (k) (if (= k 0) #f (ev? (- k 1))))))
    (ev? n)))

(define (f n)
  (let ((x (when #t 1))
        (y (unless #f 2)))
    (begin
      (and (> x 0) (or (< y 10) (not (= x y))))
      (if (when #t #t) x)
      (fact 5))))

(classify (scale 3.5))
`;

// ───────────────────────── 跑 ─────────────────────────

// 清**自己负责的那部分**，不是整个目录。
//
// `__out__` 现在住着两种东西：① 这份脚本落的转储（`NN-*.json` / `*.txt`），
// ② `pnpm gen` 落的链接产物（`<名字>.pipeline.js` / `.d.ts`）。
// 曾经这里是 `rmSync(OUT, recursive)` —— 那就把**产物一起删了**，于是"产物和真跑的那份一致"
// 这条断言永远在跟一个刚被删掉的文件说话。谁的东西谁负责清。
for (const e of readdirSync(OUT).filter((x) => /^\d\d-/.test(x))) {
  rmSync(`${OUT}/${e}`, { force: true });
}

const { forms } = parse(SOURCE, FILE);
dump("01-forms.txt", forms.map(unparse).join("\n") + "\n");

const ast = readProgram(forms, FILE);
dump("01-ast.json", ast);

const used = tagsIn(ast);
const declared = new Set<string>();
for (const prods of Object.values(Lsrc.rules)) for (const tag of Object.keys(prods)) declared.add(tag);

/**
 * 源码语法**产生不了**的产生式 —— 去糖的时候才造得出来。
 * 它们不该被"reader 覆盖"这条要求卡住，但在后面接解释器时会被真正跑到。
 */
const NOT_FROM_SOURCE = new Set(["Prog", "Void"]);

const missing = [...declared].filter((t) => !used.has(t) && !NOT_FROM_SOURCE.has(t)).sort();

// ───────────────────────── 显示 ─────────────────────────

const rule = color.grey("─".repeat(64));
console.log(`${color.bold("nanopass-ts e2e")}   ${color.dim("源码 → AST")}`);
console.log(rule);
console.log(`${color.dim("输入")} ${FILE}  （${forms.length} 个顶层形式）`);
console.log(`${color.dim("输出")} e2e/__out__/01-forms.txt · e2e/__out__/01-ast.json`);
console.log("");
console.log(`${color.dim("用到的 Lsrc 产生式")} ${used.size}/${declared.size}`);
console.log(
  `  ${[...used]
    .sort()
    .map((t) => color.cyan(t))
    .join(" ")}`,
);
console.log("");
console.log(
  `${color.dim("还没被覆盖的")} ${missing.length > 0 ? missing.map((t) => color.yellow(t)).join(" ") : color.green("（全盖住了）")}`,
);
console.log(
  `${color.dim("还差这些 pass")} ${
    PENDING_SUGAR.size > 0
      ? [...PENDING_SUGAR]
          .sort()
          .map((t) => color.yellow(t))
          .join(" ")
      : color.green("（都写完了）")
  }`,
);

// ───────────────────────── 断言 ─────────────────────────

const prog = ast as unknown as Record<string, unknown>;
check("顶层被读成 Program", prog["type"] === "Prog");
check(
  "5 个 define 变成 defs",
  (prog["defs"] as unknown[]).length === 5,
  `实际 ${(prog["defs"] as unknown[]).length}`,
);
check("最后一个形式是体", (prog["body"] as unknown[]).length === 1);

check("每层都有 __meta__（行号）", countMissingMeta(ast) === 0, `缺 ${countMissingMeta(ast)} 个`);

const defs = prog["defs"] as Record<string, unknown>[];
/** 按名字找定义 —— 不要按下标，插一个 define 就会错位。 */
function defOf(tree: unknown, name: string): Record<string, unknown> | undefined {
  const ds = (tree as Record<string, unknown>)["defs"] as Record<string, unknown>[] | undefined;
  return ds?.find((d) => (d as Record<string, unknown>)["name"] === name);
}
const bodyOf = (name: string): Record<string, unknown> =>
  (defOf(ast, name)?.["body"] ?? {}) as Record<string, unknown>;

check("(define (fact n) ...) 读成 DefFun", defOf(ast, "fact")?.["type"] === "DefFun");
check("(define scale (lambda ...)) 读成 DefVal", defOf(ast, "scale")?.["type"] === "DefVal");

const factBody = bodyOf("fact");
check("(if c t e) 读成 If", factBody["type"] === "If");
check(
  "  → 三臂齐全",
  factBody["cond"] !== undefined && factBody["then"] !== undefined && factBody["alt"] !== undefined,
);

const classifyBody = bodyOf("classify");
check("(cond ...) 读成 Cond", classifyBody["type"] === "Cond");
check(
  "  → 2 个 clause + else",
  (classifyBody["clauses"] as unknown[]).length === 2 && classifyBody["else"] !== undefined,
);
check(
  "  → 字符串字面量读成 Str",
  ((classifyBody["clauses"] as Record<string, unknown>[])[0]?.["body"] as { type?: string })?.type === "Str",
);

const lam = (defOf(ast, "scale")?.["value"] ?? {}) as Record<string, unknown>;
check("(lambda ...) 读成 Lam", lam["type"] === "Lam");
check("  → 体是 let* ", ((lam["body"] ?? {}) as Record<string, unknown>)["type"] === "LetStar");

const fBody = bodyOf("f");
check("(let ...) 读成 Let", fBody["type"] === "Let");
const begin = ((fBody["bindings"] as Record<string, unknown>[])[0]?.["value"] ?? {}) as Record<
  string,
  unknown
>;
check("(when #t 1) 读成 When", begin["type"] === "When");
check(
  "(unless #f 2) 读成 Unless",
  ((fBody["bindings"] as Record<string, unknown>[])[1]?.["value"] as { type?: string })?.type === "Unless",
);

check("一臂 if 读成 IfAlt（不是 If）", JSON.stringify(ast).includes('"IfAlt"'));
// 读入器只记"源码里怎么写"（repr），分 Int/Float 是 refine-repr 干的
const numericRaw = readProgram(parse("1 2.5 -3 4.0 #t", "n.tli").forms, "n.tli");
const rawKinds = (numericRaw.body as { type: string }[]).map((n) => n.type);
check(
  "读入器产出笼统的 Num（不自己分 Int/Float）",
  JSON.stringify(rawKinds) === JSON.stringify(["Num", "Num", "Num", "Num", "Bool"]),
  rawKinds.join(" "),
);

// ───────────────────────── 管线的自述（t32）─────────────────────────
//
// 一条管线是**有名字的东西**，不是一堆散 steps —— 链接产物是 `<名字>.pipeline.js`，
// 没名字就没法给产物命名。这里验自述和真实 steps 对得上、以及"可以有 N 条"这件事没被写死。
{
  const d = MAIN.describe();
  check(
    "管线自述：名字 / 入口 / 出口",
    d.name === "main" && d.entry === "Lnum" && d.exit === "L7",
    `${d.name}: ${d.entry} → ${d.exit}`,
  );
  check(
    "管线自述：每步都有名字和 from/to",
    d.steps.length === MAIN.steps.length &&
      d.steps.every((x) => x.name !== "" && x.from !== "" && x.to !== ""),
    `${d.steps.length} 步`,
  );

  // 自述**必须**和真实 steps 逐字对得上（自述是给生成物和检查用的，错了就是骗人）
  const mismatch = d.steps.findIndex(
    (x, i) => x.name !== MAIN.steps[i]!.name || x.from !== MAIN.steps[i]!.from || x.to !== MAIN.steps[i]!.to,
  );
  check("自述与真实 steps 逐字一致", mismatch < 0, mismatch < 0 ? "" : `第 ${mismatch} 步不一致`);

  // 相邻两步的语言必须接得上（类型层已经保证了，这里是运行期的回声 —— 生成物要按它走）
  let broke = "";
  for (let i = 0; i + 1 < MAIN.steps.length; i++) {
    if (MAIN.steps[i]!.to !== MAIN.steps[i + 1]!.from)
      broke = `${MAIN.steps[i]!.name} → ${MAIN.steps[i + 1]!.name}`;
  }
  check("相邻两步的语言接得上（运行期回声）", broke === "", broke);

  // N 条 entry：注册表里至少一条、名字不能撞（链接器按名字出产物）
  const names = PIPELINES.map((x) => x.name);
  check(
    "管线注册表：至少一条、名字唯一（为 N 条 entry 准备）",
    names.length >= 1 && new Set(names).size === names.length,
    names.join(","),
  );
  check("注册表里的管线就是跑的那条", PIPELINES[0] === MAIN && PIPELINE_STEPS.length === MAIN.steps.length);
}

// ───────────────────────── 跑管线 ─────────────────────────

const STEPS: Step[] = PIPELINE_STEPS;

/** 语言 id → 声明。管线里各步只记 id，这里翻回声明。 */
const DECL_OF: Readonly<Record<string, { rules: Record<string, Record<string, unknown>> }>> = {
  Lnum,
  Lsrc,
  L1,
  L2,
  L3,
  L4,
  L5,
  L6,
  L7,
};

const langDecl = (id: string) => {
  const d = DECL_OF[id];
  if (d === undefined) throw new Error(`管线里有语言 ${id}，但 run.ts 没 import 它`);
  return d;
};

/**
 * 每跑完一步，产物就该属于那门语言。第 0 个是入口语言。
 *
 * **从管线推**，不是手抄一份平行数组 —— 手抄的那种加一步就错位，而且错得很安静
 * （t11 加 algebraic-simplify 时就这么咬过一次）。
 */
const LANGS = [langDecl(PIPELINE_STEPS[0]!.from), ...PIPELINE_STEPS.map((st) => langDecl(st.to))];

function declaredTags(decl: { rules: Record<string, Record<string, unknown>> }): Set<string> {
  const out = new Set<string>();
  for (const prods of Object.values(decl.rules)) for (const tag of Object.keys(prods)) out.add(tag);
  return out;
}

const stages = LINKED.runStages(ast);

// 读入器只记"源码里怎么写"，分 Int/Float 是 refine-repr 干的 —— 细分之后才看得出区别
{
  const refined = LINKED.runStages(numericRaw).at(-1)!.ast;
  const kinds = ((refined as { body: { type: string }[] }).body ?? []).map((n) => n.type);
  check(
    "Int 与 Float 靠写法分得开（细分之后）",
    JSON.stringify(kinds) === JSON.stringify(["Int", "Float", "Int", "Float", "Bool"]),
    kinds.join(" "),
  );
}

// 单 pass / 单组的那套转储**去掉了**：链接产物（`__out__/<名字>.pipeline.js`，由 pnpm gen
// 生成）是唯一的生成物。以前两套并存 —— 而真在跑的是运行期现编的那份 —— 人会分不清
// 哪份算数。要看单个遍历器的样子，产物里每一段就是。
for (const [i, st] of stages.entries()) {
  dump(`${String(i + 1).padStart(2, "0")}-${st.lang}.json`, st.ast);
}

// 每一步之后，产物带的 tag 必须都在这门语言声明的集合里 —— 一个外来的都不许有
for (const [i, st] of stages.entries()) {
  const declared = declaredTags(LANGS[i]!);
  const used = tagsIn(st.ast);
  const foreign = [...used].filter((t) => !declared.has(t));
  check(`${i}. ${st.lang}：没有外来 tag`, foreign.length === 0, foreign.join(" "));
}

const final = stages[stages.length - 1]!.ast;
const finalJson = JSON.stringify(final);
const finalTags = tagsIn(final);

// 每一步只允许丢掉它该丢的 tag —— 不许悄悄丢别的
for (let i = 0; i < STEPS.length; i++) {
  const before = tagsIn(stages[i]!.ast);
  const after = tagsIn(stages[i + 1]!.ast);
  const stepName = STEPS[i]!.name;
  if (WILD_REMOVES.has(stepName)) continue; // 会删整棵子树的 pass，tag 随便消失
  const allowed = new Set(REMOVES[stepName] ?? []);
  const silently = [...before].filter((t) => !after.has(t) && !allowed.has(t));
  check(`${i + 1}. ${stepName}：没有悄悄丢 tag`, silently.length === 0, silently.join(" "));
}

// 糖走完了吗。
//
// 已经写了 pass 的那些必须全消干净 —— 这要是不过就是真 bug。
// 还没写 pass 的单列出来（PENDING_SUGAR），不假装绿，也不让整个套件因此红。
const leftover = [...finalTags].filter((t) => SUGAR.has(t)).sort();
const notDesugared = leftover.filter((t) => !PENDING_SUGAR.has(t));
check("已实现的 pass 把对应的糖消干净了", notDesugared.length === 0, notDesugared.join(" "));

// 第一步确实把 DefFun 变成了 DefVal + Lam
//
// 看的是**第一步之后**的产物，不是最终 AST —— 最后有全局 DCE，没人引用的顶层定义会被删掉，
// 在最终 AST 上找 `fact` 会找不到（这条以前是碰巧过的：那时候还没有全局 DCE）。
const afterDesugar = stages[STEPS.findIndex((x) => x.name === "desugar-def-fun") + 1]!.ast;
check(
  "DefFun → DefVal + Lam",
  defOf(afterDesugar, "fact")?.["type"] === "DefVal" &&
    ((defOf(afterDesugar, "fact")?.["value"] ?? {}) as { type?: string }).type === "Lam",
);

// when / unless / cond 真的被换成了 if
check("when / unless 变成 If", !finalJson.includes('"When"') && !finalJson.includes('"Unless"'));
// 注意：L7 里 Lam 的体裹了一层 BindFree，要多下一层
const classifyLam = (defOf(final, "classify")?.["value"] ?? {}) as Record<string, unknown>;
const classifyOut = ((classifyLam["body"] ?? {}) as Record<string, unknown>)["body"] as Record<
  string,
  unknown
>;
check(
  "cond 变成嵌套 If",
  !finalJson.includes('"Cond"') && classifyOut["type"] === "If" && classifyOut["cond"] !== undefined,
  JSON.stringify(classifyOut).slice(0, 80),
);

// 不动点：**去糖那一段**再跑一遍，一个字都不该变。
//
// 范围要卡准：优化 pass（const-prop / constant-fold / uncover-free / dce）不能算进来 ——
// uncoverFree 会再包一层 BindFree，那本来就该变。这里要验的是"去糖没漏"：哪个 pass
// 漏消了一种糖，再跑一遍就会多改一次。
const SUGAR_END = STEPS.findIndex((st) => st.name === "remove-one-armed-if");
// 起点从**语言**推，不按下标 0 —— 管线前面可能还有别的（比如 refine-repr: Lnum→Lsrc），
// 那些跑在已经去完糖的树上没意义。这里要的正是"从 Lsrc 那一段开始"。
const SUGAR_START = STEPS.findIndex((st) => st.from === "Lsrc");
const sugarSteps = STEPS.slice(SUGAR_START, SUGAR_END + 1);
const afterSugar = stages[SUGAR_END + 1]!.ast;
// **区间**：从 Lsrc 那一步（SUGAR_START）跑到 remove-one-armed-if。不是从 0 —— 从 0 的话
// 会把整条管线（含 Lnum→Lsrc 那一步）再跑一遍，喂进去的是已经去完糖的树。
const sugarAgain = runPipelineRange(afterSugar, SUGAR_START, SUGAR_END + 1) as never;
check("去糖段重跑不变（不动点）", JSON.stringify(sugarAgain) === JSON.stringify(afterSugar));

// 确定性：同一份源码跑两遍，整条链逐字节相同。
// 这条是在抓模块级的可变状态（比如临时名的全局计数器）—— 那种东西会让
// 同一份输入跑出不同的结果。
const run1 = LINKED.runStages(ast);
const run2 = LINKED.runStages(ast);
check(
  "同一份输入跑两遍结果相同（确定性）",
  JSON.stringify(run1.at(-1)!.ast) === JSON.stringify(run2.at(-1)!.ast),
);

// __meta__ 一路带过来了吗
check("输出节点还带着 __meta__", countMissingMeta(final) === 0, `缺 ${countMissingMeta(final)} 个`);

// ───────────────────────── 判定标准：跑起来，看值 ─────────────────────────

/** 一条程序 + 它该算出什么。这是整条链唯一的真 oracle。 */
const PROGRAMS: { name: string; src: string; want: unknown }[] = [
  { name: "常量", src: "1", want: 1 },
  { name: "字符串", src: '"hi"', want: "hi" },
  { name: "算术（n 元）", src: "(+ 1 2 3 4)", want: 10 },
  { name: "减法一元当取负", src: "(- 5)", want: -5 },
  { name: "乘除", src: "(* (/ 12 4) 3)", want: 9 },
  { name: "浮点", src: "(* 1.5 2)", want: 3 },
  { name: "比较链", src: "(< 1 2 3)", want: true },
  { name: "if", src: "(if (< 1 2) 10 20)", want: 10 },
  { name: "一臂 if 是 void", src: "(if #f 1)", want: undefined },
  { name: "一臂 if 有值", src: "(if #t 1)", want: 1 },
  { name: "when", src: "(when #t 42)", want: 42 },
  { name: "when 不成立还是 void", src: "(when #f 42)", want: undefined },
  { name: "unless", src: "(unless #f 42)", want: 42 },
  { name: "cond 命中第二支", src: '(cond [(< 3 2) "a"] [(= 1 1) "b"] [else "c"])', want: "b" },
  { name: "cond 走 else", src: '(cond [(< 3 2) "a"] [else "c"])', want: "c" },
  { name: "cond 没有 else 也不成立", src: "(cond [#f 1])", want: undefined },
  { name: "and", src: "(and #t #t #t)", want: true },
  { name: "and 空是 #t", src: "(and)", want: true },
  { name: "and 短路", src: "(and #f #t)", want: false },
  { name: "or", src: "(or #f #t)", want: true },
  { name: "or 全假", src: "(or #f #f)", want: false },
  // or 的最后一个操作数不会被当条件测 —— 所以它可以是任意类型
  { name: "or 落到最后一个（任意类型）", src: '(or #f #f "x")', want: "x" },
  { name: "or 空是 #f", src: "(or)", want: false },
  { name: "not", src: "(not #f)", want: true },
  { name: "begin 取最后一个", src: "(begin 1 2 3)", want: 3 },
  { name: "let", src: "(let ((x 1) (y 2)) (+ x y))", want: 3 },
  { name: "let 是并行的", src: "(let ((x 1)) (let ((x 2) (y x)) y))", want: 1 },
  { name: "let*", src: "(let* ((x 1) (y (+ x 1)) (z (* y 10))) z)", want: 20 },
  { name: "lambda 立刻调用", src: "((lambda (x) (* x x)) 5)", want: 25 },
  { name: "define f 形式", src: "(define double (lambda (x) (* x 2)))\n(double 21)", want: 42 },
  { name: "define 函数形式", src: "(define (cube x) (* x x x))\n(cube 3)", want: 27 },
  { name: "递归", src: "(define (fact n) (if (< n 2) 1 (* n (fact (- n 1)))))\n(fact 6)", want: 720 },
  {
    name: "letrec 互递归",
    src: "(define (ev? n) (letrec ((e? (lambda (k) (if (= k 0) #t (o? (- k 1))))) (o? (lambda (k) (if (= k 0) #f (e? (- k 1)))))) (e? n)))\n(ev? 10)",
    want: true,
  },
  { name: "闭包捕获", src: "(define (adder n) (lambda (x) (+ x n)))\n((adder 10) 5)", want: 15 },
  // 这条同时证明"死支被整棵丢掉了"：nope 是未绑定变量，只要它被求值就会报错
  { name: "折叠丢掉了死支", src: "(if #t 1 nope)", want: 1 },
  { name: "常量传播穿过变量", src: "(define k 5)\n(let ((x (+ k 1))) (* x 2))", want: 12 },
  { name: "常量传播 + 遮蔽", src: "(let ((x 1)) (let ((x 2)) (+ x 10)))", want: 12 },
  { name: "高阶", src: "(define (twice f x) (f (f x)))\n(twice (lambda (n) (* n 3)) 2)", want: 18 },
];

function compile(src: string): unknown {
  const prog = readProgram(parse(src, "prog.tli").forms, "prog.tli");
  return LINKED.runStages(prog).at(-1)!.ast;
}

let passed = 0;
for (const p of PROGRAMS) {
  let got: unknown;
  let err = "";
  try {
    got = runProgram(compile(p.src) as never);
  } catch (e) {
    err = (e as Error).message;
  }
  const ok = err === "" && got === p.want;
  if (ok) passed += 1;
  check(
    `跑得出值：${p.name}`,
    ok,
    err !== "" ? err : `期望 ${show(p.want as never)}，拿到 ${show(got as never)}`,
  );
}

// 运行期错误也得报，不能静默
const RUNTIME_BAD: { name: string; src: string }[] = [
  { name: "if 的条件不是 bool", src: "(if 1 2 3)" },
  { name: "未绑定的变量", src: "nope" },
  { name: "调用一个数字", src: "(1 2)" },
  { name: "参数个数不对", src: "((lambda (x) x) 1 2)" },
  // and / or 的操作数必须是 bool —— 展开成 if 之后，这条由解释器在运行期挡下来。
  // 报错信息指向的是**展开后**的 if，不是源写的 and。这正是后面"报错贯穿位置"要解决的。
  { name: "and 的操作数不是 bool", src: "(and 1 2)" },
  // 但**被当条件测**的那些必须是 bool
  { name: "or 的被测操作数不是 bool", src: '(or "x" #f)' },
];
for (const b of RUNTIME_BAD) {
  let threw = false;
  let msg = "";
  try {
    runProgram(compile(b.src) as never);
  } catch (e) {
    threw = true;
    msg = (e as Error).message;
  }
  check(`运行期报错：${b.name}`, threw, msg);
}

// ───────────────────────── 深输入（t27）─────────────────────────

{
  const deepLetSrc = (n: number): string => {
    let body = "1";
    for (let i = 0; i < n; i++) body = `(let ((x${i} ${i})) ${body})`;
    return `(define (t) ${body})\n(t)`;
  };

  // ① 够深的输入要跑得过去。
  //
  // **不钉死一个绝对值**：遍历器的容量取决于**运行时的原生栈大小**，而那个东西
  // 每个 runtime 都不一样 —— 实测 Bun 能过 2000 层、真 node v24 走到 ~800 层就溢出
  // （同一个 commit、同一份代码）。钉 2000 的话，本地用 Bun 跑是绿的、`pnpm e2e`
  // 在真 node 下红，而且红得莫名其妙。
  //
  // 所以：先**量出**这个 runtime 的容量（二分），再断言
  //   - 容量有一个合理下限（这里取 200）—— 防的是"哪天退化成几十层就炸"
  //   - 在**容量的一半**上确实跑得过去（留足余量，不钉在边缘）
  const depthOk = (n: number): boolean => {
    try {
      LINKED.runStages(readProgram(parse(deepLetSrc(n), "deep.tli").forms, "deep.tli"));
      return true;
    } catch {
      return false;
    }
  };
  let capacity = 0;
  for (let d = 64; d <= 8192; d *= 2) {
    if (depthOk(d)) capacity = d;
    else break;
  }
  check("跑得过 200 层（容量下限）", capacity >= 200, `这个 runtime 的容量测出来是 ${capacity} 层`);
  const safe = Math.max(64, Math.floor(capacity / 2));
  let ok = true;
  let detail = "";
  try {
    LINKED.runStages(readProgram(parse(deepLetSrc(safe), "deep.tli").forms, "deep.tli"));
  } catch (e) {
    ok = false;
    detail = (e as Error).constructor.name + ": " + (e as Error).message.slice(0, 60);
  }
  check(`深 ${safe} 的输入跑得过（容量 ${capacity} 的一半）`, ok, detail);

  // ② 远超容量的输入要**给出明确报错**，不是裸的 RangeError。
  let msg = "";
  let ctor = "";
  try {
    readProgram(parse(deepLetSrc(100000), "deep.tli").forms, "deep.tli");
  } catch (e) {
    ctor = (e as Error).constructor.name;
    msg = (e as Error).message;
  }
  check(
    "远超容量时给明确报错（不是 RangeError）",
    ctor === "SyntaxError_" && msg.includes("嵌套太深") && /deep\.tli:\d+:\d+/.test(msg),
    `${ctor}: ${msg.slice(0, 70)}`,
  );

  // ③ 遍历器**自己**的守卫也得验（上面那条是 reader 先崩的，走不到遍历器）。
  //    手工造深 AST 绕过 reader。带 __meta__，验位置真的能报出来。
  const deepAst = (n: number): unknown => {
    // 管线的第一门语言现在是 **Lnum** —— 手搭深 AST 时字面量得写成笼统的 Num
    let node: Record<string, unknown> = {
      type: "Num",
      value: 1,
      repr: "1",
      __meta__: { file: "deep-ast.tli", line: 1, col: 1 },
    };
    for (let i = 0; i < n; i++) {
      node = {
        type: "Let",
        __meta__: { file: "deep-ast.tli", line: i + 2, col: 3 },
        bindings: [
          {
            type: "Bind",
            __meta__: { file: "deep-ast.tli", line: i + 2, col: 4 },
            name: `x${i}`,
            value: {
              type: "Num",
              repr: String(i),
              __meta__: { file: "deep-ast.tli", line: i + 2, col: 9 },
              value: i,
            },
          },
        ],
        body: node,
      };
    }
    return { type: "Prog", defs: [], body: [node] };
  };
  let walkerMsg = "";
  let walkerCtor = "";
  try {
    runPipelinePrefix(deepAst(200000), 1);
  } catch (e) {
    walkerCtor = (e as Error).constructor.name;
    walkerMsg = (e as Error).message;
  }
  check(
    "遍历器溢出时给明确报错（带 __meta__ 的位置）",
    walkerCtor === "Error" && walkerMsg.includes("嵌套太深") && walkerMsg.includes("deep-ast.tli:"),
    `${walkerCtor}: ${walkerMsg.slice(0, 80)}`,
  );

  // ④ 没有 __meta__ 时降级成不带位置，不崩
  let noMetaMsg = "";
  let noMetaCtor = "";
  try {
    let node: Record<string, unknown> = { type: "Num", value: 1, repr: "1" };
    for (let i = 0; i < 200000; i++) {
      node = {
        type: "Let",
        bindings: [{ type: "Bind", name: `y${i}`, value: { type: "Num", value: i, repr: String(i) } }],
        body: node,
      };
    }
    runPipelinePrefix({ type: "Prog", defs: [], body: [node] }, 1);
  } catch (e) {
    noMetaCtor = (e as Error).constructor.name;
    noMetaMsg = (e as Error).message;
  }
  check(
    "没有 __meta__ 时降级（不崩）",
    noMetaCtor === "Error" && noMetaMsg.includes("没有位置信息"),
    `${noMetaCtor}: ${noMetaMsg.slice(0, 60)}`,
  );
}

// ───────────────────────── 常量传播 ─────────────────────────

{
  /**
   * 编译一段源码，取独立表达式的「类型 + 值」。
   *
   * 特意**不**比整串 JSON：框架会给每个节点贴上 __lang__ / __meta__，那是它该做的。
   * 断言只关心语义上的 type / value。
   */
  const lit = (src: string): string => {
    const tree = compile(src) as { body: { type?: string; value?: unknown }[] };
    const n = tree.body[0] ?? {};
    return `${n.type}:${JSON.stringify(n.value)}`;
  };

  // ① 已知常量的变量引用被换掉（换完之后 constantFold 会折平）
  check(
    "常量传播：let 绑定的常量代进去了",
    lit("(let ((x 5)) (+ x 1))") === "Int:6",
    lit("(let ((x 5)) (+ x 1))"),
  );
  check(
    "常量传播：顶层定义的字面量代进去了",
    lit("(define k 7)\n(+ k 1)") === "Int:8",
    lit("(define k 7)\n(+ k 1)"),
  );

  // ② 遮蔽：内层的值说了算
  check(
    "常量传播：遮蔽时用内层的值",
    lit("(let ((x 1)) (let ((x 2)) x))") === "Int:2",
    lit("(let ((x 1)) (let ((x 2)) x))"),
  );

  // ③ 推不出来的不能动：lambda 参数
  {
    const out = compile("(define (f x) (+ x 1))\n(f 1)") as { defs: { name: string; value?: unknown }[] };
    const lam = (out.defs.find((d) => d["name"] === "f")?.["value"] ?? {}) as Record<string, unknown>;
    const body = (lam["body"] as { body?: Record<string, unknown> } | undefined)?.body;
    const json = JSON.stringify(body);
    check("常量传播：lambda 参数推不出来，留着", json.includes('"Var"'), json.slice(0, 70));
  }

  // ④ 推不出来的不能动：letrec 的绑定互相可见
  {
    const out = compile("(letrec ((a (lambda () (b))) (b (lambda () 1))) (a))") as {
      body: { type?: string }[];
    };
    check(
      "常量传播：letrec 绑定不动（要不动点才能推）",
      out.body[0]?.["type"] === "Letrec",
      JSON.stringify(out.body[0]).slice(0, 60),
    );
  }

  // ⑤ 值不变：传播 + 折叠之后整棵树的求值结果必须一样
  check(
    "常量传播：折完的值还是对的",
    lit("(let ((x 3) (y 4)) (* x y))") === "Int:12",
    lit("(let ((x 3) (y 4)) (* x y))"),
  );
}

// ───────────────────────── 局部 DCE ─────────────────────────

{
  /** 编译一段源码，返回整棵树。 */
  const tree = (src: string): unknown => compile(`(define (__t) ${src})\n(__t)`);

  /** 把所有 let/letrec 的绑定名收出来（按出现顺序）。 */
  const bindNames = (node: unknown, out: string[] = []): string[] => {
    if (Array.isArray(node)) {
      for (const x of node) bindNames(x, out);
      return out;
    }
    if (node === null || typeof node !== "object") return out;
    const o = node as Record<string, unknown>;
    if ((o["type"] === "Let" || o["type"] === "Letrec") && Array.isArray(o["bindings"])) {
      for (const b of o["bindings"] as { name: string }[]) out.push(b.name);
    }
    for (const [k, v] of Object.entries(o)) if (k !== "__meta__") bindNames(v, out);
    return out;
  };

  check(
    "DCE：没人用的绑定被删掉",
    JSON.stringify(bindNames(tree("(let ((x (f 1)) (y (g 2))) y)"))) === '["y"]',
    JSON.stringify(bindNames(tree("(let ((x (f 1)) (y (g 2))) y)"))),
  );
  check(
    "DCE：用了的保留",
    JSON.stringify(bindNames(tree("(let ((x (f 1)) (y (g 2))) (+ x y))"))) === '["x","y"]',
    JSON.stringify(bindNames(tree("(let ((x (f 1)) (y (g 2))) (+ x y))"))),
  );
  check(
    "DCE：内层遮蔽 → 外层那份没人用，被删",
    JSON.stringify(bindNames(tree("(let ((x (f 1))) (let ((x (g 2))) x))"))) === '["x"]',
    JSON.stringify(bindNames(tree("(let ((x (f 1))) (let ((x (g 2))) x))"))),
  );
  check(
    "DCE：lambda 参数遮蔽 → 外层绑定没人用",
    JSON.stringify(bindNames(tree("(let ((x (f 1))) (lambda (x) x))"))) === "[]",
    JSON.stringify(bindNames(tree("(let ((x (f 1))) (lambda (x) x))"))),
  );
  check(
    "DCE：(let () body) 直接还体",
    bindNames(tree("(let () (f 5))")).length === 0,
    JSON.stringify(bindNames(tree("(let () (f 5))"))),
  );
  check(
    "DCE：letrec 不删（删它要不动点，留给全局 DCE）",
    JSON.stringify(bindNames(tree("(letrec ((a (lambda () (h))) (b (lambda () (i)))) a)"))) === '["a","b"]',
    JSON.stringify(bindNames(tree("(letrec ((a (lambda () (h))) (b (lambda () (i)))) a)"))),
  );
  // 遮蔽不能误删**外层**已有的引用
  check(
    "DCE：遮蔽不带走外层的引用",
    JSON.stringify(bindNames(tree("(begin (f 1) (let ((x (g 1))) x))"))) === '["x"]',
    JSON.stringify(bindNames(tree("(begin (f 1) (let ((x (g 1))) x))"))),
  );
}

// ───────────────────────── uncoverFree：自由变量 ─────────────────────────

{
  /** 取某个顶层函数的 lambda 上的自由变量清单。 */
  const freeOf = (name: string): string[] | undefined => {
    const lam = (defOf(final, name)?.["value"] ?? {}) as Record<string, unknown>;
    return (lam["body"] as { names?: string[] } | undefined)?.names;
  };

  // classify 只用参数 n，不引用任何外层名字 → 自由集是空的
  check(
    "自由变量：只用参数的函数是空的",
    JSON.stringify(freeOf("classify")) === "[]",
    JSON.stringify(freeOf("classify")),
  );

  // adder 的体里引用 n（它自己的参数）和自己的参数 x → 也是空的
  {
    const src = "(define (adder n) (lambda (x) (+ x n)))\n(adder 1)";
    const tree = compile(src) as { defs: { value?: unknown }[] };
    const outer = (tree.defs[0]?.value ?? {}) as Record<string, unknown>;
    const outerFree = (outer["body"] as { names?: string[] } | undefined)?.names ?? [];
    const innerLam = ((outer["body"] as { body?: unknown } | undefined)?.body ?? {}) as Record<
      string,
      unknown
    >;
    const innerFree = (innerLam["body"] as { names?: string[] } | undefined)?.names ?? [];
    check(
      "自由变量：外层 lambda 引用自己的参数 → 空",
      JSON.stringify(outerFree) === "[]",
      JSON.stringify(outerFree),
    );
    check(
      "自由变量：内层 lambda 有 n 自由（外层绑的，对它就是自由的）",
      JSON.stringify(innerFree) === '["n"]',
      JSON.stringify(innerFree),
    );
  }

  // 引用一个全局定义 → 进自由集
  {
    // 全局定义的值不能是字面量 —— 是的话 constProp 会把它代进去，就没有自由变量了。
    // 想验"引用全局"就得用一个推不出值的定义。
    const src = "(define g (f 7))\n(define (h) (+ g 1))\n(h)";
    const tree = compile(src) as { defs: Record<string, unknown>[] };
    const h = tree.defs.find((d) => d["name"] === "h")!;
    const lamH = (h["value"] ?? {}) as Record<string, unknown>;
    const free = (lamH["body"] as { names?: string[] } | undefined)?.names ?? [];
    check("自由变量：引用全局定义进自由集", JSON.stringify(free) === '["g"]', JSON.stringify(free));
  }

  // let 绑的名字不算自由
  {
    const src = "(define (k) (let ((y 1)) y))\n(k)";
    const tree = compile(src) as { defs: Record<string, unknown>[] };
    const k = tree.defs.find((d) => d["name"] === "k")!;
    const lamK = (k["value"] ?? {}) as Record<string, unknown>;
    const free = (lamK["body"] as { names?: string[] } | undefined)?.names ?? [];
    check("自由变量：let 绑的名字不算自由", JSON.stringify(free) === "[]", JSON.stringify(free));
  }

  // letrec 绑的名字不算自由，哪怕是互相递归
  {
    const src = "(define (w) (letrec ((a (lambda () (b))) (b (lambda () 1))) (a)))\n(w)";
    const tree = compile(src) as { defs: Record<string, unknown>[] };
    const w = tree.defs.find((d) => d["name"] === "w")!;
    const lamW = (w["value"] ?? {}) as Record<string, unknown>;
    const free = (lamW["body"] as { names?: string[] } | undefined)?.names ?? [];
    check("自由变量：letrec 互相引用不算自由", JSON.stringify(free) === "[]", JSON.stringify(free));
  }
}

// ───────────────────────── 常量折叠：结构上的断言 ─────────────────────────

{
  const lit = (src: string): { type?: string; value?: unknown } =>
    (compile(src) as { body: { type?: string; value?: unknown }[] }).body[0] ?? {};

  const int3 = lit("(+ 1 2)");
  check("折叠：全整数 → Int", int3.type === "Int" && int3.value === 3, JSON.stringify(int3));

  const float4 = lit("(+ 1.5 2.5)");
  check("折叠：沾浮点 → Float", float4.type === "Float" && float4.value === 4, JSON.stringify(float4));

  const nested = lit("(+ 1 2 (* 3 4))");
  check("折叠：自底向上一遍折干净", nested.type === "Int" && nested.value === 15, JSON.stringify(nested));

  const cmp = lit("(< 1 2 3)");
  check("折叠：链式比较", cmp.type === "Bool" && cmp.value === true, JSON.stringify(cmp));

  const voided = lit("(begin)");
  check("begin 规范化：(begin) → Void", voided.type === "Void", JSON.stringify(voided));

  const single = lit("(begin 7)");
  check("begin 规范化：(begin e) → e", single.type === "Int" && single.value === 7, JSON.stringify(single));

  // 折不动的不能动
  const kept = (compile("(define (f x) (* 2 x))\n(f 3)") as { defs: { value?: unknown }[] }).defs[0]?.value;
  const keptBody = (
    ((kept as { body?: unknown })?.body ?? {}) as { body?: { type?: string; args?: { type?: string }[] } }
  ).body as { type?: string; args?: { type?: string }[] };
  check(
    "折叠：带变量的 Prim 原样留着",
    keptBody.type === "Prim" && keptBody.args?.some((a) => a.type === "Var") === true,
    JSON.stringify(keptBody).slice(0, 70),
  );

  // 整棵树上不该留下"全字面量"的 Prim —— 那说明漏折了
  const allLiteral = (node: unknown): number => {
    if (Array.isArray(node)) return node.reduce<number>((n, x) => n + allLiteral(x), 0);
    if (node === null || typeof node !== "object") return 0;
    const o = node as Record<string, unknown>;
    let n = 0;
    if (o["type"] === "Prim") {
      const args = (o["args"] ?? []) as { type?: string }[];
      const LIT = new Set(["Int", "Float", "Bool", "Str"]);
      if (args.length > 0 && args.every((a) => LIT.has(a.type ?? ""))) n += 1;
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === "__meta__") continue;
      n += allLiteral(v);
    }
    return n;
  };
  const leftoverFolds = allLiteral(final);
  check("折叠：整棵树上没有漏折的字面量 Prim", leftoverFolds === 0, `还剩 ${leftoverFolds} 个`);
}

// ───────────────────────── 逐 pass 兜底（t31 / t38）─────────────────────────
//
// 融合砍掉了（t38）：16 门只融成 2 组、收益 1.10×，却占了 codegen 一半的行数。
// 留下的是**逐 pass 兜底** —— 它跟融合无关，是"递归遍历器深输入会爆栈"的解法：
// 常态走递归（快），哪一步溢出就**只把那一步**换成蹦床版重跑。

const SAFE = compileStepsWithFallback(STEPS);

/** 同一份源码，兜底版跑和"老老实实逐 pass 跑"结果必须逐字节相同。 */
function safeEqualsReference(src: string, label: string): void {
  const ast1 = readProgram(parse(src, "fuse.tli").forms, "fuse.tli");
  const ast2 = readProgram(parse(src, "fuse.tli").forms, "fuse.tli");
  const a = JSON.stringify(LINKED.runStages(ast1).at(-1)!.ast);
  const b = JSON.stringify(runSafe(ast2, SAFE));
  let where = "";
  if (a !== b) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    where = `第 ${i} 字节：参考 ${a.slice(i, i + 50)} / 兜底 ${b.slice(i, i + 50)}`;
  }
  check(`逐字节相同（兜底版 vs 逐 pass）：${label}`, a === b, where);
}

safeEqualsReference(SOURCE, "demo 程序");
for (const pr of PROGRAMS) safeEqualsReference(pr.src, pr.name);

// ───────────────────────── 链接产物（t33）─────────────────────────
//
// `pnpm gen` 把每条管线编成 `e2e/__out__/<名字>.pipeline.js` —— **一份自包含的 ES 模块**，
// 里面是真正的函数（不是拿字符串再 `new Function` 编一遍）。
//
// 这里钉住的是最要紧的那条性质：**产物和在进程里现编出来的结果完全一致**。
// 不一致的话，"走编译"就是在拿运气赌。
{
  const srcs: [string, string][] = [
    ["demo", SOURCE],
    ...PROGRAMS.slice(0, 12).map((x) => [x.name, x.src] as [string, string]),
  ];

  let mismatch = "";
  for (const [label, src] of srcs) {
    const mk = (): unknown => readProgram(parse(src, "linked.tli").forms, "linked.tli");
    const inProc = JSON.stringify(runSteps(mk(), STEPS).at(-1)!.ast);
    const linked = JSON.stringify(LINKED.runStages(mk()).at(-1)!.ast);
    if (inProc !== linked) mismatch = `${label}：逐层不一致`;
    const inProcSafe = JSON.stringify(runSafe(mk(), SAFE));
    const linkedSafe = JSON.stringify(LINKED.run(mk()));
    if (inProcSafe !== linkedSafe) mismatch = `${label}：兜底版与产物不一致`;
    if (mismatch !== "") break;
  }
  check(`链接产物与在进程里跑逐字节一致（${srcs.length} 个程序）`, mismatch === "", mismatch);

  // 自述也从产物里出得来（生成物要能自述：名字、每步语言）
  check(
    "产物里带着管线自述",
    LINKED.steps.length === MAIN.steps.length &&
      LINKED.steps.every((x, i) => x.name === MAIN.steps[i]!.name && x.to === MAIN.steps[i]!.to),
    `${LINKED.steps.length} 步`,
  );

  // 产物也能自己兜底（兜底数组是产物自己的，不是外面传进去的）
  check(
    "产物自带兜底计数",
    Array.isArray(LINKED.fallbacks) && LINKED.fallbacks.length === 0,
    `已触发 ${LINKED.fallbacks.length} 次`,
  );

  // ── 产物是不是最新的（t34 的过期检查，只读版）──
  //
  // `pnpm gen:check` 用"重新生成 + git diff"盯这件事，但它是独立脚本，`pnpm e2e` 不会发现
  // 产物过期。这里换成**只读**的比法：现算一份期望源码，跟盘上那份逐字节比。
  //
  // 为什么在乎：产物提交进仓库 = 跑的是旧产物。改了东西忘了 `pnpm gen`，最坏的情况是
  // "改的东西看起来没生效"，人会去查别处的 bug，而不是查忘了重新生成。
  //
  // 什么改动**需要**重跑（产物文本会变）：语言定义（字段布局决定 walker 源码）、
  // 管线结构/名字/from-to、融合分组、生成器自己。
  // 什么改动**不需要**：pass handler 的**函数体** —— 产物不抄 handler，它是
  // `rulesOf(i)` 在运行期从 `pipeline.ts` 读的（单一真相）。所以"改了 pass 忘了 gen"
  // 在这里本来就不是问题。
  for (const p of PIPELINES) {
    const want = linkPipeline(p);
    let got = "";
    try {
      got = readFileSync(new URL(`./__out__/${want.fileName}`, import.meta.url), "utf8");
    } catch {
      /* 文件不在 = 过期 */
    }
    check(`产物 ${want.fileName} 与源码同步（忘了 pnpm gen 的话这里红）`, got === want.source);
  }

  // ── 最要紧的一条：**生产路径上不再有 `new Function`** ──
  //
  // 在**子进程**里验：把 `Function` 打上桩（计数），然后从头 import 整个模块图 +
  // 跑管线。这样连**装载期**的 `new Function` 也数得进去 —— 在本进程里做不到，
  // 因为静态 import 在打桩之前就发生了。
  //
  // 为什么在乎：`new Function` 出来的代码在调用栈里是 `<anonymous>:27:15`，看不出是哪一行。
  // 这轮调深度溢出时就是被这个坑住的；产物是真文件之后，栈里直接是 `main.pipeline.js:461`。
  {
    const url = new URL("./", import.meta.url).href;
    const probe = `
      let calls = 0;
      const RealFunction = Function;
      globalThis.Function = function (...a) { calls += 1; return new RealFunction(...a); };
      const { parse } = await import(${JSON.stringify(url + "s-expr.ts")});
      const { readProgram } = await import(${JSON.stringify(url + "read.ts")});
      await import(${JSON.stringify(url + "pipeline.ts")});
      const linked = await import(${JSON.stringify(url + "__out__/main.pipeline.js")});
      const mk = () => readProgram(parse(process.env.PROBE_SRC, "probe.tli").forms, "probe.tli");
      linked.runStages(mk());
      linked.run(mk());
      linked.runPrefix(mk(), 3);
      globalThis.Function = RealFunction;
      console.log(calls === 0 ? "OK" : "CALLS=" + calls);
    `;
    let out = "";
    let err = "";
    try {
      out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
        env: { ...process.env, PROBE_SRC: SOURCE },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? "");
      err = String((e as { stderr?: string }).stderr ?? "").slice(0, 140);
    }
    check(
      "生产路径上没有 new Function（子进程里把 Function 打了桩数的）",
      out.trim() === "OK",
      out.trim() === "OK" ? "" : `拿到 ${JSON.stringify(out.trim())} ${err}`,
    );
  }
}

// ───────────────────────── 蹦床：identity 那条路不再占原生栈（t18 / t31 / t38）─────────────────────────

{
  /** 深链。kind = "call"（没有 pass 认领 → 纯 identity）。 */
  const deepCall = (n: number): unknown => {
    let node: Record<string, unknown> = {
      type: "Num",
      value: 1,
      repr: "1",
      __meta__: { file: "deep.tli", line: 1, col: 1 },
    };
    for (let i = 0; i < n; i++) {
      node = {
        type: "Call",
        __meta__: { file: "deep.tli", line: i + 2, col: 1 },
        fn: { type: "Var", name: "f" },
        args: [node],
      };
    }
    return { type: "Prog", defs: [], body: [node] };
  };

  // ① **默认路径**（逐 pass 兜底）跑得过很深的 identity 链 —— 这才是生产形态：
  //    用户不需要知道有蹦床这回事
  SAFE.resetFallbacks();
  let safeOk = true;
  let safeDetail = "";
  try {
    runSafe(deepCall(100000), SAFE);
  } catch (e) {
    safeOk = false;
    safeDetail = (e as Error).message.slice(0, 70);
  }
  check("深 100000 的 Call 链：**默认路径**（逐 pass 兜底）也跑得过", safeOk, safeDetail);

  // ④ 兜底**真的触发了**，而且可观察（不然上面那条可能只是"碰巧没溢出"）
  check(
    "④ 兜底真的触发了（可观察）",
    SAFE.fallbacks.length > 0,
    `触发 ${SAFE.fallbacks.length} 次：${SAFE.fallbacks.join(" | ")}`,
  );

  // ④b 是**逐 pass**重跑：同一门最多重跑一次。
  //     要是写成了"整条管线重来"，溢出的那几门会被重跑很多次 —— 这条能区分两者。
  {
    const seen = new Set<string>();
    let twice = "";
    for (const name of SAFE.fallbacks) {
      if (seen.has(name)) twice = name;
      seen.add(name);
    }
    check(
      "④ 只重跑了溢出的那一门（每门最多一次，不是整条管线重来）",
      twice === "",
      twice === "" ? `${seen.size}/${STEPS.length} 门触发` : `${twice} 被重跑了两次`,
    );
  }

  // ④c 对照：浅输入**不该**触发兜底（不然就是"永远走慢的那条"）
  SAFE.resetFallbacks();
  runSafe(readProgram(parse("(+ 1 2)", "shallow.tli").forms, "shallow.tli"), SAFE);
  check("④ 对照：浅输入不触发兜底", SAFE.fallbacks.length === 0, SAFE.fallbacks.join(","));

  // ② 同一棵树走不融合的递归遍历器 —— 差两个数量级，这就是蹦床买到的
  let recursiveOk = true;
  try {
    runSteps(deepCall(100000), STEPS);
  } catch {
    recursiveOk = false;
  }
  check("同一棵树：递归遍历器跑不过（对照）", !recursiveOk);

  // ③ handler 里调 rec 仍会嵌套原生栈 —— 这条限制还在，别假装没了
  const deepLet = (n: number): unknown => {
    let node: Record<string, unknown> = {
      type: "Num",
      value: 1,
      repr: "1",
      __meta__: { file: "deep.tli", line: 1, col: 1 },
    };
    for (let i = 0; i < n; i++) {
      node = {
        type: "Let",
        __meta__: { file: "deep.tli", line: i + 2, col: 1 },
        bindings: [{ type: "Bind", name: `x${i}`, value: { type: "Num", value: i, repr: String(i) } }],
        body: node,
      };
    }
    return { type: "Prog", defs: [], body: [node] };
  };
  let letMsg = "";
  try {
    runSafe(deepLet(500000), SAFE);
  } catch (e) {
    letMsg = (e as Error).message;
  }
  check(
    "但 handler 链仍受限（constProp 每层都调 rec）—— 给明确报错",
    letMsg.includes("嵌套太深"),
    letMsg.slice(0, 80) || "（居然跑过去了）",
  );
}

// ───────────────────────── 重写规则引擎（t11）─────────────────────────

rewriteChecks(check);

// ───────────────────────── 语法糖 / 规范形 pass 的单测（t35）─────────────────────────
//
// 8 门 pass 以前只有"整条管线跑完值对"的间接覆盖 —— 管线一绿，某门悄悄少做一半也看不出来。

sugarChecks(check);

// 环境类 pass（const-prop / uncover-free）—— 「每门 pass 都有专属单测」的最后两门
passChecks(check);

// ───────────────────────── 代数规则（t12）─────────────────────────

algebraicChecks(check);

// 代数化简**真的在管线里生效**吗 —— 不是只看单测（单测跑的是裸树，没有 __lang__/__meta__）。
{
  const out = JSON.stringify(compile("(let ((a 3)) (+ (* a 2) (+ 1 0)))"));
  // `(* a 2)` 该变成 `(+ a a)`，`(+ 1 0)` 该变成 `1` —— 所以最终 AST 里不该再有 `"*"`.
  const noMul = !out.includes('"*"');
  check("代数化简在管线里生效：* 2 被削掉、恒等元被消掉", noMul, out.slice(0, 160));

  // 展平 + 二值化：参数是**未知值**（常量折叠动不了），才看得出形状。
  // (define (f a b c) (+ c a b)) → AC 展平排序成 (+ a b c) → normalize-prim-arity 二值化成 (+ (+ a b) c)
  // 用**中间阶段**的产物，不是最终 AST：最后有全局 DCE，没人引用的定义会被删掉。
  const arityStage = stages[STEPS.findIndex((x) => x.name === "normalize-prim-arity") + 1]!;
  const flat = JSON.stringify(arityStage.ast);
  // 3 个操作数 → 左嵌套 2 个二元素 + 节点。没有 n 元 + 了。
  const plusNodes = (flat.match(/"op":"\+"/g) ?? []).length;
  const nAryPlus = /"op":"\+","args":\[\{[^\]]*\},\{[^\]]*\},\{/.test(flat);
  check(
    "展平后由 normalize-prim-arity 二值化（2 个二元素 +，没有 n 元 +）",
    plusNodes === 2 && !nAryPlus,
    `+ 节点 ${plusNodes} 个，还有 n 元 +？${nAryPlus}：${flat.slice(0, 150)}`,
  );
}

// ───────────────────────── 不动点驱动器（t13）─────────────────────────

fixpointChecks(check);

// ───────────────────────── CFG + 图遍历模型（t16）─────────────────────────

cfgChecks(check);

// ───────────────────────── CFG 上的 pass（t17）─────────────────────────

cfgPassChecks(check);

// ───────────────────────── 数据流驱动器（t16c）─────────────────────────

dataflowChecks(check);

// ───────────────────────── 类型细化（t15）─────────────────────────

refineChecks(check);

// ───────────────────────── G2 首批 pass（t14）─────────────────────────

g2Checks(check);

// ───────────────────────── link 期校验（t19）─────────────────────────

{
  const problems = checkLinks({ steps: PIPELINE_STEPS });
  check(
    "link 期校验：pass 都被引用、语言 id 不冲突、名字和体一致",
    problems.length === 0,
    problems.map((p) => `[${p.kind}] ${p.what}: ${p.detail}`).join("\n      "),
  );

  // 反例：检查**真的会报**吗。只验"当前仓库干净"的话，检查哪天坏了也没人知道。
  for (const c of LINK_CASES) {
    const got = runLinkCase(c);
    const kinds = new Set(got.map((p) => p.kind));
    const ok = got.length >= c.wantCount && c.want.every((k) => kinds.has(k));
    check(
      `link 反例：${c.label}`,
      ok,
      `期望至少 ${c.wantCount} 个（含 ${c.want.join("/") || "无"}），拿到 ${got.length} 个：` +
        got.map((p) => p.kind).join("/"),
    );
  }
}

// ───────────────────────── REPL 的语义（一次会话 = 一串程序）─────────────────────────
//
// 这条是用户报出来的：REPL 里 `(define ...)` 只能在第一句写，之后写就报
// "define 出现在其它表达式之后"。根因是当时把整个会话**攒成一个程序**再从头重跑 ——
// 而 `Program` 这个形状要求"定义在前"。
//
// 真 REPL 不是那样：每次输入是一个**独立的程序**、共用一个环境。
{
  const env = new Env();
  const out: string[] = [];
  const cap = (s: string): void => {
    out.push(s.replace(/\u001b\[[0-9;]*m/g, ""));
  };
  const origLog = console.log;
  console.log = cap as never;

  let ok = true;
  try {
    // ① 先用一句表达式
    ok = ok && runSource("(+ 1 2)", "<repl>", { env });
    // ② **在用过之后再 define**（这就是用户那条）
    ok = ok && runSource("(define (adder n) (lambda (x) (+ x n)))", "<repl>", { env });
    // ③ 用它
    ok = ok && runSource("((adder 3) 4)", "<repl>", { env });
    // ④ 前面定义的还在（环境是跨句的）
    ok = ok && runSource("(define k 5)", "<repl>", { env });
    ok = ok && runSource("(* k 8)", "<repl>", { env });
  } finally {
    console.log = origLog;
  }

  const values = out.filter((l) => l.startsWith("值")).join(" ");
  check(
    "REPL：define 可以在用过之后写（一次会话 = 一串程序）",
    ok && values === "值 3 值 #<void> 值 7 值 #<void> 值 40",
    values,
  );

  // 对照：把同样几行**当成一个程序**（一个文件）就该报"定义要放在前面" ——
  // 那条规则是语言的一部分，不是被顺手删掉了
  let oneProgram = "";
  try {
    readProgram(parse("(+ 1 2)\n(define k 1)", "f.tli").forms, "f.tli");
  } catch (e) {
    oneProgram = (e as Error).message;
  }
  check(
    "对照：一个文件里定义仍必须在前面（那条规则没被删掉）",
    oneProgram.includes("定义要放在前面"),
    oneProgram.slice(0, 50),
  );
}

// ───────────────────────── README 里的例子（t23）─────────────────────────

{
  const { total, failures } = checkReadme();
  check(
    `README.md 里的例子都能跑（${total} 条）`,
    failures.length === 0,
    failures
      .slice(0, 3)
      .map(
        (f) =>
          `第 ${f.case.line} 行 ${f.case.input.replace(/\n/g, " ")} → 期望 ${f.case.want}，拿到 ${f.got}`,
      )
      .join("\n      "),
  );
}

// ───────────────────────── 机制单测（t9：extra formals / extra returns）─────────────────────────

g1Checks(check);

// 负例：reader 必须报错，不静默
const bad: [string, string][] = [
  ["括号没闭合", "(if #t 1"],
  ["cond 分支元素个数不对", "(cond [(< 1 2)])"],
  ["define 出现在体之后", "1 (define x 2)"],
  ["绑定不是两个元素", "(let ((x)) x)"],
];
for (const [name, src] of bad) {
  let threw = false;
  let msg = "";
  try {
    readProgram(parse(src, "bad.tli").forms, "bad.tli");
  } catch (e) {
    threw = e instanceof SyntaxError_;
    msg = (e as Error).message;
  }
  check(`坏输入会报错：${name}`, threw, msg);
}

// ───────────────────────── 收尾 ─────────────────────────

console.log("");
console.log(rule);
console.log(color.bold("断言"));
for (const r of results) {
  const mark = r.ok ? color.green("✓") : color.red("✗");
  const detail = r.ok ? "" : `  ${color.red(`→ ${r.detail}`)}`;
  console.log(`  ${mark} ${r.name}${detail}`);
}
const failed = results.filter((r) => !r.ok).length;
const summary =
  failed === 0
    ? color.green(`${results.length} 通过`)
    : `${color.green(`${results.length - failed} 通过`)} / ${color.red(`${failed} 失败`)}`;
console.log(`\n${summary}`);

console.log(`${color.dim("管线")} ${STEPS.length} 门 pass，逐 pass 跑（融合已砍，见 t38）`);

if (failed > 0) process.exitCode = 1;
