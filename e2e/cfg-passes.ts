/**
 * CFG 上的第一批 pass（t17）。
 *
 * 四条：块排序、不可达块消除、跳转穿线、活跃性分析。
 *
 * ## 为什么它们不是 `pass()`
 *
 * 因为它们要的不是"一棵树的形状"，是**整张图**：排序要按可达性排，消除要知道谁能到谁，
 * 穿线要顺着跳转链走，活跃性要前驱/后继 + 不动点。这些信息 `Cfg` 有、单个节点没有。
 *
 * 所以这里的签名是 `(prog) → prog` —— 进 `CfgProgram`，出来一张新图。
 * **框架在这层给的东西是 `Cfg`**（t16b 那张前驱/后继表），不是 `rec`。
 * 这是"图遍历模型"真正的落点：树遍历的默认动作是"顺着字段递归"，图遍历的默认动作是
 * "看邻居"。
 *
 * ## 每一条都在动"哪些块在、怎么连"
 *
 * 这四条彼此有关：消除会造出新的悬空跳转（被删的块原来指向谁），穿线会缩短链，
 * 排序会改块在列表里的位置（但**不改跳转** —— 跳转是标号引用，位置无关）。
 * 所以顺序上：先消除、再穿线、最后排序。写在 `cleanCfg` 里。
 */

import { buildCfg, type Cfg, type CfgBlock, type CfgProg, type CfgUnit } from "./cfg.ts";
import { solve, type DataflowSpec } from "./dataflow.ts";

/** 一个 CFG 级的 pass：进程序、出程序。 */
export type CfgPass = (prog: CfgProg) => CfgProg;

// ───────────────────────── ① 块排序 ─────────────────────────

/**
 * 把每个 unit 的块按**从入口出发的广度优先序**排，入口一定在第一个。
 *
 * 为什么值得做：块的物理顺序影响后面每个分析/代码生成的局部性（相邻的块在一起，
 * 分支的两条边都往"前面"跳的情况就少）。而且它让输出**确定**：不管降低时按什么顺序
 * 造块，排完之后一样。
 *
 * 不可达的块排到**最后**（保持相对顺序）—— 它们还在列表里（不在这里删，删是下一条的事），
 * 但不会挡住可达块的顺序。
 */
export const orderBlocks: CfgPass = (prog) => {
  const cp = buildCfg(prog);
  return {
    ...prog,
    units: prog.units.map((u) => {
      const cfg = cp.cfg(u.name);
      const seen = new Set<string>();
      const order: string[] = [];
      const queue = [u.entry];
      seen.add(u.entry);
      while (queue.length > 0) {
        const l = queue.shift()!;
        order.push(l);
        for (const s of cfg.succ(l)) {
          if (!seen.has(s)) {
            seen.add(s);
            queue.push(s);
          }
        }
      }
      const byLabel = new Map(u.blocks.map((b) => [b.label, b] as const));
      const head = order.map((l) => byLabel.get(l)!);
      const tail = u.blocks.filter((b) => !seen.has(b.label)); // 不可达的，保持原相对顺序
      return { ...u, blocks: [...head, ...tail] };
    }),
  };
};

// ───────────────────────── ② 不可达块消除 ─────────────────────────

/**
 * 删掉从入口到不了的块。
 *
 * 判据是 `Cfg.reachable()` —— **不是**"没有前驱"。两个不一样：一个块可能有前驱，
 * 但它的前驱自己不可达（一串死块），它照样是死的。所以必须真的从入口走一遍。
 *
 * 入口不会连带被删（它自己就是起点），所以删完还剩至少一个块。
 */
export const removeUnreachable: CfgPass = (prog) => {
  const cp = buildCfg(prog);
  return {
    ...prog,
    units: prog.units.map((u) => {
      const live = cp.cfg(u.name).reachable();
      const kept = u.blocks.filter((b) => live.has(b.label));
      // 入口一定在可达集里（reachable 从它出发），所以这里不该为空
      return { ...u, blocks: kept.length > 0 ? kept : u.blocks.slice(0, 1) };
    }),
  };
};

// ───────────────────────── ③ 跳转穿线 ─────────────────────────

/**
 * 跳转链压直：`b0 → b1 → b2` 里如果 `b1` 只是"跳一下"（没有语句、终结子就是 Jump），
 * 就把 `b0` 直接指到 `b2`。
 *
 * **为什么要迭代**：链可以很长（`a→b→c→…→z`），压一次只短一格。所以沿着链一路走到底
 * （用一个 visited 集合防死循环 —— 纯粹的跳转环 `a→b→a` 是可能的，那就别动）。
 *
 * 只穿**空**块：有语句的块不能跳过（它有副作用 —— 这个语言没有，但赋值会改变活跃性，
 * 跳过会算错），有 Branch/Ret 的更不能。
 */
export const threadJumps: CfgPass = (prog) => {
  const cp = buildCfg(prog);

  /** 从 label 出发，一路穿过空跳转块，最终落在哪。 */
  /**
   * 从 label 出发，一路穿过空跳转块，最终落在哪。
   *
   * 撞上环（`a→b→a` 这种纯跳转环）就**原样还回去**，不压。压成自环语义上一样
   * （都是死循环），但那是个没意义的改写，而且会让"穿线之后再穿一次"的结果不一样。
   * 保守：看得懂的都别动。
   */
  //
  // **记忆化**：一条长空链 `b0→b1→…→bn` 里，每个块都问一遍"穿过我去哪"就是 O(n²)。
  // 算完一个记下来，再问就是 O(1)。链上的块要么都被走过一次、要么直接被判成环。
  const memo = new Map<string, string>();
  const resolve = (cfg: Cfg, start: string): string => {
    const cached = memo.get(start);
    if (cached !== undefined) return cached;
    const path: string[] = [];
    const onPath = new Set<string>([start]);
    let cur = start;
    let result: string;
    for (;;) {
      const cachedCur = memo.get(cur);
      if (cachedCur !== undefined) {
        result = cachedCur;
        break;
      }
      const b = cfg.block(cur);
      if (b.stmts.length > 0 || b.term.type !== "Jump") {
        result = cur;
        break;
      }
      const next = b.term.target;
      if (onPath.has(next)) {
        result = start; // 环：别动
        path.length = 0; // 环上的块不记（记了会把它自己判成"能穿"）
        break;
      }
      path.push(cur);
      onPath.add(next);
      cur = next;
    }
    for (const l of path) memo.set(l, result);
    memo.set(start, result);
    return result;
  };

  return {
    ...prog,
    units: prog.units.map((u) => {
      const cfg = cp.cfg(u.name);
      const blocks: CfgBlock[] = u.blocks.map((b) => {
        const term = b.term;
        if (term.type === "Jump") {
          const to = resolve(cfg, term.target);
          return to === term.target ? b : { ...b, term: { type: "Jump", target: to } };
        }
        if (term.type === "Branch") {
          const thenTo = resolve(cfg, term.then);
          const altTo = resolve(cfg, term.alt);
          if (thenTo === term.then && altTo === term.alt) return b;
          return { ...b, term: { ...term, then: thenTo, alt: altTo } };
        }
        return b;
      });
      // 入口如果是空跳转块，不能穿（入口是入口）；但它的 target 可以指向别处 —— 不动
      void cfg;
      return { ...u, blocks };
    }),
  };
};

// ───────────────────────── ④ 活跃性分析 ─────────────────────────

export interface Liveness {
  readonly liveIn: ReadonlyMap<string, ReadonlySet<string>>;
  readonly liveOut: ReadonlyMap<string, ReadonlySet<string>>;
  readonly visits: number;
}

/**
 * 一个块里**先用后写**的名字（局部活跃性）。
 *
 * 顺序要紧：先出现的"用"算用，之后出现的"写"才把名字从 use 里去掉。
 * 一个块里 `x = x + 1` 是"用 x、然后写 x" —— 它不是 use-before-def。
 */
function useIn(block: CfgBlock): Set<string> {
  const use = new Set<string>();
  const def = new Set<string>();
  const atom = (a: unknown): void => {
    const work: unknown[] = [a];
    while (work.length > 0) {
      const x = work.pop() as {
        type?: string;
        name?: string;
        args?: unknown[];
        fn?: unknown;
        free?: string[];
      };
      if (x === null || typeof x !== "object") continue;
      switch (x.type) {
        case "AVar":
          if (!def.has(x.name!)) use.add(x.name!);
          break;
        case "ALam":
          // **捕获的变量在创建 lambda 的地方就算用到了** —— 真做闭包转换时它们要被打包
          for (const f of x.free ?? []) if (!def.has(f)) use.add(f);
          break;
        case "APrim":
          for (const y of x.args ?? []) work.push(y);
          break;
        case "ACall":
          work.push(x.fn);
          for (const y of x.args ?? []) work.push(y);
          break;
        default:
          break;
      }
    }
  };
  for (const st of block.stmts) {
    atom(st.value);
    def.add(st.name);
  }
  if (block.term.type === "Branch") atom(block.term.cond);
  if (block.term.type === "Ret") atom(block.term.value);
  return use;
}

/**
 * 每个块的 live-in / live-out。
 *
 * 经典方程（后向）：
 *
 *     live-out[b] = ⋃ live-in[后继]
 *     live-in[b]  = use[b] ∪ (live-out[b] \ def[b])
 *
 * 用 t16c 那个驱动器跑（**后向**），join 是并集，底是空集。收敛性：格是"名字集合的
 * 子集格"，高度 = 名字数，单调的传递函数一定会停。
 */
export function liveness(u: CfgUnit): Liveness {
  const cfg = buildCfg({ type: "Prog", units: [u] } as CfgProg).cfg(u.name);

  // 每个块预先算好 use / def（进出 worklist 时不重算）
  const useOf = new Map<string, Set<string>>();
  const defOf = new Map<string, Set<string>>();
  for (const b of u.blocks) {
    useOf.set(b.label, useIn(b));
    const d = new Set<string>();
    for (const st of b.stmts) d.add(st.name);
    defOf.set(b.label, d);
  }

  type S = ReadonlySet<string>;
  const join = (a: S, b: S): S => (a.size === 0 ? b : b.size === 0 ? a : new Set([...a, ...b]));
  const eq = (a: S, b: S): boolean => a.size === b.size && [...a].every((x) => b.has(x));

  const spec: DataflowSpec<S> = {
    bottom: new Set<string>(),
    direction: "backward",
    join,
    eq,
    // 后向：传进去的是 out，出来的是 in ——  `in = use ∪ (out \ def)`
    transfer: (out, b) => {
      const res = new Set(useOf.get(b.label)!);
      for (const x of out) if (!defOf.get(b.label)!.has(x)) res.add(x);
      return res;
    },
  };
  const r = solve(cfg, spec);
  return { liveIn: r.inOf, liveOut: r.outOf, visits: r.visits };
}

// ───────────────────────── 串起来 ─────────────────────────

/**
 * 四条按顺序跑：**消除 → 穿线 → 再消除 → 排序**。
 *
 * 最后那次消除是必须的（踩到过）：**穿线会把被它跳过的块晾在那儿变成死块**。
 * `b0→b1→b3` 压成 `b0→b3` 之后，`b1` 就没人指向了 —— 但它在第一次消除的时候还是
 * 可达的。所以穿完得再扫一遍，不然输出里留着一堆孤块（而且 `cleanCfg` 不幂等：
 * 第二遍才会把它们删掉）。
 *
 * 排序放最后：它只是个局部性/确定性的整理，块的数量得先定下来。
 */
export const cleanCfg: CfgPass = (prog) =>
  orderBlocks(removeUnreachable(threadJumps(removeUnreachable(prog))));
