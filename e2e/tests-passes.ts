/**
 * t36：最后两门没有专属单测的 pass —— `const-prop` 和 `uncover-free`。
 *
 * 补完这个文件，"**每门 pass 都有专属单测**"这条才真的成立（t35 补了另外 8 门）。
 *
 * ── 这两门为什么特别值得单独测
 *
 * 它们都是**环境类** pass：结果取决于"遍历到这里时哪些名字的值/绑定是已知的"。这类
 * pass 的错法有个共同点 —— **在别的输入上看不出来**：
 *
 *   const-prop：遮蔽漏了（把局部变量代成外层常量）—— 只有"同名内外两层"才暴露；
 *               绑定顺序错了（把 let 当 let*）—— 只有"后面的绑定引用前面的"才暴露。
 *   uncover-free：自由集少算/多算 —— 只有"嵌套 lambda + 中间隔着 let"才暴露；
 *               把 let 绑的名字当成自由的 —— 只有"lambda 里 let 一个同名变量"才暴露。
 *
 * 换句话说：**这两门的正确性几乎全靠边界情形**，而边界情形正是"整条管线跑完值对"最
 * 不可能覆盖到的地方。这是这个文件存在的全部理由。
 */

import { after, bodyAt, countVar, idxOf, one, valueIs, type Check, type Node } from "./testkit.ts";
import { runPipelineRange, linkedSteps } from "./linked.ts";
import { parse } from "./s-expr.ts";
import { readProgram } from "./read.ts";

// ───────────────────────── 工具（这两门专用）─────────────────────────

/** 跑到 `name` 之后，取原始 JSON（**不看截断的渲染** —— 被截断的输出骗过一次）。 */
function jsonAt(src: string, name: string): Record<string, unknown> {
  const out = runPipelineRange(readProgram(parse(src, "t36.tli").forms, "t36.tli"), 0, idxOf(name) + 1);
  return out as Record<string, unknown>;
}

/** 树上所有 `BindFree.names`（按遇到顺序）。 */
function freeNames(src: string): string[][] {
  const found: string[][] = [];
  const walk = (x: unknown): void => {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const y of x) walk(y);
      return;
    }
    const n = x as Node;
    if (n["type"] === "BindFree") found.push(n["names"] as string[]);
    for (const [k, v] of Object.entries(n)) if (!k.startsWith("__")) walk(v);
  };
  walk(jsonAt(src, "uncover-free"));
  return found;
}

/** 取一个 `Bind` 的值节点的 tag（用来看"这个绑定的值有没有被代换"）。 */
function bindTag(prog: Record<string, unknown>, i: number): string {
  const body = (prog["body"] as Node[])[0]!;
  return ((body["bindings"] as Node[])[i]!["value"] as Node)["type"] as string;
}

// ───────────────────────── ① const-prop（L6 → L6）─────────────────────────

function constPropChecks(check: Check): void {
  const CP = "const-prop";

  // ── 通过条件 A：已知是字面量的变量引用被换成那个字面量 ──
  {
    const out = jsonAt("(let ((x 5)) (+ x 1))", CP);
    const prim = (out["body"] as Node[])[0]!["body"] as Node as Node;
    check(
      "① const-prop：`(let ((x 5)) (+ x 1))` → 体里的 `x` 变成 5（绑定本身不动）",
      (prim["args"] as Node[])[0]!["type"] === "Int" && (prim["args"] as Node[])[0]!["value"] === 5,
      one(out),
    );
    check(
      "① const-prop：绑定的值**保留原样**（只有引用被换，定义处不动）",
      bindTag(out, 0) === "Int",
      one(out),
    );
  }

  // ── 通过条件 B：顶层字面量定义喂给 body ──
  {
    const out = jsonAt("(define k 7) (+ k 1)", CP);
    const prim = (out["body"] as Node[])[0]! as Node;
    check(
      "① const-prop：顶层 `(define k 7)` → body 里的 `k` 变成 7",
      (prim["args"] as Node[])[0]!["type"] === "Int" && (prim["args"] as Node[])[0]!["value"] === 7,
      one(out),
    );
  }

  // ── 通过条件 C（**遮蔽**）：局部同名不能代成外层常量 ──
  //
  // 这是这门 pass 最容易错的地方：环境里 `x` 是 7，进了 `(let ((x (+ 1 2))) …)` 之后
  // 那个 `x` 是**新的**、值不知道，不能拿 7 去代。
  {
    const out = jsonAt("(define x 7) (let ((x (+ 1 2))) x)", CP);
    const let0 = (out["body"] as Node[])[0]! as Node;
    check(
      "① const-prop：局部 `x` 遮蔽了顶层 `x` 时**不代换**（不能把 7 代进去）",
      (let0["body"] as Node)["type"] === "Var" && (let0["body"] as Node)["name"] === "x",
      one(out),
    );
    // 对照：同一个程序里 body 换成**别的**名字，就能看到顶层常量是活的
    const out2 = jsonAt("(define x 7) (let ((y (+ 1 2))) x)", CP);
    const let2 = (out2["body"] as Node[])[0]! as Node;
    check(
      "① const-prop：同一程序里没被遮蔽的顶层 `x` **要**代成 7（证明上一条不是因为环境空了）",
      (let2["body"] as Node)["type"] === "Int" && (let2["body"] as Node)["value"] === 7,
      one(out2),
    );
  }

  // ── 通过条件 D（**let 是平行的**）：绑定值在**外层**环境求值 ──
  //
  // `(let ((x 1) (y x)) y)` 里的 `x` 指的是**外层**的 x（如果有），不是同一层刚绑的 x。
  // 没有外层 x 时两个 `x` 都不该被代换 —— 这就是"平行"的证据。
  {
    const out = jsonAt("(let ((x 1) (y x)) y)", CP);
    check(
      "① const-prop：`(let ((x 1) (y x)) y)` 里 y 的值**不代换**（let 是平行的，同一层看不见 x）",
      bindTag(out, 1) === "Var",
      one(out),
    );
    // 有外层 x 时，`(let ((x 1) (y x)) y)` 里的那个 x 该代成**外层**的 7
    const out2 = jsonAt("(define x 7) (let ((x 1) (y x)) y)", CP);
    const yVal = ((out2["body"] as Node[])[0]!["bindings"] as Node[])[1]!["value"] as Node as Node;
    check(
      "① const-prop：有外层 `x=7` 时，`(let ((x 1) (y x)) …)` 里的 x 代成 **7**（不是同一层的 1）",
      yVal["type"] === "Int" && yVal["value"] === 7,
      one(out2),
    );
    // 而同一层里 y 绑完之后，body 看见的是**内层**的 x=1，不是外层的 7
    const out3 = jsonAt("(define x 7) (let ((x 1) (y x)) x)", CP);
    const inner = (out3["body"] as Node[])[0]!["body"] as Node as Node;
    check(
      "① const-prop：同一层绑完之后，body 看见的是**内层** x=1（不是外层的 7）",
      inner["type"] === "Int" && inner["value"] === 1,
      one(out3),
    );
  }

  // ── 通过条件 E（**letrec 一律不知道**）：绑定互相可见，一个都不能当常量 ──
  //
  // 注意：`letrec` 里的绑定值本身还是会被遍历（那是对**外层**环境的引用）。
  {
    const out = jsonAt("(letrec ((f 1)) f)", CP);
    const lr = (out["body"] as Node[])[0]! as Node;
    check(
      "① const-prop：`(letrec ((f 1)) f)` → body 里的 `f` **不代换**（letrec 的绑定一律不知道）",
      (lr["body"] as Node)["type"] === "Var",
      one(out),
    );
    // 对照：普通 let 的同一个程序**要**代换 —— 不然上一条可能是因为"字面量压根不认"
    const out2 = jsonAt("(let ((f 1)) f)", CP);
    const l = (out2["body"] as Node[])[0]! as Node;
    check(
      "① const-prop：同样的程序换成 `let` **要**代成 1（证明上一条是 letrec 特有的，不是普遍不代）",
      (l["body"] as Node)["type"] === "Int" && (l["body"] as Node)["value"] === 1,
      one(out2),
    );
  }

  // ── 通过条件 F：lambda 的参数遮蔽外层 ──
  {
    const out = jsonAt("(define x 7) ((lambda (x) x) 1)", CP);
    const call = (out["body"] as Node[])[0]! as Node;
    const lam = call["fn"] as Node;
    check(
      "① const-prop：lambda 的参数 `x` 遮蔽顶层 `x` → 体里的 x 不代换",
      (lam["body"] as Node)["type"] === "Var",
      one(out),
    );
  }

  // ── 通过条件 G（**不往下看**）：顶层定义之间的链不是这门 pass 的活 ──
  //
  // `(define a 1) (define b a) b` —— `b` 的值里那个 `a` 该代成 1 吗？**不该**。
  // 顶层名字只喂给 body，定义之间互相看不见（那是 global-const 的活，它跑不动点）。
  // 这条是**分工**，钉住它免得以后有人"顺手"在这里也代一遍（那会让两条 pass 打架）。
  {
    const out = jsonAt("(define a 1) (define b a) b", CP);
    const defs = out["defs"] as Node[];
    check(
      "① const-prop：定义之间**不代换**（`(define b a)` 里的 a 留着 —— 那是 global-const 的活）",
      (defs[1]!["value"] as Node)["type"] === "Var",
      one(out),
    );
    check(
      "① const-prop：而 body 里的 `b` 也不代换（b 的值不是字面量）",
      (bodyAt(out) as Node)["type"] === "Var",
      one(out),
    );
  }

  // ── 通过条件 H：不是字面量的值**不进环境**（不能拿一个表达式去代变量） ──
  {
    const out = jsonAt("(let ((x (+ 1 2))) x)", CP);
    const l = (out["body"] as Node[])[0]! as Node;
    check(
      "① const-prop：`(let ((x (+ 1 2))) x)` → x 不代换（只有字面量进环境）",
      (l["body"] as Node)["type"] === "Var",
      one(out),
    );
  }

  // ── 通过条件 I：嵌套遮蔽 —— 内层用完要**还原**到外层 ──
  //
  // `(let ((x 5)) (let ((x 6)) x))` 里的内层 x 是 6；但**外层**在离开内层之后还得是 5。
  // 这条测的是"保存/还原"（t26 从复制 Map 改成可变 + 还原，就是为了这个）。
  {
    const out = jsonAt("(let ((x 5)) (let ((x 6)) x))", CP);
    const outer = (out["body"] as Node[])[0]! as Node;
    const innerLet = outer["body"] as Node;
    check(
      "① const-prop：嵌套同名 —— 内层 `x` 代成 **6**",
      (innerLet["body"] as Node)["type"] === "Int" && (innerLet["body"] as Node)["value"] === 6,
      one(out),
    );
    // 还原：外层那个 let 的绑定值位置不受影响，且离开内层后外层还是 5
    const out2 = jsonAt("(let ((x 5)) (let ((y 6)) x))", CP);
    const outer2 = (out2["body"] as Node[])[0]! as Node;
    check(
      "① const-prop：离开内层之后外层 `x` 还是 **5**（作用域退出要还原，不能留下内层的值）",
      ((outer2["body"] as Node)["body"] as Node)["value"] === 5,
      one(out2),
    );
  }

  // ── 值：整条管线跑完，手写期望值 ──
  valueIs(check, "① const-prop：(let ((x 5)) (+ x 1)) → 6", "(let ((x 5)) (+ x 1))", 6);
  valueIs(check, "① const-prop：遮蔽时取的是局部值 → 3", "(define x 7) (let ((x 3)) x)", 3);
  valueIs(check, "① const-prop：平行 let 的绑定顺序 → 7", "(define x 7) (let ((x 1) (y x)) y)", 7);
  valueIs(check, "① const-prop：letrec 的值 → 1", "(letrec ((f 1)) f)", 1);
}

// ───────────────────────── ② uncover-free（L6 → L7）─────────────────────────

function uncoverFreeChecks(check: Check): void {
  const UF = "uncover-free";

  // ── 通过条件 A：没有自由变量 → 空集（**不是缺 BindFree**）──
  {
    check(
      "② uncover-free：`(lambda (x) x)` → BindFree.names 是 []",
      JSON.stringify(freeNames("(lambda (x) x)")) === "[[]]",
      JSON.stringify(freeNames("(lambda (x) x)")),
    );
  }

  // ── 通过条件 B：一个自由变量 ──
  {
    check(
      '② uncover-free：`(lambda (x) (+ x y))` → ["y"]（x 被绑、y 自由）',
      JSON.stringify(freeNames("(lambda (x) (+ x y))")) === '[["y"]]',
      JSON.stringify(freeNames("(lambda (x) (+ x y))")),
    );
  }

  // ── 通过条件 C（**最要紧的一条**）：嵌套 lambda —— 内层自由集要并进外层，且减掉外层的绑定 ──
  //
  // `(lambda (x) (lambda (y) (+ x y)))`：
  //   内层（绑 y）：x 自由 —— x 绑在**外**层，不在这个 lambda 里 → {x}
  //   外层（绑 x）：把内层的 {x} 并进来，减掉**自己范围内绑着的一切** → {}（x 就是它自己绑的）
  //
  // **顺序是树的顺序，外层先**：外层的 Lam 的体就是外层那个 `BindFree`，它在树里先出现
  // （内层的 Lam 在它的 body 里面）。不是压栈顺序 —— 一开始写反过。
  {
    check(
      '② uncover-free：`(lambda (x) (lambda (y) (+ x y)))` → 外层 []、内层 ["x"]（并进去又减掉）',
      JSON.stringify(freeNames("(lambda (x) (lambda (y) (+ x y)))")) === '[[],["x"]]',
      JSON.stringify(freeNames("(lambda (x) (lambda (y) (+ x y)))")),
    );
    // 内层绑的是 x（外层的名字），外层用 y —— 结论要跟着绑定关系走，不是跟着名字
    check(
      '② uncover-free：`(lambda (x) (lambda (y) x))` → 外层 []、内层 ["x"]',
      JSON.stringify(freeNames("(lambda (x) (lambda (y) x))")) === '[[],["x"]]',
      JSON.stringify(freeNames("(lambda (x) (lambda (y) x))")),
    );
  }

  // ── 通过条件 D（**隔着 let**）：let 绑的名字不算自由变量 ──
  {
    check(
      "② uncover-free：`(lambda (x) (let ((z 1)) (+ x z)))` → []（z 被 let 绑着，不自由）",
      JSON.stringify(freeNames("(lambda (x) (let ((z 1)) (+ x z)))")) === "[[]]",
      JSON.stringify(freeNames("(lambda (x) (let ((z 1)) (+ x z)))")),
    );
    check(
      '② uncover-free：`(lambda (x) (let ((z 1)) (+ x w)))` → ["w"]（w 没被绑）',
      JSON.stringify(freeNames("(lambda (x) (let ((z 1)) (+ x w)))")) === '[["w"]]',
      JSON.stringify(freeNames("(lambda (x) (let ((z 1)) (+ x w)))")),
    );
  }

  // ── 通过条件 E：**最内层** lambda 才记 —— 一个引用只出现在一个自由集里 ──
  //
  // `(lambda (a) (let ((b a)) (lambda (c) (+ a b c d))))`：
  //   内层（绑 c）：a 自由、b 自由、d 自由（c 自己绑着）→ {a,b,d}
  //   外层（绑 a）：并进内层那份，减掉**这个 lambda 范围内绑着的一切** —— 不只是它的参数 a，
  //                 还有里面那个 let 绑的 b（b 是在这个 lambda 内部绑的，对外层不自由）。
  //                 → {d}
  //
  // 这条是"减掉参数"和"减掉范围内绑的一切"的**判别用例**：前者会得到 {d,b}，是错的。
  {
    const got = freeNames("(lambda (a) (let ((b a)) (lambda (c) (+ a b c d))))");
    check(
      "② uncover-free：外层是 {d} 而不是 {d,b}（减的是范围内绑的一切，不只是参数）",
      got.length === 2 &&
        got[0]!.length === 1 &&
        got[0]![0] === "d" &&
        got[1]!.length === 3 &&
        got[1]!.includes("a") &&
        got[1]!.includes("b") &&
        got[1]!.includes("d"),
      JSON.stringify(got),
    );
  }

  // ── 通过条件 E2（**判别用例**）：内层 lambda 退出时要**还原** active ──
  //
  // 内层 `(lambda (y) y)` 会把 `y` 装成"绑在深度 1"。它退出之后，同层那个 `y` 引用
  // **仍然是自由的** —— 所以退出时必须把 `y` 从 active 里还原掉。
  //
  // 不还原的话，同层的 `y` 会被判成"绑在当前 lambda 里"，外层自由集少一个 `y`。
  // 实测：去掉那句 `restore` 之后，**只有这条形状**能抓到（`(+ x (inner) y)` 那种
  // 放在 Prim 参数里的抓不到 —— 不知道为什么，但这条确实抓到了，所以留着它）。
  {
    const got = freeNames("(lambda (x) (begin ((lambda (y) y) 1) y))");
    check(
      "② uncover-free：内层 lambda 退出后，同层的 `y` 仍然自由（退出要还原 active）",
      JSON.stringify(got) === '[["y"],[]]',
      JSON.stringify(got),
    );
  }

  // ── 通过条件 F：同一个自由变量引用多次只记一次（是集合，不是列表）──
  {
    check(
      '② uncover-free：`(lambda () (+ y y))` → ["y"] 只出现一次（自由集是集合）',
      JSON.stringify(freeNames("(lambda () (+ y y))")) === '[["y"]]',
      JSON.stringify(freeNames("(lambda () (+ y y))")),
    );
  }

  // ── 通过条件 G：顶层函数引用自己 → 自己是自由的 ──
  //
  // `(define (f a) (f a))` —— `f` 是顶层名字，在 lambda 里引用它就是自由的（递归靠全局）。
  {
    check(
      '② uncover-free：`(define (f a) (f a))` → ["f"]（递归靠全局，f 是自由的）',
      JSON.stringify(freeNames("(define (f a) (f a))")) === '[["f"]]',
      JSON.stringify(freeNames("(define (f a) (f a))")),
    );
    check(
      '② uncover-free：`(define (f a) (g a))` → ["g"]（参数 a 被绑，g 自由）',
      JSON.stringify(freeNames("(define (f a) (g a))")) === '[["g"]]',
      JSON.stringify(freeNames("(define (f a) (g a))")),
    );
  }

  // ── 通过条件 H：**每个** lambda 都要有 BindFree，兄弟之间互不干扰 ──
  {
    const got = freeNames("(lambda (x) x) (lambda (y) y)");
    check(
      "② uncover-free：两个并列的 lambda 各自一份 BindFree、都是 []",
      JSON.stringify(got) === "[[],[]]",
      JSON.stringify(got),
    );
    const got2 = freeNames("(lambda (x) (+ x a)) (lambda (y) (+ y b))");
    check(
      '② uncover-free：并列 lambda 的自由集不串味（左边 ["a"]、右边 ["b"]）',
      JSON.stringify(got2) === '[["a"],["b"]]',
      JSON.stringify(got2),
    );
  }

  // ── 通过条件 I：body 不是 lambda 时，没有 BindFree 要物化 ──
  {
    check(
      "② uncover-free：body 不是 lambda（`(+ a b)`）→ 一个 BindFree 都没有",
      freeNames("(+ a b)").length === 0,
      JSON.stringify(freeNames("(+ a b)")),
    );
  }

  // ── 通过条件 J：**确定性** —— 同一个输入跑两次，自由集逐字节一样 ──
  //
  // 自由集是 `Set`，如果实现里依赖了"上一次 run 留下的状态"，或者顺序不稳定，这条会红。
  {
    const a = JSON.stringify(freeNames("(lambda (a) (lambda (b) (+ a b c)))"));
    const b = JSON.stringify(freeNames("(lambda (a) (lambda (b) (+ a b c)))"));
    check("② uncover-free：同一个输入跑两次，结果逐字节一样（没有跨 run 的残留状态）", a === b, a);
  }

  // ── 通过条件 K：**自由变量被换成引用它的那个名字**，而 lambda 的体确实换成了 BindFree ──
  {
    const out = jsonAt("(lambda (x) (+ x y))", UF);
    const lam = (out["body"] as Node[])[0]! as Node;
    check(
      "② uncover-free：lambda 的体换成了 `BindFree`（L7 的 Lam 体是 Body，不是 Expr）",
      (lam["body"] as Node)["type"] === "BindFree",
      one(out),
    );
    check(
      "② uncover-free：自由变量 y 在体里**还是 Var 引用**（只是被记下来了，没有代换）",
      countVar(out, "y") === 1,
      one(out),
    );
  }

  // ── 值：整条管线跑完，手写期望值 ──
  valueIs(
    check,
    "② uncover-free：闭包捕获外层参数 → 12",
    "(define (adder n) (lambda (x) (+ x n)))\n((adder 10) 2)",
    12,
  );
  valueIs(
    check,
    "② uncover-free：嵌套 lambda 捕获两层 → 6",
    "(define (f a) (lambda (b) (lambda (c) (+ a b c))))\n(((f 1) 2) 3)",
    6,
  );
  valueIs(check, "② uncover-free：lambda 里的 let 遮蔽 → 5", "((lambda (x) (let ((x 5)) x)) 1)", 5);
}

// ───────────────────────── ③ dce（L7 → L7，局部）─────────────────────────

function dceChecks(check: Check): void {
  const D = "dce";

  // ── 通过条件 A：没人引用的绑定被删掉 ──
  {
    const out = jsonAt("(let ((x (f 1))) 2)", D);
    check(
      "③ dce：`(let ((x (f 1))) 2)` → 整个 let 没了（绑定没人引用，且没有副作用可保）",
      (bodyAt(out) as Node)["type"] === "Int",
      one(out),
    );
  }

  // ── 通过条件 B：**还引用着的**绑定一个都不能少，顺序也不能变 ──
  {
    const out = jsonAt("(let ((x (f 1)) (y (g 2))) y)", D);
    const l = bodyAt(out) as Node;
    const binds = l["bindings"] as Node[];
    check(
      "③ dce：`(let ((x (f 1)) (y (g 2))) y)` → 只删 x，y 留着（顺序不变）",
      l["type"] === "Let" && binds.length === 1 && binds[0]!["name"] === "y",
      one(out),
    );
    check(
      "③ dce：保留下来的绑定的**值**没被动过（还是那个 Call）",
      (binds[0]!["value"] as Node)["type"] === "Call",
      one(out),
    );
  }

  // ── 通过条件 C：引用两次也只算"用到了"（不能因为"用了两次"而删一次）──
  {
    const out = jsonAt("(let ((x (f 1))) (begin x x))", D);
    const l = bodyAt(out) as Node;
    check("③ dce：`(begin x x)` 引用两次 → 绑定保留", l["type"] === "Let", one(out));
  }

  // ── 通过条件 D（**作用域**）：内层遮蔽的名字不算"用了外层" ──
  //
  // `(let ((x (f 1))) (let ((x (g 2))) x))` —— 内层那个 x 指的是**内层**绑定，所以外层 x
  // 没人用，该删。删完只剩内层那个 let（它自己用自己的绑定）。
  //
  // 内层的值故意用**非字面量** `(g 2)`：用字面量的话 `const-prop` 会先把它代进 `x`，
  // 于是内层绑定也没人用了 —— 整条塌成那个字面量，就看不到"只删了外层"这件事。
  {
    const out = jsonAt("(let ((x (f 1))) (let ((x (g 2))) x))", D);
    const l = bodyAt(out) as Node;
    check(
      "③ dce：内层遮蔽 → 外层那个没人用的 x 被删，内层留着（被删的是外层的 `(f 1)`）",
      l["type"] === "Let" &&
        (l["bindings"] as Node[]).length === 1 &&
        (l["bindings"] as Node[])[0]!["name"] === "x" &&
        ((((l["bindings"] as Node[])[0]!["value"] as Node)["fn"] as Node)["name"] as string) === "g",
      one(out),
    );
  }

  // ── 通过条件 E：嵌套都塌掉（没有引用的链一路删上去）──
  {
    const out = jsonAt("(let ((x (f 1))) (let ((y 2)) 3))", D);
    check(
      "③ dce：`(let ((x (f 1))) (let ((y 2)) 3))` → 两层都塌成 3",
      (bodyAt(out) as Node)["type"] === "Int" && (bodyAt(out) as Node)["value"] === 3,
      one(out),
    );
  }

  // ── 通过条件 F：**letrec 一律不动** ──
  //
  // letrec 的绑定互相可见、还可以互相引用，删任何一个都可能删掉别人在用的东西。
  // 这条钉的是"保守"，不是"精确"。
  {
    const out = jsonAt("(letrec ((f (lambda () 1)) (g (lambda () 2))) (g))", D);
    const l = bodyAt(out) as Node;
    check(
      "③ dce：letrec 的绑定一个都不删（互相可见，保守）",
      l["type"] === "Letrec" && (l["bindings"] as Node[]).length === 2,
      one(out),
    );
  }

  // ── 通过条件 G：lambda 的参数**不算**局部绑定（那是调用点的事）──
  //
  // 参数由**调用者**给，lambda 体内用不用是 lambda 自己的事，不能删（删了调用点就对不上）。
  {
    const out = jsonAt("((lambda (x) 1) 2)", D);
    const call = bodyAt(out) as Node;
    const lam = call["fn"] as Node;
    check(
      "③ dce：`(lambda (x) 1)` 的参数 x 保留（参数是调用者给的，不能删）",
      (lam["params"] as Node[]).length === 1 && (lam["body"] as Node)["type"] === "BindFree",
      one(out),
    );
  }

  // ── 值 ──
  valueIs(check, "③ dce：(let ((x 1)) 2) → 2", "(let ((x 1)) 2)", 2);
  valueIs(check, "③ dce：(let ((x 1)) x) → 1", "(let ((x 1)) x)", 1);
  valueIs(check, "③ dce：(let ((x 1) (y 2)) (+ x y)) → 3", "(let ((x 1) (y 2)) (+ x y))", 3);
  valueIs(
    check,
    "③ dce：letrec 的互相引用 → 3",
    "(letrec ((f (lambda () 1)) (g (lambda () (+ (f) 2)))) (g))",
    3,
  );
}

// ───────────────────────── ④ constant-fold（L6 → L6）─────────────────────────

function constantFoldChecks(check: Check): void {
  const CF = "constant-fold";

  // ── 通过条件 A：字面量算术折成一个字面量 ──
  {
    for (const [src, v] of [
      ["(+ 1 2)", 3],
      ["(* 2 3)", 6],
      ["(- 5)", -5],
      ["(+ 1 2 3 4)", 10],
    ] as const) {
      const out = jsonAt(src, CF);
      check(
        `④ constant-fold：\`${src}\` → 字面量 ${v}`,
        (bodyAt(out) as Node)["type"] === "Int" && (bodyAt(out) as Node)["value"] === v,
        one(out),
      );
    }
  }

  // ── 通过条件 B：比较折成 Bool ──
  {
    check("④ constant-fold：`(= 1 1)` → #t", (bodyAt(jsonAt("(= 1 1)", CF)) as Node)["value"] === true);
    check("④ constant-fold：`(= 1 2)` → #f", (bodyAt(jsonAt("(= 1 2)", CF)) as Node)["value"] === false);
  }

  // ── 通过条件 C（**不折除零**）：留给运行期报错 ──
  //
  // 折掉的话就把一个运行期错误变成了一个值 —— 语义就变了。这条是**保守**，不是漏了。
  {
    const out = jsonAt("(/ 1 0)", CF);
    check(
      "④ constant-fold：`(/ 1 0)` **不折**（留一个 Prim 给运行期报错）",
      (bodyAt(out) as Node)["type"] === "Prim",
      one(out),
    );
    // 而正常的除法要折 —— 证明上一条是除零特有的，不是"除法都不折"
    check(
      "④ constant-fold：`(/ 6 2)` → 3（正常的除法要折）",
      (bodyAt(jsonAt("(/ 6 2)", CF)) as Node)["value"] === 3,
    );
  }

  // ── 通过条件 D（**不折跨类型比较**）：`(= 1 1.0)` 留着 ──
  //
  // 解释器里 `1 === 1.0` 是 true（JS 的数字只有一种），但**编译期**不知道这件事：
  // 类型不同就不折，留给运行期。这是"折了会算错"那一类里的保守选择。
  {
    const out = jsonAt("(= 1 1.0)", CF);
    check(
      "④ constant-fold：`(= 1 1.0)` **不折**（Int 和 Float 不是一种字面量）",
      (bodyAt(out) as Node)["type"] === "Prim",
      one(out),
    );
  }

  // ── 通过条件 E：Float 参与 → 结果也是 Float（种类不能丢）──
  {
    const out = jsonAt("(+ 1.0 2)", CF);
    check(
      "④ constant-fold：`(+ 1.0 2)` → **Float** 3（种类不能变成 Int）",
      (bodyAt(out) as Node)["type"] === "Float" && (bodyAt(out) as Node)["value"] === 3,
      one(out),
    );
  }

  // ── 通过条件 F（**折完条件只留活着那一支**）：另一支整棵丢掉 ──
  //
  // 这条不只是省事 —— 它决定了"死分支里的运行期错误不会发生"。
  {
    const out = jsonAt("(if #t 1 (/ 1 0))", CF);
    check(
      "④ constant-fold：`(if #t 1 (/ 1 0))` → 1（死分支整棵丢掉，不会去算那个除零）",
      (bodyAt(out) as Node)["type"] === "Int" && (bodyAt(out) as Node)["value"] === 1,
      one(out),
    );
    const out2 = jsonAt("(if #f 1 2)", CF);
    check("④ constant-fold：`(if #f 1 2)` → 2（走 alt）", (bodyAt(out2) as Node)["value"] === 2, one(out2));
  }

  // ── 通过条件 G：条件不是字面量 → 两支都留着 ──
  {
    const out = jsonAt("(if c 1 2)", CF);
    const b = bodyAt(out) as Node;
    check("④ constant-fold：`(if c 1 2)` 条件不是字面量 → 两支都留", b["type"] === "If", one(out));
  }

  // ── 通过条件 H：折在**每一层**都发生（嵌套的也算）──
  {
    const out = jsonAt("(begin (+ 1 2) 9)", CF);
    const b = bodyAt(out) as Node;
    check(
      "④ constant-fold：嵌套的 `(+ 1 2)` 也折（`(begin (+ 1 2) 9)` 里那个变成 3）",
      b["type"] === "Begin" && ((b["exprs"] as Node[])[0]!["value"] as number) === 3,
      one(out),
    );
  }

  // ── 通过条件 I：有非字面量操作数 → 整条不折 ──
  {
    const out = jsonAt("(+ x 1)", CF);
    check(
      "④ constant-fold：`(+ x 1)` 不折（有未知操作数）",
      (bodyAt(out) as Node)["type"] === "Prim",
      one(out),
    );
  }

  // ── 值 ──
  valueIs(check, "④ constant-fold：(+ 1 2) → 3", "(+ 1 2)", 3);
  valueIs(check, "④ constant-fold：(+ 1.0 2) → 3", "(+ 1.0 2)", 3);
  valueIs(check, "④ constant-fold：(- 5) → -5", "(- 5)", -5);
  valueIs(check, "④ constant-fold：(if #t 1 (/ 1 0)) → 1（死分支不求值）", "(if #t 1 (/ 1 0))", 1);
}

// ───────────────────────── 入口 ─────────────────────────

export function t36Checks(check: Check): void {
  constPropChecks(check);
  uncoverFreeChecks(check);
  dceChecks(check);
  constantFoldChecks(check);
}

/** 这两门在管线里的下标（自检用：名字改了要立刻知道）。 */
export const T36_IDX = { constProp: idxOf("const-prop"), uncoverFree: idxOf("uncover-free") };
void linkedSteps;
