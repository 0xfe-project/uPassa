/**
 * t17 的验收：CFG 上的四条 pass。
 *
 *  ① 块排序：入口在前、后继有序
 *  ② 不可达块消除：删掉死块、可达的保留
 *  ③ 跳转穿线：跳转链被压直
 *  ④ 活跃性：给一个具体块，live-out 集合与手算一致
 *
 * ④ 是这四条里唯一"有点分析味儿"的，所以除了手算的那个块，另外钉两条性质：
 *  - 一个**没用到的绑定**不该出现在 live-out 里（那是 DCE 的依据）
 *  - 回边上的名字要活着（循环变量）
 */

import { buildCfg, type CfgBlock, type CfgProg } from "./cfg.ts";
import { cleanCfg, liveness, orderBlocks, removeUnreachable, threadJumps } from "./cfg-passes.ts";

export type Check = (name: string, ok: boolean, detail?: string) => void;

const AInt = (v: number): unknown => ({ type: "AInt", value: v });
const AVar = (n: string): unknown => ({ type: "AVar", name: n });
const prim = (op: string, ...args: unknown[]): unknown => ({ type: "APrim", op, args });

const block = (label: string, stmts: unknown[], term: unknown): CfgBlock =>
  ({ type: "Block", label, stmts, term }) as unknown as CfgBlock;
const assign = (name: string, value: unknown): unknown => ({ type: "Assign", name, value });

const progOf = (entry: string, blocks: CfgBlock[]): CfgProg =>
  ({ type: "Prog", units: [{ type: "Unit", name: "u", params: [], entry, blocks }] }) as unknown as CfgProg;

const labelsOf = (p: CfgProg): string[] => p.units[0]!.blocks.map((b) => b.label);
const termOf = (p: CfgProg, label: string): string => {
  const b = p.units[0]!.blocks.find((x) => x.label === label)!;
  const t = b.term;
  return t.type === "Jump" ? `jump ${t.target}` : t.type === "Branch" ? `br ${t.then}:${t.alt}` : "ret";
};

/** 一条跳转链 b0→b1→b2→b3（中间都是空跳转块），加上一个不可达块。 */
function chainProg(): CfgProg {
  return progOf("b0", [
    block("b0", [], { type: "Jump", target: "b1" }),
    block("b1", [], { type: "Jump", target: "b2" }),
    block("b2", [], { type: "Jump", target: "b3" }),
    block("b3", [assign("r", AInt(7))], { type: "Ret", value: AVar("r") }),
    block("dead", [assign("q", AInt(9))], { type: "Ret", value: AVar("q") }),
  ]);
}

export function cfgPassChecks(check: Check): void {
  // ── ③ 跳转穿线：b0 直接指到 b3
  {
    const out = threadJumps(chainProg());
    check("③ 跳转链压直：b0 直接跳到 b3", termOf(out, "b0") === "jump b3", termOf(out, "b0"));
    check(
      "③ 中间的空跳转块还在（穿线不改「有哪些块」）",
      labelsOf(out).length === 5,
      labelsOf(out).join(","),
    );
    check("③ 有语句的块不被穿过（b3 还是 ret）", termOf(out, "b3") === "ret");

    // 纯跳转环不该被"压平"成自环或者绕不出来
    const loop = progOf("a", [
      block("a", [], { type: "Jump", target: "b" }),
      block("b", [], { type: "Jump", target: "a" }),
    ]);
    const out2 = threadJumps(loop);
    check("③ 纯跳转环不动（不会绕不出来）", termOf(out2, "a") === "jump b", termOf(out2, "a"));

    // Branch 的两条边也要穿
    const br = progOf("b0", [
      block("b0", [], { type: "Branch", cond: { type: "ABool", value: true }, then: "t", alt: "f" }),
      block("t", [], { type: "Jump", target: "end" }),
      block("f", [], { type: "Jump", target: "end" }),
      block("end", [], { type: "Ret", value: AVar("z") }),
    ]);
    check(
      "③ 分支的两条边都穿",
      termOf(threadJumps(br), "b0") === "br end:end",
      termOf(threadJumps(br), "b0"),
    );
  }

  // ── ② 不可达块消除
  {
    const out = removeUnreachable(chainProg());
    check("② 不可达块被删掉", !labelsOf(out).includes("dead"), labelsOf(out).join(","));
    check(
      "② 可达的都留着",
      JSON.stringify(labelsOf(out)) === JSON.stringify(["b0", "b1", "b2", "b3"]),
      labelsOf(out).join(","),
    );

    // **"没有前驱"和"不可达"不是一回事**：一串死块里，后一个是有前驱的
    const chainOfDead = progOf("e", [
      block("e", [], { type: "Ret", value: AInt(1) }),
      block("d1", [], { type: "Jump", target: "d2" }),
      block("d2", [], { type: "Ret", value: AInt(2) }),
    ]);
    const cp = buildCfg(chainOfDead);
    check(
      "② 一串死块：d2 有前驱（d1）但一样是死的",
      cp.cfg("u").pred("d2").length === 1 && !cp.cfg("u").reachable().has("d2"),
      `pred(d2)=${cp.cfg("u").pred("d2").join(",")} 可达=${[...cp.cfg("u").reachable()].join(",")}`,
    );
    check(
      "② 一串死块全删掉（只留入口）",
      JSON.stringify(labelsOf(removeUnreachable(chainOfDead))) === JSON.stringify(["e"]),
      labelsOf(removeUnreachable(chainOfDead)).join(","),
    );
  }

  // ── ① 块排序
  {
    // 故意把顺序打乱：入口排最后，后继顺序也乱
    const messy = progOf("b0", [
      block("b3", [], { type: "Ret", value: AVar("t") }),
      block("b2", [], { type: "Jump", target: "b3" }),
      block("b1", [], { type: "Jump", target: "b2" }),
      block("b0", [], { type: "Jump", target: "b1" }),
    ]);
    const out = orderBlocks(messy);
    check("① 入口排在第一个", labelsOf(out)[0] === "b0", labelsOf(out).join(","));
    check(
      "① 按从入口的广度优先序排",
      JSON.stringify(labelsOf(out)) === JSON.stringify(["b0", "b1", "b2", "b3"]),
      labelsOf(out).join(","),
    );
    // 排序**不改跳转**（跳转是标号引用，和位置无关）
    check("① 排序不改跳转", termOf(out, "b1") === "jump b2" && termOf(out, "b2") === "jump b3");

    // 不可达块排到最后，但还在
    const out2 = orderBlocks(chainProg());
    check(
      "① 不可达块排到最后（还在，删是 ② 的事）",
      labelsOf(out2).at(-1) === "dead",
      labelsOf(out2).join(","),
    );

    // 分支：两条边都排
    const diamond = progOf("b0", [
      block("b2", [], { type: "Ret", value: AVar("t") }),
      block("b0", [], { type: "Branch", cond: { type: "ABool", value: true }, then: "b1", alt: "b3" }),
      block("b1", [], { type: "Jump", target: "b2" }),
      block("b3", [], { type: "Jump", target: "b2" }),
    ]);
    check(
      "① 菱形：入口→两条边→汇合，按后继顺序",
      JSON.stringify(labelsOf(orderBlocks(diamond))) === JSON.stringify(["b0", "b1", "b3", "b2"]),
      labelsOf(orderBlocks(diamond)).join(","),
    );
  }

  // ── ④ 活跃性：手算一个具体块
  //
  //    b0: a = 1; b = 2; c = (< a b)   →   br c ? b1 : b2
  //    b1: d = (+ a 1)                 →   jump b3
  //    b2: ret b                                ← b2 之后什么都不用了
  //    b3: ret d
  //
  //    手算：
  //      live-out[b2] = ∅                （ret，没有后继）
  //      live-out[b3] = ∅
  //      live-in[b1]  = {a}              （use {a}，out ∅）
  //      live-in[b2]  = {b}
  //      live-out[b0] = live-in[b1] ∪ live-in[b2] = {a} ∪ {b} = **{a, b}**
  //      live-in[b0]  = use{1,2,a,b} = ∅（都是常量/已有定义）∪ (out \ {a,b,c}) = ∅
  {
    const u = progOf("b0", [
      block(
        "b0",
        [assign("a", AInt(1)), assign("b", AInt(2)), assign("c", prim("<", AVar("a"), AVar("b")))],
        {
          type: "Branch",
          cond: AVar("c"),
          then: "b1",
          alt: "b2",
        },
      ),
      block("b1", [assign("d", prim("+", AVar("a"), AInt(1)))], { type: "Jump", target: "b3" }),
      block("b2", [], { type: "Ret", value: AVar("b") }),
      block("b3", [], { type: "Ret", value: AVar("d") }),
    ]).units[0]!;

    const live = liveness(u);
    const set = (l: string, k: "liveIn" | "liveOut"): string =>
      [...(live[k].get(l) ?? [])].sort().join(",") || "∅";

    check("④ live-out[b0] = {a,b}（与手算一致）", set("b0", "liveOut") === "a,b", set("b0", "liveOut"));
    check("④ live-in[b1] = {a}", set("b1", "liveIn") === "a", set("b1", "liveIn"));
    check("④ live-in[b2] = {b}", set("b2", "liveIn") === "b", set("b2", "liveIn"));
    check("④ live-in[b0] = ∅（都定义过了）", set("b0", "liveIn") === "∅", set("b0", "liveIn"));
    // **c 只用了那一次**（分支条件），所以它在 b0 之后就死了 —— 不在 live-out 里
    check("④ 只用来做分支条件的 c 不进 live-out", !set("b0", "liveOut").includes("c"), set("b0", "liveOut"));

    // 没用到的绑定：`unused` 谁都不引用 → 不进任何 live-out（DCE 的依据）
    const u2 = progOf("b0", [
      block("b0", [assign("unused", AInt(5)), assign("t", AInt(1))], { type: "Ret", value: AVar("t") }),
    ]).units[0]!;
    const live2 = liveness(u2);
    check(
      "④ 没人用到的绑定不进 live-out",
      ![...(live2.liveOut.get("b0") ?? [])].includes("unused"),
      [...(live2.liveOut.get("b0") ?? [])].join(",") || "∅",
    );

    // 回边上的名字要活着（循环）
    const u3 = progOf("b0", [
      block("b0", [assign("i", AInt(0))], { type: "Jump", target: "b1" }),
      block("b1", [assign("i", prim("+", AVar("i"), AInt(1)))], {
        type: "Branch",
        cond: AVar("i"),
        then: "b1",
        alt: "b2",
      }),
      block("b2", [], { type: "Ret", value: AVar("i") }),
    ]).units[0]!;
    const live3 = liveness(u3);
    check(
      "④ 回边上的名字活着：live-out[b1] 里有 i",
      [...(live3.liveOut.get("b1") ?? [])].includes("i"),
      [...(live3.liveOut.get("b1") ?? [])].join(","),
    );
    // 而且收敛（能跑完就说明收敛了；再看次数是有限的）
    check(
      "④ 回边用例收敛（访问次数有限且确定）",
      live3.visits > 0 && live3.visits < 100,
      `visits=${live3.visits}`,
    );
  }

  // ── 串起来：cleanCfg 三步都生效，而且结果还是合法的 CFG
  {
    const out = cleanCfg(chainProg());
    check(
      "cleanCfg：死的删了、链压直了、入口在前",
      termOf(out, "b0") === "jump b3" && !labelsOf(out).includes("dead") && labelsOf(out)[0] === "b0",
      labelsOf(out).join(","),
    );
    // 穿过之后还有悬空跳转吗？建图会替我们查（悬空就抛）
    let ok = true;
    let msg = "";
    try {
      buildCfg(out);
    } catch (e) {
      ok = false;
      msg = (e as Error).message;
    }
    check("cleanCfg 之后还是合法的 CFG（没有悬空跳转）", ok, msg);

    // 幂等：再来一遍不再变
    const twice = cleanCfg(out);
    check(
      "cleanCfg 幂等（再来一遍块表和跳转都一样）",
      JSON.stringify(twice.units[0]!.blocks.map((b) => [b.label, b.term])) ===
        JSON.stringify(out.units[0]!.blocks.map((b) => [b.label, b.term])),
    );
  }
}
