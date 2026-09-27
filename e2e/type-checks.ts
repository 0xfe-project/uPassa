/**
 * 类型层的断言（t24）。
 *
 * **这个文件不跑，它只是被 `pnpm check` 读。** 断言写在类型上，跑不起来的东西才是它要
 * 保护的东西 —— 复现不了的类型坑，最后都只能靠"别那么写"来绕。
 *
 * ── `@ts-expect-error` 是正经断言，不是注释
 *
 * 它要求下一行**必须**报错。检查要是被谁关掉了（比如 `NoInfer` 被顺手删了、判别联合
 * 退化成 `any` 了），这行自己就会变成 `Unused '@ts-expect-error' directive` —— 也就是说
 * **两个方向都钉着**：该报的必须报，该过的必须过。
 *
 * ── 这个文件在钉什么
 *
 * `pass({…})` 里那句 `NoInfer<Rules<F, O, Ctx>>`（见 `src/pass.ts`）。它让 TS 只从
 * `from` / `to` / `sig` 定这三个类型参数，不去从 handler 的**返回位置**反推输出语言。
 * 少了它，下面「① `Program` 上挂规则 + 有 `sig`」这一组直接 TS2589（类型实例化过深），
 * 而那是「扫一遍顶层定义」这种最普通的编译器写法 —— `global-const` 当初就是为了绕开它
 * 才变成手搭 Step 的。
 */

import { L6 } from "./langs/L6.lang.ts";
import { L7 } from "./langs/L7.lang.ts";
import { pass, sig } from "../src/pass.ts";
import type { NodeOf } from "../src/lang.ts";

type Expr = NodeOf<typeof L6, "Expr">;
type Program = NodeOf<typeof L6, "Program">;
type Env = Map<string, number>;

const nothing = sig(new Map<string, number>());

// ───────────────────── 该过的：这些都是合法写法 ─────────────────────

/** ① 在 `Program` 上挂规则 **+** 有 `sig` **+** 不写返回注解 —— 曾经 TS2589。 */
export const programRuleNoAnnotation = pass({
  from: L6,
  to: L6,
  sig: nothing,
  rules: {
    Program: {
      Prog: (n, rec, env) => {
        const body: Expr[] = n.body.map((e) => rec(e, env)[0] as Expr);
        return [{ ...n, body }, env];
      },
    },
  },
});

/** ② 同样的规则但用 `typeof n` 注解 —— 曾经 TS2322 且报错里漏出泛型 `F`。 */
export const programRuleTypeofAnnotation = pass({
  from: L6,
  to: L6,
  sig: nothing,
  rules: {
    Program: {
      Prog: (n, _rec, env): [typeof n, typeof env] => [{ ...n }, env],
    },
  },
});

/** ③ 输出语言和输入语言不同时不写注解（`Lam` 的体在 L7 里换成了 `Body`）。 */
export const crossLangNoAnnotation = pass({
  from: L6,
  to: L7,
  sig: nothing,
  rules: {
    Expr: {
      Var: (n, _rec, env) => [{ type: "Var", name: n.name }, env],
    },
  },
});

// ───────────────────── 该报的：检查必须还在 ─────────────────────
//
// 这几条是「`NoInfer` 只挡反推、不动检查」的证据。少了它们，上面那几条可能只是因为
// rules 整个变成了 `any` 才通过的。

/** ④ 少字段：`Prog` 必须有 `defs` 和 `body`。 */
export const missingFields = pass({
  from: L6,
  to: L6,
  sig: nothing,
  rules: {
    Program: {
      // @ts-expect-error 少了 defs / body
      Prog: (_n, _rec, env) => [{ type: "Prog" }, env],
    },
  },
});

/** ⑤ tag 打错。 */
export const wrongTag = pass({
  from: L6,
  to: L6,
  sig: nothing,
  rules: {
    Program: {
      // @ts-expect-error 输出语言里没有 Nope 这个产生式
      Prog: (_n, _rec, env) => [{ type: "Nope" }, env],
    },
  },
});

/** ⑥ 拿一个 `Expr` 当 `Program` 返回。 */
export const wrongNonterminal = pass({
  from: L6,
  to: L6,
  sig: nothing,
  rules: {
    Program: {
      // @ts-expect-error Var 属于 Expr，不是 Program
      Prog: (_n, _rec, env) => [{ type: "Var", name: "x" }, env],
    },
  },
});

/** ⑦ 有 `sig` 就必须回元组，只回节点不行（extra 是要往下穿的）。 */
export const missingExtra = pass({
  from: L6,
  to: L6,
  sig: nothing,
  rules: {
    Expr: {
      // @ts-expect-error arity 是 1，返回必须是 [节点, extra]
      Var: (n, _rec, _env) => n,
    },
  },
});

/** ⑧ 非终结符名写错（`Exp` 不是 `Expr`）。 */
export const wrongNonterminalName = pass({
  from: L6,
  to: L6,
  sig: nothing,
  rules: {
    // @ts-expect-error 只有 Expr 这个非终结符
    Exp: { Var: (n: Expr, _rec: unknown, _env: Env) => [n, _env] as [Expr, Env] },
  },
});

/** ⑨ 规则里挂一个输入语言没有的产生式。 */
export const unknownProduction = pass({
  from: L6,
  to: L6,
  sig: nothing,
  rules: {
    Expr: {
      // @ts-expect-error 输入语言里没有 NoSuchTag
      NoSuchTag: (n: Expr, _rec: unknown, _env: Env) => [n, _env] as [Expr, Env],
    },
  },
});
