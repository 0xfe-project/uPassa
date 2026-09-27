/**
 * pass 的声明。
 *
 * 对应 nanopass 的 (define-pass name : ilang (arg) -> olang (rv) ...)
 * 只有两件事你写：这个 pass 的 in/out 语言，和你真正关心的那几条规则。
 * 其余由框架生成（nanopass 的 system clause）。
 */

import type { LangDecl, NodeOf, Nonterminals, ProdsOf, ProdNode } from "./lang.ts";

// ───────────────────────── 递归点 ─────────────────────────

/** 某个 tag 属于哪个非终结符。rec 靠这个分派。 */
type NTOfTag<F, T extends string> = {
  [NT in Nonterminals<F>]: T extends keyof ProdsOf<F, NT> ? NT : never;
}[Nonterminals<F>];

/** 一门语言里所有产生式 tag。 */
type TagsOf<F> = { [NT in Nonterminals<F>]: keyof ProdsOf<F, NT> & string }[Nonterminals<F>];

/** handler 的返回：没声明 extra 就是节点本身，声明了就是元组。 */
export type Ret<O, NT extends string, Ctx extends readonly unknown[]> = Ctx extends readonly []
  ? NodeOf<O, NT>
  : readonly [NodeOf<O, NT>, ...Ctx];

/**
 * 「递归走一下子树」。
 *
 * 由遍历器传给 handler（不是 import 进来的），所以 handler 里不用假装调一个不存在的
 * 函数，也不用全局变量记「当前遍历器」。对应 nanopass 里就地可用的具名 transformer。
 *
 * 带 extra 时它返回一个元组：第一个是节点，后面是把 extra 往下穿之后的当前值。
 */
export type Rec<F, O, Ctx extends readonly unknown[]> = {
  <P extends TagsOf<F>>(
    x: ProdNode<F, P, ProdsOf<F, NTOfTag<F, P>>[P]>,
    ...ctx: Ctx
  ): Ret<O, NTOfTag<F, P>, Ctx>;
  <P extends TagsOf<F>>(
    xs: readonly ProdNode<F, P, ProdsOf<F, NTOfTag<F, P>>[P]>[],
    ...ctx: Ctx
  ): Ctx extends readonly [] ? NodeOf<O, NTOfTag<F, P>>[] : readonly [NodeOf<O, NTOfTag<F, P>>[], ...Ctx];
};

// ───────────────────────── extra：往下传和往上传 ─────────────────────────

/**
 * 这个 pass 往下传 / 往上传的那串值。
 *
 *   sig()                  没 extra，handler 直接返回节点
 *   sig(new Map(), 0)      往下传两个值：一个环境、一个计数
 *
 * **收的是样本值**，不是类型参数。原因有两个：类型要从值里推（不然要写
 * `pass<typeof L7, typeof L8, [Env, number]>`，太啰嗦）；更要紧的是运行期得知道
 * **几个**值才能生成线程代码，而类型参数在运行期是不存在的。
 * 样本值只用来取类型和个数，内容不会被读。
 *
 * 「形式参数」和「返回值」共用同一个形状，因为线程模型要求如此：一个子节点吐出来的
 * extra 就是传给下一个兄弟节点的额外参数，最后一个才是整个节点的 extra 返回值。
 * （这就是 nanopass 的 `,[e free*]` 那套。）
 */
export interface Sig<Ctx extends readonly unknown[]> {
  readonly __ctx: Ctx;
  /** 运行期数得出来的个数 —— codegen 靠它生成线程代码。 */
  readonly arity: number;
}

export function sig<Ctx extends readonly unknown[]>(...sample: Ctx): Sig<Ctx> {
  return { __ctx: sample, arity: sample.length };
}

// ───────────────────────── 规则的类型 ─────────────────────────

/** 一条规则收到的节点：输入语言里属于这个非终结符、带这个 tag 的那一支。 */
export type RuleInput<F, NT extends Nonterminals<F>, P extends keyof ProdsOf<F, NT> & string> = ProdNode<
  F,
  P,
  ProdsOf<F, NT>[P]
>;

/**
 * 规则表。键是非终结符名，值是该非终结符下你要处理的产生式。
 * 输出语言里同名的非终结符就是返回类型 —— 与 nanopass 一致。
 *
 * ── 为什么 handler 的返回类型建议自己写一行注解
 *
 * 注解现在是**可选的**（不写也不会漏检，`e2e/type-checks.ts` 两个方向都钉着），
 * 但**报错信息差一个量级**：
 *
 *     有注解  TS2322: Type '"Var"' is not assignable to type '"Prog"'.
 *             TS2739: Type '{ type: "Prog"; }' is missing the following properties …
 *     无注解  TS2719: … Two different types with this name exist, but they are unrelated.
 *             或者一条把整条 `MergeRules<MergeRules<…>>` 链倒出来的 TS2322
 *
 * 差别在 TS 比的是什么：没有注解时它拿两个**各自实例化**的 `Rules<…>` 去比，
 * 而这份类型里嵌着语言声明的完整形状，于是"不认识自己"；有注解就退化成比节点本身。
 */
export type Rules<F, O, Ctx extends readonly unknown[] = []> = {
  readonly [NT in Nonterminals<F>]?: {
    readonly [P in keyof ProdsOf<F, NT> & string]?: (
      n: RuleInput<F, NT, P>,
      rec: Rec<F, O, Ctx>,
      ...ctx: Ctx
    ) => Ret<O, NT, Ctx>;
  };
};

export interface Pass<F extends LangDecl, O extends LangDecl, Ctx extends readonly unknown[] = []> {
  readonly from: F;
  readonly to: O;
  readonly rules: Rules<F, O, Ctx>;
  /** 往下传 / 往上传几个值。codegen 靠它生成线程代码。 */
  readonly arity: number;
  /** 额外参数的初值（每次 run 一份新的）。 */
  readonly init?: (() => Ctx) | undefined;
  /** 输入语言的入口节点 → 输出语言的入口节点。
   *  extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
   *  所以 pass 作为一个整体依旧是「节点进、节点出」—— extra 在这里被丢掉。 */
  readonly run: (input: NodeOf<F, F["entry"]>) => NodeOf<O, O["entry"]>;
}

export function pass<
  const F extends LangDecl,
  const O extends LangDecl,
  const Ctx extends readonly unknown[] = [],
>(spec: {
  readonly from: F;
  readonly to: O;
  readonly sig?: Sig<Ctx>;
  /** 入口处喂给额外参数的初值。是工厂函数 —— 每次 run 都要一份新的，
   *  否则一个可变的容器（比如环境）会被两次 run 共用。 */
  readonly init?: () => Ctx;
  /**
   * ── `NoInfer` 是这里唯一要紧的一个词（t24）
   *
   * 它是**推断的刹车**：让 TS 只从 `from` / `to` / `sig` 定 `F` / `O` / `Ctx` ——
   * 本来也就只该从这三处定，它们都是**显式写出来的**。
   *
   * 不加会怎样：TS 会从 handler 的**返回位置**去反推输出语言，而那个位置是
   * `Ret<O, NT, Ctx>` = `[NodeOf<O, NT>, …]` —— `NodeOf` 是个映射类型。
   * **反推映射类型**就爆：handler 不写返回注解时直接 TS2589（类型实例化过深）。
   * 而"在 `Program` 上挂一条规则 + 这个 pass 有 `sig`"是最容易触发它的写法，
   * 那偏偏是「扫一遍顶层定义」这种最普通的编译器写法。
   *
   * 起因一直是这个，**跟"语言是六七层 derive 叠出来的"无关** —— 踩过的记录里
   * 把账算在了那条 `MergeRules<…>` 链上。0 层（纯 `language()` 字面量，`Lsrc`）
   * 一样炸，实测过：`scratch/`（复现脚本）里 0/1/2/3/6 层全炸。
   */
  readonly rules: NoInfer<Rules<F, O, Ctx>>;
}): Pass<F, O, Ctx> {
  return {
    from: spec.from,
    to: spec.to,
    rules: spec.rules,
    arity: spec.sig?.arity ?? 0,
    init: spec.init,
    run: () => {
      throw new Error("pass.run 由 codegen 生成");
    },
  };
}
