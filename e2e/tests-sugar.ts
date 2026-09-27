/**
 * t35：8 门语法糖 / 规范形 pass 的**专属单测**。
 *
 * ── 为什么非要有这个文件
 *
 * 这 8 门 pass 以前只有**间接覆盖**：整条管线跑完、最终值对了，就算它们对了。问题是
 * **管线一绿，某门悄悄少做一半也看不出来** —— 少展开一层 `let*`、`cond` 只串了前两个
 * 分支、`or` 忘了造临时变量……这些错全都会被后面的 pass 顺手吃掉，或者刚好在某个
 * fixture 上值还对。间接覆盖保护的是"最终值"，不是"这门 pass 干了它该干的事"。
 *
 * ── 这个文件的规矩：每门 pass 写清**通过条件**
 *
 * 不是"看起来对"，是"输出里必须有什么、必须没有什么"。三种断言：
 *
 *   ① 形状（`shape`）—— 这门的**核心不变量**。比如 `remove-and-or-not` 之后整棵树里
 *      不能再有 `And` / `Or` / `Not` 任何一个 tag（**不存在性**断言，比"某处变成了 If"
 *      强得多：后者允许"改了一个、漏了另一个"）。
 *   ② 语义（`sem`）—— 展开前后**真跑一遍**，值必须一样。这条防的是"形状对但意思变了"
 *      （`or` 求值两次、`let*` 绑定顺序错、`cond` 分支顺序反了 —— 这些形状上都看不出来）。
 *   ③ 边界 —— 空 / 一元 / 二元 / 三元，以及**不该动的东西**（`(< 1 2 3)` 是链式比较，
 *      `(- 5)` 是一元取负，都不是"参数少了一个"）。
 *
 * ②③ 是最有价值的两类：**只测"该变的变了"，测不出"不该变的也变了"。**
 *
 * ── 输入是真实源码，不是手搭的节点
 *
 * 每个用例从 s-表达式读进来，**跑前缀**到那门 pass 的输入语言，再跑那门 pass。这样测的
 * 是"用户写的语法糖真的被去掉了"，而不是"我手搭的这个对象被改成了那个对象"。
 * （手搭节点的话，语言定义改了这里不会红 —— 那正是单测最该红的地方。）
 */

import { parse } from "./s-expr.ts";
import { readProgram } from "./read.ts";
import { runPipelinePrefix, runPipelineRange, linkedSteps } from "./linked.ts";
import { prettyInline } from "./pretty.ts";
import { runProgram } from "./eval.ts";

import {
  after,
  bodyAt,
  countTag,
  countVar,
  idxOf,
  one,
  tagsIn,
  to,
  valueIs,
  type Check,
  type Node,
} from "./testkit.ts";

export type { Check };

// ───────────────────────── ① desugar-def-fun（Lsrc → L1）─────────────────────────

function desugarDefFunChecks(check: Check): void {
  // 通过条件：输出里**没有** DefFun，只有 DefVal 包着 Lam；参数个数和名字原样。
  const out = after("(define (f x y) x)", "desugar-def-fun");
  check(
    "① desugar-def-fun：`(define (f x y) x)` → 没有 DefFun、只有 DefVal + Lam",
    !tagsIn(out).has("DefFun") && tagsIn(out).has("DefVal") && tagsIn(out).has("Lam"),
    one(out),
  );
  const def = ((out as Node)["defs"] as Node[])[0]!;
  const lam = def["value"] as Node;
  check(
    "① desugar-def-fun：名字、参数个数、参数名都原样搬过去",
    def["type"] === "DefVal" && def["name"] === "f" && (lam["params"] as Node[]).length === 2,
    one(out),
  );
  // 边界：零参数
  const zero = after("(define (g) 1)", "desugar-def-fun");
  const g = (((zero as Node)["defs"] as Node[])[0]!["value"] as Node)["params"] as Node[];
  check("① desugar-def-fun：零参数 `(define (g) 1)` → Lam 的 params 是空数组", g.length === 0, one(zero));
  // 边界：`(define f e)` 这种值定义**不该被碰**
  const val = after("(define x 5)", "desugar-def-fun");
  check(
    "① desugar-def-fun：值定义 `(define x 5)` 原样（不该被包成 Lam）",
    !tagsIn(val).has("Lam") && (((val as Node)["defs"] as Node[])[0]!["value"] as Node)["type"] === "Int",
    one(val),
  );
  // 语义：函数定义之后能调用（值必须一样）
  valueIs(
    check,
    "① desugar-def-fun：`(define (f x) (+ x 1)) (f 4)` 的值是 5",
    "(define (f x) (+ x 1))\n(f 4)",
    5,
  );
}

// ───────────────────────── ② remove-when-unless（L1 → L2）─────────────────────────

function removeWhenUnlessChecks(check: Check): void {
  // 通过条件：When / Unless 一个都不剩，且 then / alt 的位置**没反**
  const w = after("(when c (f 1))", "remove-when-unless");
  const wb = bodyAt(w) as Node;
  check(
    "② remove-when-unless：`(when c e)` → If，e 在 **then**、Void 在 alt",
    !tagsIn(w).has("When") &&
      wb["type"] === "If" &&
      (wb["then"] as Node)["type"] === "Call" &&
      (wb["alt"] as Node)["type"] === "Void",
    one(w),
  );
  const u = after("(unless c (f 1))", "remove-when-unless");
  const ub = bodyAt(u) as Node;
  check(
    "② remove-when-unless：`(unless c e)` → If，e 在 **alt**、Void 在 then（位置不能反）",
    !tagsIn(u).has("Unless") &&
      ub["type"] === "If" &&
      (ub["then"] as Node)["type"] === "Void" &&
      (ub["alt"] as Node)["type"] === "Call",
    one(u),
  );
  // 条件原样搬过去（不是被丢掉、也不是被求反）
  check(
    "② remove-when-unless：条件原样搬到 cond（没有悄悄取反）",
    (wb["cond"] as Node)["name"] === "c",
    one(w),
  );
  // 语义
  valueIs(check, "② remove-when-unless：(when #t 1) 的值是 1", "(when #t 1)", 1);
  valueIs(check, "② remove-when-unless：(when #f 1) 的值是 Void（undefined）", "(when #f 1)", undefined);
  valueIs(check, "② remove-when-unless：(unless #f 1) 的值是 1", "(unless #f 1)", 1);
  valueIs(check, "② remove-when-unless：(unless #t 1) 的值是 Void", "(unless #t 1)", undefined);
}

// ───────────────────────── ③ remove-cond（L2 → L3）─────────────────────────

function removeCondChecks(check: Check): void {
  // 通过条件：没有 Cond / Clause，分支**从后往前**右嵌套，顺序不能反。
  // 注意：`else` **不是** clause（是 `n.else`），所以"一个 clause + else"出来是**单个** If。
  const oneClause = after("(cond [(< x 1) 2] [else 3])", "remove-cond");
  const t = bodyAt(oneClause) as Node;
  check(
    "③ remove-cond：一个 clause + else → 单个 If（else 不是 clause，不白包一层）",
    !tagsIn(oneClause).has("Cond") &&
      !tagsIn(oneClause).has("Clause") &&
      t["type"] === "If" &&
      (t["alt"] as Node)["type"] === "Int" &&
      (t["alt"] as Node)["value"] === 3,
    one(oneClause),
  );
  const twoClauses = after("(cond [(< x 1) 2] [(< x 5) 4] [else 3])", "remove-cond");
  check("③ remove-cond：两个 clause + else → 两层嵌套 If", countTag(twoClauses, "If") === 2, one(twoClauses));
  // 三分支：顺序是 1 → 2 → 3，一层套一层
  const three = after("(cond [(< x 1) 2] [(< x 5) 4] [else 3])", "remove-cond");
  const first = bodyAt(three) as Node;
  const second = first["alt"] as Node;
  check(
    "③ remove-cond：三分支的顺序是 1 → 2 → 3（右嵌套，不是反的）",
    countTag(three, "If") === 2 &&
      (first["then"] as Node)["value"] === 2 &&
      (second["then"] as Node)["value"] === 4 &&
      (second["alt"] as Node)["value"] === 3,
    one(three),
  );
  // 边界：没有 else → 最里层补 Void
  const noelse = after("(cond [(< x 1) 2])", "remove-cond");
  const nb = bodyAt(noelse) as Node;
  check("③ remove-cond：没有 else → 最里层 alt 是 Void", (nb["alt"] as Node)["type"] === "Void", one(noelse));
  // 边界：只有 else → 塌成那一个表达式
  const onlyElse = after("(cond [else 9])", "remove-cond");
  check(
    "③ remove-cond：只有 else → 直接塌成 9（没有 If）",
    countTag(onlyElse, "If") === 0 && (bodyAt(onlyElse) as Node)["value"] === 9,
    one(onlyElse),
  );
  // 边界：空 cond —— 这个语言的 Cond 至少要有一个 clause，读的时候就该报
  let emptyErr = "";
  try {
    to("(cond)", idxOf("remove-cond"));
  } catch (e) {
    emptyErr = String((e as Error).message);
  }
  check(
    "③ remove-cond：`(cond)` 空 cond 在读的阶段就报错（不是静默变成 Void）",
    emptyErr !== "",
    emptyErr.slice(0, 90),
  );
  // 语义：分支选择不能反
  valueIs(check, "③ remove-cond：走第一支 → 10", "(cond [(< 1 2) 10] [else 20])", 10);
  valueIs(check, "③ remove-cond：走 else → 20", "(cond [(< 2 1) 10] [else 20])", 20);
  valueIs(check, "③ remove-cond：没有 else 且全不中 → Void", "(cond [(< 2 1) 10])", undefined);
  valueIs(
    check,
    "③ remove-cond：中间那支 → 40（分支顺序不能反）",
    "(cond [(< 9 1) 10] [(< 1 9) 40] [else 20])",
    40,
  );
}

// ───────────────────────── ④ remove-and-or-not（L3 → L4）─────────────────────────

function removeAndOrNotChecks(check: Check): void {
  // 通过条件：And / Or / Not **一个都不剩**（不存在性断言 —— 比"某处变成 If"强）
  const ors = after("(or a b c)", "remove-and-or-not");
  check(
    "④ remove-and-or-not：`(or a b c)` 之后树里没有 And/Or/Not",
    !tagsIn(ors).has("And") && !tagsIn(ors).has("Or") && !tagsIn(ors).has("Not"),
    one(ors),
  );
  // or 要造临时变量（不然 a 被求值两次）
  check(
    "④ remove-and-or-not：`(or a b)` 造了临时名字 `$or…` 绑住第一个操作数",
    one(ors).includes("$or"),
    one(ors),
  );
  // 边界：恒等元
  check(
    "④ remove-and-or-not：`(and)` → #t",
    (bodyAt(after("(and)", "remove-and-or-not")) as Node)["value"] === true,
  );
  check(
    "④ remove-and-or-not：`(or)` → #f",
    (bodyAt(after("(or)", "remove-and-or-not")) as Node)["value"] === false,
  );
  // 边界：一元 or → 直接是那个表达式（不造临时变量）
  const or1 = after("(or a)", "remove-and-or-not");
  check(
    "④ remove-and-or-not：`(or a)` → 就是 a（没造临时变量）",
    (bodyAt(or1) as Node)["type"] === "Var" && !one(or1).includes("$or"),
    one(or1),
  );
  // 边界：一元 and → 也是那个表达式
  const and1 = after("(and a)", "remove-and-or-not");
  check("④ remove-and-or-not：`(and a)` → 就是 a", (bodyAt(and1) as Node)["type"] === "Var", one(and1));
  // not → if a #f #t
  const not = after("(not a)", "remove-and-or-not");
  const nb = bodyAt(not) as Node;
  check(
    "④ remove-and-or-not：`(not a)` → `(if a #f #t)`（两支不能反）",
    nb["type"] === "If" && (nb["then"] as Node)["value"] === false && (nb["alt"] as Node)["value"] === true,
    one(not),
  );
  // 临时名字每次 run 从 0 开始（计数器在 extra formal 里，不是模块级）——
  // 跑两次同一个输入，输出必须**逐字节一样**，否则整条链不确定。
  const a1 = JSON.stringify(after("(or a b)", "remove-and-or-not"));
  const a2 = JSON.stringify(after("(or a b)", "remove-and-or-not"));
  check(
    "④ remove-and-or-not：同一个输入跑两次，临时名字一样（计数器不在模块级）",
    a1 === a2,
    a1.slice(0, 120),
  );
  // 语义
  // **这个语言的 `if` 条件必须是 bool** —— 所以 `and` / `or` 的操作数也必须是 bool
  // （它们被展开成 `if`）。`(or 3 7)` 在这个语言里是类型错误，不是"短路取第一个真"。
  valueIs(check, "④ remove-and-or-not：(or #f #t) → #t", "(or #f #t)", true);
  valueIs(check, "④ remove-and-or-not：(or #t #f) → #t（短路，第一个真就停）", "(or #t #f)", true);
  valueIs(check, "④ remove-and-or-not：(and #t #t) → #t", "(and #t #t)", true);
  valueIs(check, "④ remove-and-or-not：(and #t #f) → #f", "(and #t #f)", false);
  valueIs(check, "④ remove-and-or-not：(not #f) → #t", "(not #f)", true);
  valueIs(check, "④ remove-and-or-not：(or #f #f #t) → #t（三元）", "(or #f #f #t)", true);
  // **最锋利的一条**：`or` 的第一个操作数只许被求值一次。
  // 临时变量的意义就在这里 —— `(if a a …)` 会把 a 求值两次，有副作用就错了。
  {
    const out = after("(or a b)", "remove-and-or-not");
    // 临时变量的意义就在这里：`(if a a (or b))` 会把 `a` 求值**两次**。有了临时变量，
    // `a` 只出现一次（绑进去那次），后面两次用的是 `$or1`。**这是这条 pass 的核心不变量。**
    check(
      "④ remove-and-or-not：第一个操作数在输出里只出现**一次**（多了就是求值两次）",
      countVar(out, "a") === 1,
      `a 出现 ${countVar(out, "a")} 次：${one(out)}`,
    );
    check("④ remove-and-or-not：第二个操作数也只出现一次（没被复制）", countVar(out, "b") === 1, one(out));
    // 而临时变量被用两次（测一次、返回一次）
    check(
      "④ remove-and-or-not：临时变量在 If 里被用两次（测一次 + 返回一次）",
      one(out).split("$or").length - 1 >= 2,
      one(out),
    );
  }
}

// ───────────────────────── ⑤ expand-let-star（L4 → L5）─────────────────────────

function expandLetStarChecks(check: Check): void {
  // 通过条件：没有 LetStar 了，且绑定是**一层一个**（不是塞进同一个 let）
  const two = after("(let* ((x 1) (y 2)) (+ x y))", "expand-let-star");
  const b = bodyAt(two) as Node;
  check(
    "⑤ expand-let-star：`(let* ((x 1) (y 2)) …)` → 没有 LetStar，两层嵌套 Let、每层一个绑定",
    !tagsIn(two).has("LetStar") &&
      b["type"] === "Let" &&
      (b["bindings"] as Node[]).length === 1 &&
      (b["body"] as Node)["type"] === "Let" &&
      ((b["body"] as Node)["bindings"] as Node[]).length === 1,
    one(two),
  );
  // 顺序：外层是 x、内层是 y（反了就是绑定的可见性错了）
  const inner = b["body"] as Node;
  check(
    "⑤ expand-let-star：外层绑定是 x、内层是 y（顺序不能反）",
    (b["bindings"] as Node[])[0]!["name"] === "x" && (inner["bindings"] as Node[])[0]!["name"] === "y",
    one(two),
  );
  // 边界：零个绑定 → 直接是体
  const zero = after("(let* () 7)", "expand-let-star");
  check(
    "⑤ expand-let-star：`(let* () 7)` → 直接是 7（没有 Let）",
    countTag(zero, "Let") === 0 && (bodyAt(zero) as Node)["value"] === 7,
    one(zero),
  );
  // 边界：一个绑定 → 一个 Let
  const oneBind = after("(let* ((x 1)) x)", "expand-let-star");
  check("⑤ expand-let-star：`(let* ((x 1)) x)` → 一个 Let", countTag(oneBind, "Let") === 1, one(oneBind));
  // 语义：后面绑定的值能看到前面的（这是 let* 与 let 的唯一区别）
  valueIs(
    check,
    "⑤ expand-let-star：`(let* ((x 1) (y x)) y)` → 1（后面的绑定看得见前面的）",
    "(let* ((x 1) (y x)) y)",
    1,
  );
  valueIs(check, "⑤ expand-let-star：`(let* ((x 1) (y (+ x 1))) y)` → 2", "(let* ((x 1) (y (+ x 1))) y)", 2);
  valueIs(check, "⑤ expand-let-star：零绑定 → 7", "(let* () 7)", 7);
}

// ───────────────────────── ⑥ remove-one-armed-if（L5 → L6）─────────────────────────

function removeOneArmedIfChecks(check: Check): void {
  // 通过条件：没有 IfAlt 了，且补的是 Void 在 alt
  const out = after("(if c (f 1))", "remove-one-armed-if");
  const b = bodyAt(out) as Node;
  check(
    "⑥ remove-one-armed-if：`(if c t)` → 没有 IfAlt、alt 补 Void、then 原样",
    !tagsIn(out).has("IfAlt") &&
      b["type"] === "If" &&
      (b["then"] as Node)["type"] === "Call" &&
      (b["alt"] as Node)["type"] === "Void",
    one(out),
  );
  // 边界：**两臂的 if 不该被碰**（L5 里 If 和 IfAlt 是两个产生式）
  const two = after("(if c 1 2)", "remove-one-armed-if");
  check(
    "⑥ remove-one-armed-if：两臂 `(if c 1 2)` 原样（alt 还是 2，没被 Void 顶掉）",
    (bodyAt(two) as Node)["alt"] !== undefined && ((bodyAt(two) as Node)["alt"] as Node)["value"] === 2,
    one(two),
  );
  // 嵌套：里面还有一臂的也要补
  const nested = after("(if a (if b 1))", "remove-one-armed-if");
  check(
    "⑥ remove-one-armed-if：嵌套的一臂 if 也要补（两层都补上 Void）",
    countTag(nested, "Void") === 2,
    one(nested),
  );
  // 语义
  valueIs(check, "⑥ remove-one-armed-if：(if #f 1) → Void", "(if #f 1)", undefined);
  valueIs(check, "⑥ remove-one-armed-if：(if #t 1) → 1", "(if #t 1)", 1);
}

// ───────────────────────── ⑦ normalize-begin（L6 → L6）─────────────────────────

function normalizeBeginChecks(check: Check): void {
  // 通过条件：零个 → Void；一个 → 那个表达式本身（Begin 消失）；两个以上 → 还是 Begin
  const zero = after("(begin)", "normalize-begin");
  check(
    "⑦ normalize-begin：`(begin)` → Void",
    countTag(zero, "Begin") === 0 && (bodyAt(zero) as Node)["type"] === "Void",
    one(zero),
  );
  const oneE = after("(begin (f 1))", "normalize-begin");
  check(
    "⑦ normalize-begin：`(begin e)` → e 本身（Begin 消失）",
    countTag(oneE, "Begin") === 0 && (bodyAt(oneE) as Node)["type"] === "Call",
    one(oneE),
  );
  const two = after("(begin (f 1) (f 2))", "normalize-begin");
  check(
    "⑦ normalize-begin：两个以上 → 还是 Begin（这才真是顺序执行）",
    countTag(two, "Begin") === 1,
    one(two),
  );
  // 嵌套：`(begin (begin e))` —— 内层先塌，外层再看
  const nested = after("(begin (begin (f 1)))", "normalize-begin");
  check(
    "⑦ normalize-begin：嵌套 `(begin (begin e))` 两层都塌掉",
    countTag(nested, "Begin") === 0 && (bodyAt(nested) as Node)["type"] === "Call",
    one(nested),
  );
  // 语义
  valueIs(check, "⑦ normalize-begin：(begin 1 2 3) → 3（取最后一个）", "(begin 1 2 3)", 3);
  valueIs(check, "⑦ normalize-begin：(begin 7) → 7", "(begin 7)", 7);
  valueIs(check, "⑦ normalize-begin：(begin) → Void", "(begin)", undefined);
}

// ───────────────────────── ⑧ normalize-prim-arity（L6 → L6）─────────────────────────

function normalizePrimArityChecks(check: Check): void {
  // 通过条件：`+ - * /` 三元以上 → left-fold 成二元嵌套；**最左**那个在里层
  const three = after("(+ 1 2 3)", "normalize-prim-arity");
  const t = bodyAt(three) as Node;
  const inner = (t["args"] as Node[])[0]!;
  check(
    "⑧ normalize-prim-arity：`(+ 1 2 3)` → `(+ (+ 1 2) 3)`（left-fold，最左在里层）",
    t["type"] === "Prim" &&
      (t["args"] as Node[]).length === 2 &&
      inner["type"] === "Prim" &&
      (inner["args"] as Node[])[0]!["value"] === 1 &&
      (inner["args"] as Node[])[1]!["value"] === 2 &&
      (t["args"] as Node[])[1]!["value"] === 3,
    one(three),
  );
  // 四个参数：((1+2)+3)+4
  const four = after("(+ 1 2 3 4)", "normalize-prim-arity");
  check(
    "⑧ normalize-prim-arity：四个参数 fold 成三层（每个 Prim 都只有两个参数）",
    countTag(four, "Prim") === 3,
    one(four),
  );
  // 边界：二元原样
  const two = after("(+ 1 2)", "normalize-prim-arity");
  check("⑧ normalize-prim-arity：二元原样（不白包一层）", countTag(two, "Prim") === 1, one(two));
  // 边界：**`<` 和 `=` 不许动** —— 它们是链式比较，压成二元意思就变了
  const cmp = after("(< 1 2 3)", "normalize-prim-arity");
  const c = bodyAt(cmp) as Node;
  check(
    "⑧ normalize-prim-arity：`(< 1 2 3)` **原样**（链式比较，压成二元会变成 ((1<2)<3)）",
    (c["args"] as Node[]).length === 3,
    one(cmp),
  );
  const eq = after("(= 1 2 3)", "normalize-prim-arity");
  check(
    "⑧ normalize-prim-arity：`(= 1 2 3)` 原样（同上）",
    ((bodyAt(eq) as Node)["args"] as Node[]).length === 3,
    one(eq),
  );
  // 边界：一元取负**保留**（它是另一种运算，不是"参数少了一个"）
  const neg = after("(- 5)", "normalize-prim-arity");
  const n = bodyAt(neg) as Node;
  check(
    "⑧ normalize-prim-arity：`(- 5)` 保留一元（不是参数少了一个，是取负）",
    (n["args"] as Node[]).length === 1,
    one(neg),
  );
  // 边界：零元不 fold（恒等元交给 constantFold）
  const zero = after("(+)", "normalize-prim-arity");
  check(
    "⑧ normalize-prim-arity：`(+)` 不动（恒等元是 constantFold 的活）",
    countTag(zero, "Prim") === 1,
    one(zero),
  );
  // 语义
  valueIs(check, "⑧ normalize-prim-arity：(+ 1 2 3 4) → 10", "(+ 1 2 3 4)", 10);
  // 减法不满足结合律 —— fold 方向错了这条就红（(- 10 1) 2 = 7，反过来 (10 (1 2)) 也是 7，
  // 所以再加一条真正能分开方向的：(- 10 3 2) = 5，右 fold 会得 9。
  valueIs(check, "⑧ normalize-prim-arity：(- 10 3 2) → 5（左 fold；右 fold 会得 9）", "(- 10 3 2)", 5);
  valueIs(check, "⑧ normalize-prim-arity：(/ 100 5 2) → 10（同上，除法也不满足结合律）", "(/ 100 5 2)", 10);
  valueIs(check, "⑧ normalize-prim-arity：(< 1 2 3) → #t（链式比较没被压）", "(< 1 2 3)", true);
  valueIs(check, "⑧ normalize-prim-arity：(- 5) → -5（一元取负保留）", "(- 5)", -5);
}

// ───────────────────────── 入口 ─────────────────────────

export function t35Checks(check: Check): void {
  desugarDefFunChecks(check);
  removeWhenUnlessChecks(check);
  removeCondChecks(check);
  removeAndOrNotChecks(check);
  expandLetStarChecks(check);
  removeOneArmedIfChecks(check);
  normalizeBeginChecks(check);
  normalizePrimArityChecks(check);
}
