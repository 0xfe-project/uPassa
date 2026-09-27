/**
 * 数据流驱动器（t16）：worklist + 格 + 传递函数，跑到不动点。
 *
 *   const r = solve(cfg, {
 *     bottom: EMPTY,                       // 格的下元素
 *     join: union,                         // 多条前驱进来怎么合并
 *     transfer: (inState, block) => …,     // 一个块的传递函数
 *     eq: sameEnv,                         // **格上的**比较，不是深比较
 *   });
 *
 * ## "变没变"：格上的比较，不是全量深比较
 *
 * 这和 t13 那个不动点驱动器是同一条纪律，但这里的对象是**格元素**而不是整棵 AST ——
 * 格元素天生就小（一个集合、一个常量表），比它便宜。要紧的是别退化成"每轮把整张
 * in/out 表序列化一遍比字符串"：那是 O(块数 × 状态大小) 每轮，而且把"格"这件事扔了
 * （格有高度，到顶就该停；深比较看不出来"到没到顶"）。
 *
 * 所以 `eq` 是**分析自己提供**的（它知道自己的格长什么样）。
 *
 * ## 前向和后向都要
 *
 * 前向（`in[b] = join 前驱的 out`）：到达定值、常量传播这一族。
 * 后向（`out[b] = join 后继的 in`）：**活跃性**就是后向的 —— t17 要用。
 * 两种只差"从哪边取邻居"，所以驱动器一份、方向是个参数。
 *
 * ## 不可达的块不会被访问
 *
 * 它们的前驱集合是空的，永远进不了 worklist，于是 in/out 一直是 `bottom`。
 * 这是对的（"到不了的地方没有信息"），但**用的时候要知道**：别把 bottom 当成
 * "算出来是空集"。t17 的不可达块消除就是拿这个当判据的（配合 `cfg.reachable()`）。
 *
 * ## 上限
 *
 * 格的高度有限的话，单调的传递函数一定会停。停不下来的原因是**分析写错了**
 * （传递函数不单调：把已经知道的东西又变回不知道），那会来回改。所以给一个访问次数上限，
 * 超了报错退出并点名"最后还在改的是哪个块" —— 跟 t11/t13 一个路子：**不终止的失败模式
 * 是挂住**，那个最坏。
 */

import type { Cfg, CfgBlock } from "./cfg.ts";

export class DataflowLimit extends Error {}

export interface DataflowSpec<L> {
  /** 格的下元素（"什么都不知道"）。 */
  readonly bottom: L;
  /** 从多个邻居汇合。前向是 join 前驱，后向是 join 后继。 */
  readonly join: (a: L, b: L) => L;
  /** 一个块的传递函数：入口状态 → 出口状态。 */
  readonly transfer: (inState: L, block: CfgBlock) => L;
  /** 格上的相等。**别写成深比较** —— 见文件头。 */
  readonly eq: (a: L, b: L) => boolean;
  /**
   * 边界上的初始状态。默认是 `bottom`。
   *
   * 边界在哪边取决于方向：**前向是入口块的 in，后向是"没有后继的那些块"的 out**。
   * （一开始我把这里写死成"入口块"，于是后向分析里入口被特判掉、整张图全算成底 ——
   * 后向分析的边界根本不在入口那块。）
   */
  readonly boundary?: L;
  /** 方向。默认前向。 */
  readonly direction?: "forward" | "backward";
}

export interface DataflowResult<L> {
  readonly inOf: ReadonlyMap<string, L>;
  readonly outOf: ReadonlyMap<string, L>;
  /** 处理过多少次块（worklist 弹出计数）。 */
  readonly visits: number;
  /** 有多少次块的 (in, out) 真的变了。 */
  readonly updates: number;
}

/**
 * 跑到不动点。
 *
 * 注意 `visits` 和 `updates` 是分开报的：worklist 里同一个块可能被处理多次，
 * "处理了几次"和"改了几次"是两件事 —— 断言的时候用 `updates` 更稳（它跟遍历顺序无关）。
 */
export function solve<L>(cfg: Cfg, spec: DataflowSpec<L>, opts?: { maxVisits?: number }): DataflowResult<L> {
  const maxVisits = opts?.maxVisits ?? 1_000_000;
  const forward = (spec.direction ?? "forward") === "forward";
  const entry = cfg.unit.entry;
  const boundary = spec.boundary ?? spec.bottom;

  const inOf = new Map<string, L>();
  const outOf = new Map<string, L>();
  for (const b of cfg.unit.blocks) {
    inOf.set(b.label, spec.bottom);
    outOf.set(b.label, spec.bottom);
  }

  // worklist 用**队列**（先进先出）。用 Set 去重，但保持插入顺序 —— 顺序确定，
  // 结果才是确定的（同一个 CFG 跑两遍，"改了几次"也一样）。
  const queued = new Set<string>();
  const queue: string[] = [];
  const push = (label: string): void => {
    if (queued.has(label)) return;
    queued.add(label);
    queue.push(label);
  };

  // 种子：**前向从入口开始，后向从"没有后继的块"开始**。
  //
  // 后向要是也从入口开始，第一趟就没有任何块会变（入口的 out 汇合到的是还没算过的
  // bottom），于是工作列表立刻空掉、整张图全是底 —— 看起来"收敛了"，其实什么都没算。
  const seeds = forward
    ? [entry]
    : cfg.unit.blocks.filter((b) => cfg.succ(b.label).length === 0).map((b) => b.label);
  for (const l of seeds) push(l);

  let visits = 0;
  let updates = 0;
  let lastChanged = seeds[0] ?? entry;
  // **不要用 `queue.shift()`** —— 它是 O(数组长度)，n 个块就是 O(n²)。
  // 用游标往前推，越过的部分定期收掉（不然长跑会一直占着内存）。
  let head = 0;

  while (head < queue.length) {
    const label = queue[head++]!;
    queued.delete(label);
    if (head > 4096) {
      queue.splice(0, head); // 均摊 O(1)：前缀整段丢掉
      head = 0;
    }
    visits += 1;
    if (visits > maxVisits) {
      throw new DataflowLimit(
        `[dataflow] 访问了 ${maxVisits} 次还没到不动点 —— 停不下来。\n` +
          `  最后还在改的是块 ${lastChanged}。\n` +
          `  多半是传递函数不单调（把已经知道的信息又变回不知道了）—— ` +
          `格的高度有限的话，单调的传递函数一定会停。`,
      );
    }

    // 前向：入口状态来自前驱的出口；后向：出口状态来自后继的入口
    const neighbors = forward ? cfg.pred(label) : cfg.succ(label);
    // 边界：前向是入口块的 in；后向是"没有后继的块"（Ret）的 out
    const atBoundary = forward ? label === entry : neighbors.length === 0;
    let merged: L | undefined = atBoundary ? boundary : undefined;
    for (const n of neighbors) {
      const v = forward ? outOf.get(n) : inOf.get(n);
      if (v === undefined) continue;
      merged = merged === undefined ? v : spec.join(merged, v);
    }
    if (merged === undefined) merged = spec.bottom;

    const oldIn = inOf.get(label)!;
    const oldOut = outOf.get(label)!;
    if (forward) {
      const newIn = merged;
      const newOut = spec.transfer(newIn, cfg.block(label));
      if (!spec.eq(newIn, oldIn) || !spec.eq(newOut, oldOut)) {
        inOf.set(label, newIn);
        outOf.set(label, newOut);
        updates += 1;
        lastChanged = label;
        for (const s of cfg.succ(label)) push(s);
      }
    } else {
      const newOut = merged;
      const newIn = spec.transfer(newOut, cfg.block(label));
      if (!spec.eq(newIn, oldIn) || !spec.eq(newOut, oldOut)) {
        inOf.set(label, newIn);
        outOf.set(label, newOut);
        updates += 1;
        lastChanged = label;
        for (const p of cfg.pred(label)) push(p);
      }
    }
  }

  return { inOf, outOf, visits, updates };
}
