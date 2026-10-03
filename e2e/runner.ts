/**
 * 把一串 pass 依次跑过去。**未融合**的参考实现。
 *
 * 每个 pass 各自 buildWalker 一次，跑完丢掉。t18 的融合版要跟这个逐字对齐 ——
 * 所以这里刻意写得笨：一步一个遍历，中间树全都真的造出来。
 *
 * 之所以能这么写，是因为 handler 是叶子：框架不需要读 pass 的源码，就能跑。
 * （代价是每节点一次函数调用。那是 t18 要消的东西。）
 */

import { buildWalkerDynamic, emitWalkerTramp, type WalkerSpec } from "../src/nanopass/codegen.ts";
import type { LangDecl } from "../src/nanopass/lang.ts";
import type { Pass } from "../src/nanopass/pass.ts";

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

// ───────────────────────── 逐 pass 兜底 ─────────────────────────

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

export interface SafeStep {
  readonly name: string;
  readonly run: (input: unknown) => unknown;
}

export interface SafePipeline {
  /** 逐 pass 跑（`runSafe` 直接用这个）。 */
  readonly steps: readonly SafeStep[];
  /** 目前为止兜底在本进程里触发过哪些 pass（按名字，重复的也算）。 */
  readonly fallbacks: readonly string[];
  resetFallbacks(): void;
}

/**
 * **逐 pass 兜底**：默认走递归遍历器（快），哪一门溢出了就**只把那一门**换成蹦床版重跑。
 *
 * 为什么是逐 pass 而不是整条管线重跑：深输入通常只有几门是深的（一条长 Call 链会一路
 * 穿过所有认领它的 pass）。整条重跑等于把前面十几门白跑一遍。
 *
 * 为什么重跑是安全的：
 *   - `run` 每次都重置 handler 的状态（计数器、环境……），所以重跑不带上一半的状态；
 *   - `finish` / `stampFresh` 都是幂等的（`__lang__` 已经有就不动）；
 *   - pass 不改输入树（只造新节点）。
 *
 * 兜底**只做一次**：蹦床版也溢出（handler 嵌套太深那种，蹦床也占原生栈）就把它的报错
 * 原样抛出去 —— 那条限制是真的，不能假装兜住了。
 *
 * ── 蹦床版是**惰性**建的
 *
 * 常态路径一次都不该碰它 —— `emitWalkerTramp` 出来的源码要 `new Function` 编一遍。
 * 没溢出就不编。
 */
export function compileStepsWithFallback(steps: readonly Step[]): SafePipeline {
  const fallbacks: string[] = [];

  /** 把一份 spec 编成蹦床版遍历器。 */
  const mkTramp = (spec: unknown): { run: (n: unknown) => unknown } => {
    const src = emitWalkerTramp(spec as WalkerSpec);
    const build = new Function(`${src}\nreturn build;`)() as (
      handlers: unknown,
      init: () => unknown[],
    ) => { run: (n: unknown) => unknown };
    const sp = spec as { rules: unknown; init?: () => unknown[] };
    return build(sp.rules, sp.init ?? (() => []));
  };

  const out = steps.map((st) => {
    // 手搭的 Step（rewrite / fixpoint）给了 `rebuild` 的话，让它自己把"循环 + 蹦床遍历器"
    // 拼起来；没给就只能退回它自己的 `run`（递归下树，深输入会溢出 —— 那不是静默做错，
    // 是明确地退回已知的旧限制）。
    let slow: ((input: unknown) => unknown) | undefined;
    const getSlow = (): ((input: unknown) => unknown) => {
      slow ??=
        st.rebuild !== undefined ? st.rebuild(mkTramp) : (input: unknown) => mkTramp(st.spec).run(input);
      return slow;
    };

    return {
      name: st.name,
      run: (input: unknown): unknown => {
        try {
          return st.run(input);
        } catch (e) {
          if (!isStackOverflow(e)) throw e;
          fallbacks.push(st.name);
          return getSlow()(input);
        }
      },
    };
  });

  return {
    steps: out,
    fallbacks,
    resetFallbacks: () => {
      fallbacks.length = 0;
    },
  };
}

/** 依次跑过去。 */
export function runSafe(input: unknown, safe: SafePipeline): unknown {
  let cur = input;
  for (const s of safe.steps) cur = s.run(cur);
  return cur;
}
