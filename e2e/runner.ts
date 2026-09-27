/**
 * 把一串 pass 依次跑过去。**未融合**的参考实现。
 *
 * 每个 pass 各自 buildWalker 一次，跑完丢掉。t18 的融合版要跟这个逐字对齐 ——
 * 所以这里刻意写得笨：一步一个遍历，中间树全都真的造出来。
 *
 * 之所以能这么写，是因为 handler 是叶子：框架不需要读 pass 的源码，就能跑。
 * （代价是每节点一次函数调用。那是 t18 要消的东西。）
 */

import {
  buildWalkerDynamic,
  emitFusedGroupRec,
  emitFusedGroupTramp,
  type WalkerSpec,
} from "../src/codegen.ts";
import type { LangDecl } from "../src/lang.ts";
import type { Pass } from "../src/pass.ts";

/**
 * 一步。
 *
 * `from` / `to` 是**字面量**的语言 id（`step()` 从 `Pass` 的 `from`/`to` 类型里取），
 * 不是宽化成 `string`。为什么要这样：`pipeline()` 的**链条校验**要能在类型层比
 * "上一步的 to == 下一步的 from"（见 `e2e/pipeline.ts` 的 `ChainOk`）。
 * 宽成 `string` 的话比什么都是 true，那校验就是摆设。
 *
 * 默认参数 `= string` 让"只当类型用"的地方（`readonly Step[]`）不受影响。
 */
export interface Step<F extends string = string, T extends string = string> {
  readonly name: string;
  readonly from: F;
  readonly to: T;
  /** 往下传 / 往上传几个值。arity > 0 的 pass 不能融合。 */
  readonly arity: number;
  /** 生成器需要的那份形状。融合时要用。 */
  readonly spec: WalkerSpec;
  readonly run: (input: unknown) => unknown;
  /** 生成的遍历器源码 —— 落盘用。 */
  readonly source: string;
  /**
   * 这一步的逻辑**不只**在 `spec` 里，还在 `run` 里（不变点循环、格、可达性分析……）。
   *
   * 为什么必须标出来：融合/蹦床路径会**从 spec 重建**一个 walker 来跑。对普通 pass
   * 那是等价的重建，对手搭的 Step 就不是 —— 重建出来的东西会静默地少做事
   * （踩过：global-dce 在蹦床路径下变成纯 identity，死定义一个都没删）。
   *
   * 所以标了 `opaque` 的步：① 不接受融合 ② 蹦床路径也直接用它自己的 `run`。
   */
  readonly opaque?: true;

  /**
   * 手搭的 Step 想支持"蹦床路径"时提供这个。
   *
   * `mk(spec)` 返回一个按 spec 建出来的 walker（可能是蹦床版）。带上不动点循环、
   * 计数器这些**在 run 里**的东西，就得到了一个等价于 `run` 的、但下树不占原生栈的版本。
   *
   * 为什么不用 `opaque` 一票否决：那条路会退回递归下树，深输入就溢出了
   * （t18 第二块专门消灭过这条限制，不能因为手搭了几个 Step 又还回去）。
   */
  readonly rebuild?: (mk: (spec: unknown) => { run: (n: unknown) => unknown }) => (input: unknown) => unknown;

  /**
   * 这步的形状是"**一个遍历器 + 一层循环**"。
   *
   * 有了它，链接产物就能**自己把这一步拼出来**（遍历器从 spec 生成 + 这里描述的循环），
   * 于是运行期不用再 `new Function` 现编 walker。循环的语义住在 `e2e/loops.ts`，
   * 只有一份；这里只是**参数**（数据，可序列化）。
   */
  readonly loop?: {
    readonly kind: "fixpoint" | "rewrite";
    readonly maxRounds: number;
    /**
     * **每次 run 的一次性准备**，参数是这次的输入。
     *
     * 这一步是链接产物能重建 loop-step 的关键：手搭的 Step 在 `run` 里除了"跑循环"还有别的
     * 每-run 动作 —— 重置计数器、按输入算步数预算、给全局常量传播装环境。产物绕过 `run` 直接
     * 调 walker 的话，这些**全都不会发生**，而且不会报错，只会静默地少做事（踩过：
     * `algebraic-simplify` 的计数器跨 round 累计，小树被判成"改了 1000 步在打转"）。
     *
     * 所以把它做成一个显式钩子：`run` 和产物**都调它**。
     */
    readonly setup?: (input: unknown) => void;
  };
}

/** 把一条 pass 变成可跑的一步。泛型在这里落地，所以调用点有完整类型检查。 */
export function step<F extends LangDecl, O extends LangDecl, Ctx extends readonly unknown[] = []>(
  name: string,
  p: Pass<F, O, Ctx>,
): Step<F["id"], O["id"]> {
  const spec = p as unknown as WalkerSpec;
  /**
   * **惰性**建遍历器。
   *
   * 以前是模块加载时就 `buildWalker(p)` —— 也就是说"装载管线声明"这件事本身要跑 16 次
   * `new Function`。现在生成物由 `pnpm gen` 出（`e2e/__out__/<名字>.pipeline.js`），
   * 运行期走的是产物里的函数，所以这里**不该**在建声明的时候就编代码。
   *
   * 留着这条后路是给**框架自己的测试**用的（那些要拿临时 spec 现建 walker 验 codegen）。
   * 生产路径（tlispi / e2e 的管线断言 / perf）走产物，一次都不会碰到它。
   */
  // 类型是**松的**（`unknown` 进出）：这是 `Step` 这个抽象的要求 —— 一个 step 的语言
  // 只在它自己的 `Pass` 上是已知的，而 `step()` 之后大家统一按 `Step` 用（管线是
  // `Step[]`）。真正的检查在**写 pass 的时候**（`pass()` 的 rules），不在这里。
  let walker: { run: (n: unknown) => unknown } | undefined;
  return {
    name,
    from: p.from.id,
    to: p.to.id,
    arity: p.arity,
    spec,
    run: (input: unknown) => {
      walker ??= buildWalkerDynamic(p);
      return walker.run(input);
    },
    /** 不再在这里生成源码 —— 产物是生成物的唯一来源（见 e2e/link.ts）。 */
    source: "",
  };
}

export interface Stage {
  /** 跑了哪个 pass。第 0 步是输入。 */
  readonly name: string;
  /** 这一步之后是哪门语言。 */
  readonly lang: string;
  readonly ast: unknown;
}

/** 依次跑过去，把每一步的产物都留下。 */
export function runSteps(input: unknown, steps: readonly Step[]): Stage[] {
  const stages: Stage[] = [{ name: "(输入)", lang: "Lsrc", ast: input }];
  let cur = input;
  for (const s of steps) {
    cur = s.run(cur);
    stages.push({ name: s.name, lang: s.to, ast: cur });
  }
  return stages;
}

// ───────────────────────── 融合（G6）─────────────────────────

/**
 * 把一串 pass 切成能融合的组。
 *
 * 能融的条件：**连续、非终结符名字一致、arity 0**。
 * 带 extra 的 pass 会自己控制下降，浅做没法表达，所以是硬栅栏。
 */
export function fuseGroups(steps: readonly Step[]): Step[][] {
  const ntNames = (x: Step): string => Object.keys(x.spec.from.rules).sort().join(",");
  const compatible = (a: Step, b: Step): boolean =>
    a.to === b.from &&
    ntNames(a) === ntNames(b) &&
    a.arity === 0 &&
    b.arity === 0 &&
    // 手搭的 Step 不能融 —— 融出来的 walker 是从 spec 重建的，会丢掉它 run 里的逻辑
    a.opaque !== true &&
    b.opaque !== true;

  const groups: Step[][] = [];
  for (const st of steps) {
    const cur = groups[groups.length - 1];
    if (cur && compatible(cur[cur.length - 1]!, st)) cur.push(st);
    else groups.push([st]);
  }
  return groups;
}

/** 一个融合组的可跑形态。 */
export interface FusedStep {
  readonly name: string;
  /** 这一组里有几门 pass。1 就是没融成。 */
  readonly width: number;
  readonly run: (input: unknown) => unknown;
  readonly source: string;
}

export function compileGroups(groups: readonly Step[][], opts?: { trampoline?: boolean }): FusedStep[] {
  return groups.map((g) => {
    // 单元素组也走蹦床：不然 arity > 0 的 pass 还是递归下树的，深度限制没消掉。
    // 一个 pass 一个组的时候 K > 0 是允许的（多门融的时候才要求 arity 0）。
    const specs = g.map((x) => x.spec);
    // 默认用递归版（快）；要深输入就开弹床版。两条路的输出逐字节相同（e2e 对两条都比）。
    //
    // 单元素组：递归版就是原来的单 pass 生成器（emitWalker，支持 arity）。
    // 多门融的组：arity 必须是 0，两条路都支持。
    const one = g[0]!;
    if (specs.length === 1 && opts?.trampoline !== true) {
      // 单元素组 + 非蹦床：直接用 step() 里已经建好的那个递归 walker。
      return { name: one.name, width: 1, run: one.run, source: one.source };
    }
    if (specs.length === 1 && one.opaque === true && one.rebuild === undefined) {
      // 手搭的 Step 又没给 rebuild：只能用它自己的 run（递归下树，深输入会溢出）。
      // 这不是"静默做错"，是"明确地退回已知的旧限制"。
      return { name: one.name, width: 1, run: one.run, source: one.source };
    }
    const src = opts?.trampoline === true ? emitFusedGroupTramp(specs) : emitFusedGroupRec(specs);
    const build = new Function(`${src}\nreturn build;`)() as (
      handlersList: unknown[],
      init: () => unknown[],
    ) => { run: (n: unknown) => unknown };
    const handlersList = g.map((x) => (x.spec as { rules: unknown }).rules);
    // 单 pass 组要用那个 pass 自己的 init（arity > 0 时 extra 的初值）。
    // 写死成 () => [] 会让 ctx 空的，handler 里拿到的环境就是 undefined。
    const init = (g[0]!.spec as { init?: () => unknown[] }).init ?? (() => []);
    const mk = (spec: unknown): { run: (n: unknown) => unknown } =>
      build([(spec as { rules: unknown }).rules], init);
    return {
      name: g.map((x) => x.name).join("+"),
      width: g.length,
      run:
        one.rebuild !== undefined
          ? one.rebuild(mk)
          : (input: unknown) => build(handlersList, init).run(input),
      source: src,
    };
  });
}

/** 跑融合后的链。 */
/**
 * 这是不是"递归遍历器撞到原生栈上限"？
 *
 * 认两个形态：裸的 RangeError（原生栈直接爆），以及生成了代码里那个 guard **转译过**的
 * 版本 —— 它把 RangeError 换成了一条能看懂的报错，并把 `name` 设成 `StackOverflow`。
 * **靠名字认，不靠匹配报错文本**（文本一改就完，而且是给人看的、本来就该能改）。
 */
export function isStackOverflow(e: unknown): boolean {
  return e instanceof RangeError || (e instanceof Error && e.name === "StackOverflow");
}

export interface SafePipeline {
  /** 逐组跑（`runFused` 直接用这个）。 */
  readonly fused: FusedStep[];
  /** 目前为止兜底在本进程里触发过哪些组（按名字，重复的也算）。 */
  readonly fallbacks: readonly string[];
  resetFallbacks(): void;
}

/**
 * **逐组兜底**：默认走递归（快），某一组溢出就只把那一组换成蹦床版重跑。
 *
 * 为什么是逐组而不是整条管线重跑：融合之后一条管线是十几组，深输入通常只有一组是深的
 * （比如一条长 Call 链会一路穿过 identity 那几组）。整条重跑等于把那十几组白跑一遍。
 *
 * 为什么重跑是安全的：
 *   - `run` 每次都重置 handler 的状态（计数器、环境……），所以重跑不带上一半的状态；
 *   - `finish` / `stampFresh` 都是幂等的（`__lang__` 已经有就不动）；
 *   - pass 不改输入树（只造新节点）。
 *
 * 兜底**只做一次**：蹦床版也溢出（handler 嵌套太深那种，蹦床也占原生栈）就把它的报错
 * 原样抛出去 —— 那条限制是真的，不能假装兜住了。
 */
export function compileGroupsWithFallback(groups: readonly Step[][]): SafePipeline {
  const fallbacks: string[] = [];

  const fused = groups.map((g) => {
    // 递归版（快）和蹦床版（深）都是同一次融合的产物，只是下树方式不同
    const fast = compileGroups([g])[0]!;
    const slow = compileGroups([g], { trampoline: true })[0]!;
    return {
      name: fast.name,
      width: fast.width,
      // 落盘用递归版的源码（那是常态跑的那份）
      source: fast.source,
      run: (input: unknown): unknown => {
        try {
          return fast.run(input);
        } catch (e) {
          if (!isStackOverflow(e)) throw e;
          fallbacks.push(fast.name);
          return slow.run(input);
        }
      },
    };
  });

  return {
    fused,
    fallbacks,
    resetFallbacks: () => {
      fallbacks.length = 0;
    },
  };
}

export function runFused(input: unknown, fused: readonly FusedStep[]): unknown {
  let cur = input;
  for (const f of fused) cur = f.run(cur);
  return cur;
}
