/**
 * 这条管线的定义 —— 唯一的。`run.ts`（e2e 断言）和 `tlispi.ts`（交互）都用它。
 *
 * 顺序是人写的。加一个 pass 只改这里。
 */

import { dce } from "./passes/dce.L7.pass.ts";
import { constProp } from "./passes/const-prop.L6.pass.ts";
import { constantFold } from "./passes/constant-fold.L6.pass.ts";
import { globalConst } from "./passes/global-const.L6.pass.ts";
import { globalDce } from "./passes/global-dce.L7.pass.ts";
import { algebraicSimplify } from "./passes/algebraic-simplify.L6.pass.ts";
import { refineRepr } from "./passes/refine-repr.Lnum->Lsrc.pass.ts";
import { desugarDefFun } from "./passes/desugar-def-fun.Lsrc->L1.pass.ts";
import { expandLetStar } from "./passes/expand-let-star.L4->L5.pass.ts";
import { normalizeBegin } from "./passes/normalize-begin.L6.pass.ts";
import { normalizePrimArity } from "./passes/normalize-prim-arity.L6.pass.ts";
import { removeAndOrNot } from "./passes/remove-and-or-not.L3->L4.pass.ts";
import { removeCond } from "./passes/remove-cond.L2->L3.pass.ts";
import { removeOneArmedIf } from "./passes/remove-one-armed-if.L5->L6.pass.ts";
import { removeWhenUnless } from "./passes/remove-when-unless.L1->L2.pass.ts";
import { uncoverFree } from "./passes/uncover-free.L6->L7.pass.ts";
import { runSteps, step, type Step } from "./runner.ts";

// ───────────────────────── 类型层：链条 ─────────────────────────
//
// `Step` 的 `from`/`to` 是**字面量**的 id（见 runner.ts 的注释），所以这里能真的比
// "上一步的 to == 下一步的 from"。宽成 `string` 的话比什么都是 true，校验就是摆设。

type Eq<A extends string, B extends string> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** 链条：每一步的 `to` 必须等于下一步的 `from`。 */
type ChainOk<S extends readonly Step[]> = S extends readonly []
  ? true
  : S extends readonly [infer H extends Step, ...infer T extends readonly Step[]]
    ? T extends readonly []
      ? true
      : T extends readonly [infer N extends Step, ...infer _]
        ? Eq<H["to"], N["from"]> extends true
          ? ChainOk<T>
          : false
        : false
    : false;

/** 链断了的时候给出的报错类型 —— 读到这句就知道怎么修。 */
type BrokenChain = {
  readonly "pass chain broken: 每一步的 to 必须等于下一步的 from（顺序是人写的，别猜）": never;
};

/**
 * 一条**有名字**的管线。
 *
 * 为什么要名字：entry 可能有 N 个，一条 entry 一条链 —— 链接产物是
 * `<名字>.pipeline.js`，没有一个名字就没法给产物命名。所以管线不是一堆散 steps，
 * 而是一个带名字的东西（现在是第一条，将来可能是第 N 条）。
 */
export interface Pipeline<S extends readonly Step[]> {
  readonly name: string;
  readonly steps: S;
  /** 入口语言 id（第一步的 from）。 */
  readonly entry: string;
  /** 出口语言 id（最后一步的 to）。 */
  readonly exit: string;
  /** 自述：给人看，也给生成物用（`*.pipeline.js` 里的 `export const steps`）。 */
  describe(): {
    readonly name: string;
    readonly entry: string;
    readonly exit: string;
    readonly steps: readonly { name: string; from: string; to: string }[];
  };
}

export function pipeline<const S extends readonly Step[]>(
  name: string,
  steps: S & (ChainOk<S> extends true ? unknown : BrokenChain),
): Pipeline<S> {
  if (steps.length === 0) throw new Error(`[pipeline ${name}] 一条空管线`);
  return {
    name,
    steps,
    entry: steps[0]!.from,
    exit: steps[steps.length - 1]!.to,
    describe: () => ({
      name,
      entry: steps[0]!.from,
      exit: steps[steps.length - 1]!.to,
      steps: steps.map((x) => ({ name: x.name, from: x.from, to: x.to })),
    }),
  };
}

/** 唯一的这条管线。 */
export const MAIN = pipeline("main", [
  // 字面量细分：Lnum 的笼统 Num → Lsrc 的 Int / Float。**第一件事** —— 后面的 pass
  // 全都按"字面量已经分好种类"来写（constant-fold 就不许把 Int 折成 Float）。
  step("refine-repr", refineRepr),
  step("desugar-def-fun", desugarDefFun),
  step("remove-when-unless", removeWhenUnless),
  step("remove-cond", removeCond),
  step("remove-and-or-not", removeAndOrNot),
  step("expand-let-star", expandLetStar),
  step("remove-one-armed-if", removeOneArmedIf),
  // 下面几条是同语言（from === to）—— 优化层里这是主模式
  step("normalize-begin", normalizeBegin),
  // 代数化简放在 normalize-prim-arity **之前**：它的正规形是"展平、排序的 n 元 +/*"，
  // 二值化交给 normalize-prim-arity 干。顺序反了就没机会展平了。
  // 又放在 const-prop / constant-fold 之前：先把结构理干净（x*1 → x、x*2 → x+x、展平排序），
  // 折叠再去清它露出来的字面量。
  algebraicSimplify,
  step("normalize-prim-arity", normalizePrimArity),
  step("const-prop", constProp),
  // 全局常量传播：跑不动点，推顶层定义之间的链（t14）。放在 constant-fold **之前**
  // —— 它代换出来的字面量正好交给折叠清掉。
  globalConst,
  step("constant-fold", constantFold),
  step("uncover-free", uncoverFree),
  step("dce", dce),
  // 全局 DCE：从 body 出发算可达性，删掉没人引用的顶层定义（t14）
  globalDce,
]);

/**
 * 所有管线 —— 链接器按这个列表一条一条生成 `<名字>.pipeline.js`。
 *
 * 现在只有一条，但**别把它当成"只有一条"**：entry 可以有 N 个，`pipeline()` 就是
 * 让它能长出第二条来的那个东西（文件名、自述、产物都按名字走）。
 */
export const PIPELINES: readonly Pipeline<readonly Step[]>[] = [MAIN];

/** 兼容旧叫法：跑的时候要的是 steps。 */
export const PIPELINE_STEPS: Step[] = [...MAIN.steps];

// 跑管线这件事挪去 e2e/linked.ts（走链接产物）。这个文件只管**声明**：
// 步骤、顺序、链条校验、以及给链接器看的自述。
