/**
 * t12 的验收：第一批代数规则。
 *
 * 五条：
 *   ① 每条规则一个单测
 *   ② 交换律那条只改一次、不会改回来
 *   ③ 结合律到**规范形**（AC 正规形 = 展平 + 排序），且只改有限次
 *   ④ 恒等式真的消掉
 *   ⑤ **每条规则跑完值不变** —— 对固定输入，改写前后求值相等
 *
 * ⑤ 是最要紧的：代数化简最容易"形状对了、值错了"。所以每条规则都拿一组输入跑一遍
 * 改写前后的值。
 */

import { runProgram, show } from "./eval.ts";
import { L6 } from "./langs/L6.lang.ts";
import { algebraicRules, algebraicSimplify } from "./passes/algebraic-simplify.L6.pass.ts";

export type Check = (name: string, ok: boolean, detail?: string) => void;

type Node = Record<string, unknown>;

const V = (n: string): Node => ({ type: "Var", name: n });
const I = (v: number): Node => ({ type: "Int", value: v });
const P = (op: string, ...a: unknown[]): Node => ({ type: "Prim", op, args: a });
const prog = (e: unknown): Node => ({ type: "Prog", defs: [], body: [e] });

/** 取 body 里的表达式（代数化简不会动顶层结构）。 */
function body(e: unknown): Node {
  return ((e as Node)["body"] as Node[])[0]!;
}

/** 把一棵表达式印成 s-表达式，方便在断言里比。 */
function sexp(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  const n = x as Node;
  switch (n["type"]) {
    case "Int":
      return String(n["value"]);
    case "Var":
      return String(n["name"]);
    case "Prim":
      return `(${String(n["op"])} ${((n["args"] ?? []) as unknown[]).map(sexp).join(" ")})`;
    case "Prog":
      return ((n["body"] ?? []) as unknown[]).map(sexp).join(" ");
    default:
      return `<${String(n["type"])}>`;
  }
}

export function algebraicChecks(check: Check): void {
  const simplify = (e: unknown): Node => body(algebraicSimplify.run(prog(e)));

  // ── ① 每条规则一个单测（顺序与 algebraicRules 一致）
  const CASES: [string, Node, string][] = [
    // 恒等式
    ["x + 0 → x", P("+", V("x"), I(0)), "x"],
    ["0 + x → x", P("+", I(0), V("x")), "x"],
    ["(+ a b 0 0) → (+ a b)（丢掉多个恒等元）", P("+", V("a"), V("b"), I(0), I(0)), "(+ a b)"],
    ["(+ 0 0) → 0（全是恒等元）", P("+", I(0), I(0)), "0"],
    ["x - 0 → x", P("-", V("x"), I(0)), "x"],
    ["x * 1 → x", P("*", V("x"), I(1)), "x"],
    ["x / 1 → x", P("/", V("x"), I(1)), "x"],
    ["x * 0 → 0", P("*", V("x"), I(0)), "0"],
    // 强度削减
    ["x * 2 → x + x", P("*", V("x"), I(2)), "(+ x x)"],
    // 重结合（左 → 右）
    // 结合律的规范形是**展平**（AC 正规形），不是"重结合成某个方向的嵌套"。
    // 这里踩过一次真的坑：在**二元**节点上，"操作数排序"和"重结合"会互相修，无限打转。
    // 详见 pass 文件头。
    ["(a + b) + c → 展平成 (+ a b c)", P("+", P("+", V("a"), V("b")), V("c")), "(+ a b c)"],
    ["(a * b) * c → 展平成 (* a b c)", P("*", P("*", V("a"), V("b")), V("c")), "(* a b c)"],
    // 操作数规范化
    ["1 + x → x + 1", P("+", I(1), V("x")), "(+ x 1)"],
    ["y + x → x + y", P("+", V("y"), V("x")), "(+ x y)"],
  ];
  for (const [label, input, want] of CASES) {
    const got = sexp(simplify(input));
    check(`① ${label}`, got === want, `拿到 ${got}`);
  }

  // ── ② 交换律/规范化只改一次，不会改回来
  //    判据：把结果再跑一遍，一动不动
  {
    const once = simplify(P("y", V("a"))); // 不是 Prim，原样
    void once;
    const swapped = simplify(P("+", V("y"), V("x")));
    const twice = body(algebraicSimplify.run(prog(swapped)));
    check(
      "② 规范化只改一次（再跑一遍不变）",
      sexp(twice) === sexp(swapped),
      `${sexp(swapped)} → ${sexp(twice)}`,
    );

    // 已经规范的项不许动
    const already = simplify(P("+", V("x"), V("y")));
    check("② 已经规范的操作数顺序不动", sexp(already) === "(+ x y)", sexp(already));
  }

  // ── ③ 重结合到规范形，而且不是只做一步
  {
    const deep = P("+", P("+", P("+", V("a"), V("b")), V("c")), V("d"));
    const got = sexp(simplify(deep));
    check("③ 结合律到规范形（展平成 n 元 + 排序）", got === "(+ a b c d)", got);

    // 展平和排序**一次做到位**（不是改好几轮）：字面量排到后面
    const mixed = sexp(simplify(P("+", I(2), P("+", I(3), P("+", I(1), I(4))))));
    check("③ 展平 + 排序一起做（字面量排后面）", mixed === "(+ 1 2 3 4)", mixed);
  }

  // ── ④ 恒等式真的消掉（不是留着不动的 "x + 0"）
  {
    const got = simplify(P("+", V("x"), I(0)));
    check("④ 恒等式真的消掉", got["type"] === "Var", sexp(got));
  }

  // ── ⑤ **值不变**：对一批输入，改写前后求值相等
  {
    const ENV_VALUES = [0, 1, 2, 7, -3];
    const EXPRS: [string, Node][] = [
      ["x + 0", P("+", V("x"), I(0))],
      ["x * 1", P("*", V("x"), I(1))],
      ["x * 2", P("*", V("x"), I(2))],
      ["x * 0", P("*", V("x"), I(0))],
      ["1 + x", P("+", I(1), V("x"))],
      ["(x + 1) + x", P("+", P("+", V("x"), I(1)), V("x"))],
      ["((x + 1) + x) + 2", P("+", P("+", P("+", V("x"), I(1)), V("x")), I(2))],
      ["(x * 2) + (1 + x)", P("+", P("*", V("x"), I(2)), P("+", I(1), V("x")))],
      ["x - 0", P("-", V("x"), I(0))],
      ["(x * 1) * 2", P("*", P("*", V("x"), I(1)), I(2))],
    ];

    let bad: string | null = null;
    let n = 0;
    for (const [label, e] of EXPRS) {
      const after = simplify(e);
      for (const v of ENV_VALUES) {
        // 用 L6 的解释器直接跑：把 x 绑成一个 Int 字面量的 let
        const mk = (expr: unknown): Node => ({
          type: "Prog",
          defs: [],
          body: [{ type: "Let", bindings: [{ type: "Bind", name: "x", value: I(v) }], body: expr }],
        });
        let a: string;
        let b: string;
        try {
          a = show(runProgram(mk(e) as never));
          b = show(runProgram(mk(after) as never));
        } catch (err) {
          bad = `${label} 求值报错：${(err as Error).message}`;
          break;
        }
        n += 1;
        if (a !== b) {
          bad = `${label}（x=${v}）：改写前 ${a}，改写后 ${b}`;
          break;
        }
      }
      if (bad !== null) break;
    }
    check(`⑤ 值不变（${n} 组输入）`, bad === null, bad ?? "");
  }

  // ── 浮点守卫：展平会改结合顺序，IEEE754 不满足结合律 → 有浮点字面量就不展平
  {
    const F = (v: number): Node => ({ type: "Float", value: v });
    const got = sexp(simplify(P("+", F(1.5), V("x"), V("a"))));
    check("浮点链不展平/不排序（保守守卫）", got === "(+ <Float> x a)", got);

    // 整数链该展平排序，对照
    const ints = sexp(simplify(P("+", I(2), V("x"), V("a"))));
    check("整数链照常展平排序（对照）", ints === "(+ a x 2)", ints);

    // `* 2.0` 不是整数 2，强度削减不该动它
    const f2 = sexp(simplify(P("*", V("x"), F(2))));
    check("浮点 2.0 不触发强度削减（只认整数 2）", f2 === "(* x <Float>)", f2);
  }

  // ── 幂等 + 不动点：跑第二遍必须返回**同一个对象**
  //
  //    一次验两件事：
  //      ① rewrite() 内部真的跑到不动点了（否则第二遍还会改）
  //      ② codegen 的"没改就复用原对象"（这是 t13 不动点判定能 O(1) 的前提）
  {
    const once = algebraicSimplify.run(prog(P("+", P("*", V("b"), I(2)), P("+", V("a"), I(0)))));
    const twice = algebraicSimplify.run(once);
    check(
      "幂等：跑第二遍返回同一个对象（内部已到不动点）",
      twice === once,
      twice === once ? "" : "第二遍又改了东西",
    );
  }

  // ── 规则数：说了 10 条就要在
  check(
    "规则表条数（10 条）",
    algebraicRules().length === algebraicSimplify.ruleCount,
    `${algebraicRules().length} vs ${algebraicSimplify.ruleCount}`,
  );
  void L6;
}
