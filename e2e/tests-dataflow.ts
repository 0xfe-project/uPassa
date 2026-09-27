/**
 * t16 的验收（后半）：数据流驱动器。
 *
 *  ③ 能收敛到不动点（并断言次数与手算一致）
 *
 * 另外几条是这个驱动器自己的性质，单独钉：
 *  - "变没变"用的是**格上的比较**，不是深比较（反例：格元素相等但对象不同时也判相等）
 *  - 后向分析也能跑（活跃性要用）
 *  - 不单调的传递函数 → 超上限**报错退出**，并点名最后还在改的块
 *  - 不可达的块不进 worklist，留在 bottom
 *  - 确定性：同一个 CFG 跑两遍，次数一样
 */

import { buildCfg, type CfgProg } from "./cfg.ts";
import { DataflowLimit, solve, type DataflowSpec } from "./dataflow.ts";

export type Check = (name: string, ok: boolean, detail?: string) => void;

type Block = { type: "Block"; label: string; stmts: unknown[]; term: unknown };
type State = ReadonlyMap<string, number>;

const EMPTY: State = new Map();
const AInt = (v: number): unknown => ({ type: "AInt", value: v });
const AVar = (n: string): unknown => ({ type: "AVar", name: n });

const block = (label: string, stmts: unknown[], term: unknown): Block =>
  ({ type: "Block", label, stmts, term }) as unknown as Block;

function progOf(blocks: Block[], entry: string): CfgProg {
  return {
    type: "Prog",
    units: [{ type: "Unit", name: "u", params: [], entry, blocks }],
  } as unknown as CfgProg;
}

/** 含**回边**的 CFG：迭代是必要的，不然"b1 的 in"永远看不到自己上一轮的结果。 */
function loopCfg(): CfgProg {
  return progOf(
    [
      block("b0", [{ type: "Assign", name: "t", value: AInt(1) }], { type: "Jump", target: "b1" }),
      block(
        "b1",
        [{ type: "Assign", name: "u", value: { type: "APrim", op: "+", args: [AVar("t"), AInt(1)] } }],
        { type: "Branch", cond: { type: "ABool", value: true }, then: "b1", alt: "b2" },
      ),
      block("b2", [], { type: "Ret", value: AVar("u") }),
    ],
    "b0",
  );
}

/** "可能已知是常量的名字"。join = 并集（may 分析），底 = 空表。 */
const MAY_CONST: DataflowSpec<State> = {
  bottom: EMPTY,
  join: (a, b) => {
    const out = new Map(a);
    for (const [k, v] of b) if (!out.has(k)) out.set(k, v);
    return out;
  },
  eq: (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v),
  transfer: (s, b) => {
    const out = new Map(s);
    for (const st of b.stmts as {
      name: string;
      value: { type: string; op?: string; args?: unknown[]; value?: number };
    }[]) {
      const v = st.value;
      if (v.type === "AInt") out.set(st.name, v.value as number);
      else if (v.type === "APrim" && v.op === "+") {
        const ns = (v.args ?? []).map((a) => {
          const x = a as { type: string; name?: string; value?: number };
          return x.type === "AInt" ? x.value : x.name !== undefined ? out.get(x.name) : undefined;
        });
        if (ns.every((n) => typeof n === "number")) out.set(st.name, (ns[0] as number) + (ns[1] as number));
      } else out.delete(st.name);
    }
    return out;
  },
};

const show = (s: State): string =>
  [...s.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join(",") || "∅";

export function dataflowChecks(check: Check): void {
  const cfg = buildCfg(loopCfg()).cfg("u");

  // ── ③ 收敛到不动点，而且次数与手算一致
  //
  // 手算（worklist 是队列、先进先出）。**in 或 out 任一变就算一次改动**：
  //
  //   b0: in=∅         out={t=1}       改 1     ← 推出 b1
  //   b1: in={t=1}     out={t=1,u=2}   改 2     ← 推出 b1、b2
  //   b1: in={t=1,u=2} out={t=1,u=2}   改 3     ← **回边这一趟就是"迭代"本身**：
  //                                               in 变了（多了 u=2），out 没变
  //   b2: in={t=1,u=2} out={t=1,u=2}   改 4
  //   b2: 再来一次（上面那次 in 变了又推了一遍），不变
  // → updates = 4，visits = 5
  {
    const r = solve(cfg, MAY_CONST);
    check(
      "③ 收敛到不动点：b1 的 in 拿到了回边带过来的 {t=1,u=2}",
      show(r.inOf.get("b1")!) === "t=1,u=2",
      show(r.inOf.get("b1")!),
    );
    check("③ 改动次数与手算一致（4 次）", r.updates === 4, `updates=${r.updates}`);
    check("③ 处理次数手算一致（5 次）", r.visits === 5, `visits=${r.visits}`);
    check(
      "③ 不动点：再跑一遍一次都不改",
      solve(cfg, MAY_CONST).updates === 4 && solve(cfg, MAY_CONST).visits === 5,
      "重复跑不受影响",
    );
    // 出口也要对
    check("③ b2 的 in 就是 b1 的 out", show(r.inOf.get("b2")!) === "t=1,u=2", show(r.inOf.get("b2")!));
  }

  // ── "变没变"用格上的比较：`eq` 说相等，对象不同也算相等
  //
  //    反例：join 每次返回**新对象**（哪怕内容一样）。如果驱动器用引用比较，它会认为
  //    一直在变、跑到上限；用 `eq` 就会立刻停。
  {
    const alwaysNew: DataflowSpec<State> = {
      ...MAY_CONST,
      join: (a, b) => new Map([...a, ...b]), // 每次都是新对象
    };
    const r = solve(cfg, alwaysNew);
    check(
      "反例：join 每次给新对象也只改 4 次（说明比的是格元素不是引用）",
      r.updates === 4,
      `updates=${r.updates}`,
    );
  }

  // ── 后向方向：活跃性那种"从后继往回看"的分析
  {
    // "从这儿能走到 Ret 吗"（or-join，底 = false）
    const reachesRet = solve<boolean>(cfg, {
      bottom: false,
      direction: "backward",
      join: (a, b) => a || b,
      eq: (a, b) => a === b,
      transfer: (out, b) => b.term.type === "Ret" || out,
    });
    // 看的是 **in**：后向分析里 `out[b]` 是"从后继汇合来的"，`in[b] = transfer(out[b], b)`
    // 才是"从 b 出发能不能到 Ret"。
    check(
      "后向：所有块都能到 Ret",
      ["b0", "b1", "b2"].every((l) => reachesRet.inOf.get(l) === true),
      ["b0", "b1", "b2"].map((l) => `${l}=${String(reachesRet.inOf.get(l))}`).join(" "),
    );

    // 后向 + 一个到不了 Ret 的块
    const split = buildCfg(
      progOf(
        [
          block("e", [], { type: "Jump", target: "a" }),
          block("a", [], { type: "Ret", value: AInt(1) }),
          // 自环，永远不会到 Ret
          block("spun", [], { type: "Jump", target: "spun" }),
        ],
        "e",
      ),
    ).cfg("u");
    const r2 = solve<boolean>(split, {
      bottom: false,
      direction: "backward",
      join: (a, b) => a || b,
      eq: (a, b) => a === b,
      transfer: (out, b) => b.term.type === "Ret" || out,
    });
    check("后向：自环那一块到不了 Ret", r2.inOf.get("spun") === false, String(r2.inOf.get("spun")));

    // **判别用例**：后向的边界是"**没有后继**的块"，不是入口。
    //
    // 这条用例必须用**非底**的 boundary，不然测不出东西 —— 而且这本身就是个值得记住的
    // 事实：`boundary` 默认就是 `bottom`，这时候"边界块用 boundary 起头"和"没有后继 →
    // 汇合结果落回 bottom"**给出同一个值**。所以边界判断退化了，只要 boundary === bottom
    // 就永远看不出来（实测：把 `atBoundary` 改成只认入口，整个 e2e 全绿）。
    //
    // 上面那两条后向用例（`transfer` 里自己检查 `term.type === "Ret"`）也测不出 ——
    // 边界的影响被 transfer 重新推导了一遍，掩盖掉了。
    //
    // 这里：boundary = true，transfer 是**恒等**（不重新推导任何东西）。于是
    //   "从 b 出发能走到一个没有后继的块吗" 完全由边界决定。
    const twoRets = buildCfg(
      progOf(
        [
          block("b0", [], { type: "Branch", cond: AVar("c"), then: "b1", alt: "b2" }),
          block("b1", [], { type: "Ret", value: AInt(1) }),
          block("b2", [], { type: "Ret", value: AInt(2) }),
        ],
        "b0",
      ),
    ).cfg("u");
    const reachesExit = solve<boolean>(twoRets, {
      bottom: false,
      boundary: true, // ← 关键：非底边界
      direction: "backward",
      join: (x, y) => x || y,
      eq: (x, y) => x === y,
      transfer: (out) => out, // 恒等：不重新推导
    });
    check(
      "后向：**两个 Ret** 时，两个 Ret 自己都是出口（边界是「没有后继」，不是入口）",
      reachesExit.outOf.get("b1") === true && reachesExit.outOf.get("b2") === true,
      `out: b0=${String(reachesExit.outOf.get("b0"))} b1=${String(reachesExit.outOf.get("b1"))} b2=${String(reachesExit.outOf.get("b2"))}`,
    );
    check(
      "后向：入口也能走到出口（两个后继都能）",
      reachesExit.inOf.get("b0") === true,
      `in[b0]=${String(reachesExit.inOf.get("b0"))}`,
    );

    // 前向对照：同一个 CFG，前向的边界**就是**入口 —— 这条该绿。
    // 用来证明上面那条不是因为"哪里写死了"才绿的。
    const fwd = solve<boolean>(twoRets, {
      bottom: false,
      boundary: true,
      direction: "forward",
      join: (x, y) => x || y,
      eq: (x, y) => x === y,
      transfer: (out) => out,
    });
    check(
      "前向对照：boundary=true 从**入口**起头，再顺着前向传到每个块（三个都 true）",
      ["b0", "b1", "b2"].every((l) => fwd.outOf.get(l) === true),
      ["b0", "b1", "b2"].map((l) => `${l}:out=${String(fwd.outOf.get(l))}`).join(" "),
    );
  }

  // ── 不可达块：不进 worklist，留在 bottom
  {
    const c = buildCfg(
      progOf(
        [
          block("b0", [{ type: "Assign", name: "t", value: AInt(1) }], { type: "Ret", value: AVar("t") }),
          block("dead", [{ type: "Assign", name: "q", value: AInt(9) }], { type: "Ret", value: AVar("q") }),
        ],
        "b0",
      ),
    ).cfg("u");
    const r = solve(c, MAY_CONST);
    check(
      "不可达块没被访问、留在格底",
      show(r.inOf.get("dead")!) === "∅" && show(r.outOf.get("dead")!) === "∅",
      `in=${show(r.inOf.get("dead")!)} out=${show(r.outOf.get("dead")!)}`,
    );
    check("不可达块也不占访问次数", r.visits === 1, `visits=${r.visits}`);
  }

  // ── 不单调 → 超上限报错退出（不是挂住），并点名块
  {
    let ctor = "";
    let msg = "";
    try {
      solve(
        cfg,
        {
          bottom: EMPTY,
          join: (a, b) => new Map([...a, ...b]),
          eq: (a, b) => a.size === b.size,
          // 每处理一次就多塞一个键 —— **不单调**（已经"更多"了还要再变），
          // 于是永远到不了不动点。格的高度有限、传递函数单调的话不会这样。
          transfer: (s) => new Map([...s, [`k${s.size}`, 1]]),
        },
        { maxVisits: 50 },
      );
    } catch (e) {
      ctor = (e as Error).constructor.name;
      msg = (e as Error).message;
    }
    check(
      "不单调的分析：超上限报错退出（不是挂住）",
      ctor === "DataflowLimit" && msg.includes("50") && /块 b\d/.test(msg),
      `${ctor}: ${msg.split("\n")[0]}`,
    );
  }
}
