/**
 * t13 的验收：不动点驱动器。
 *
 * 四条：
 *   ① 跑到不再变就停
 *   ② 超轮数上限 → 报错退出（不是挂住）
 *   ③ 不动点时"输出与上一轮结构相等"（这里更强：**就是同一个对象**）
 *   ④ 判定"变没变"的那一步不是全量深比较 —— 用一条反例证明它只认引用
 */

import { buildWalkerDynamic, emitWalker } from "../src/nanopass/codegen.ts";
import { fixpoint, FixpointLimit } from "./fixpoint.ts";
import { L6 } from "./langs/L6.lang.ts";
import { L7 } from "./langs/L7.lang.ts";
import { P, rewrite, rule } from "./rewrite.ts";
import type { Step } from "./runner.ts";

export type Check = (name: string, ok: boolean, detail?: string) => void;

type Node = Record<string, unknown>;
const num = (v: number): Node => ({ type: "Int", value: v });
const add = (a: unknown, b: unknown): Node => ({ type: "Prim", op: "+", args: [a, b] });
const prog = (e: unknown): Node => ({ type: "Prog", defs: [], body: [e] });

/** 一个最小可用的同语言 Step（没有任何 handler，走 identity 路径）。 */
function mkStep(name: string, run: (x: unknown) => unknown): Step {
  const spec = { from: L6, to: L6, arity: 1, rules: {}, init: () => [] } as never;
  return { name, from: L6.id, to: L6.id, arity: 1, spec, run, source: emitWalker(spec) };
}

export function fixpointChecks(check: Check): void {
  // ── ① 跑到不再变就停
  //
  //    用 rewrite 剥壳：`((x+0)+0)+0` 每轮剥一层。rewrite() 自己就跑到不动点，
  //    所以外面再包一层 fixpoint 应当"多跑一轮就发现没变"。
  {
    const peel = rewrite("peel", L6, [
      rule("剥一层 x+0 → x", "Prim", P.of("Prim", { op: P.lit("+"), args: P.any("args") }), (m) => {
        const args = m.get("args") as Node[];
        if (args.length !== 2) return undefined;
        const isZero = (x: unknown): boolean => (x as Node)["type"] === "Int" && (x as Node)["value"] === 0;
        if (isZero(args[0])) return args[1];
        if (isZero(args[1])) return args[0];
        return undefined;
      }),
    ]);

    const fp = fixpoint("peel-fp", peel);
    const out = fp.run(prog(add(add(add({ type: "Var", name: "x" }, num(0)), num(0)), num(0))));
    const bodyType = ((out as Node)["body"] as Node[])[0]!["type"];
    check("① 跑到不再变就停（3 层壳全剥掉）", bodyType === "Var", `结果 type=${String(bodyType)}`);

    // 再跑一遍：输入已经在不动点 → 0 轮就停
    const again = fp.run(out);
    check("① 已经在不动点：0 轮就停", again === out && fp.rounds() === 0, `rounds=${fp.rounds()}`);
  }

  // ── ② 超上限 → 报错，不挂住
  {
    const spec = { from: L6, to: L6, arity: 1, rules: {}, init: () => [] } as never;
    const walker = buildWalkerDynamic(spec);
    // 每轮都返回一个新的根对象 —— 引用永远不等，所以"永远在变"
    const churn = mkStep("churn", (x: unknown) => {
      walker.run(x);
      return { ...(x as Node) };
    });
    const fp = fixpoint("churn-fp", churn, { maxRounds: 5 });
    let ctor = "";
    let msg = "";
    try {
      fp.run(prog(num(1)));
    } catch (e) {
      ctor = (e as Error).constructor.name;
      msg = (e as Error).message;
    }
    check(
      "② 超轮数上限报错退出（不是挂住）",
      ctor === "FixpointLimit" && msg.includes("5") && msg.includes("churn"),
      `${ctor}: ${msg.split("\n")[0]}`,
    );
  }

  // ── ③ 不动点：输出与上一轮**是同一个对象**（比"结构相等"更强）
  {
    const noop = rewrite("noop", L6, []); // 一条规则都没有
    const fp = fixpoint("noop-fp", noop);
    const tree = prog(add(num(1), num(2)));
    const out = fp.run(tree);
    check("③ 不动点 = 与输入同一个对象", out === tree, `rounds=${fp.rounds()}`);
    check("③ 结构相等（同对象必然如此）", JSON.stringify(out) === JSON.stringify(tree));
  }

  // ── ④ 判定只认引用，不做深比较
  //
  //    反例：造一个"结构完全一样、但每次都是新对象"的 step。
  //    如果驱动器做的是深比较，它第一轮就该停；只认引用的话它会一直跑到上限。
  //    **跑到上限 = 证明没做深比较。**
  {
    const spec = { from: L6, to: L6, arity: 1, rules: {}, init: () => [] } as never;
    const walker = buildWalkerDynamic(spec);
    const realloc = mkStep("realloc", (x: unknown) => {
      walker.run(x);
      return JSON.parse(JSON.stringify(x)) as unknown; // 结构一模一样，但是个新对象
    });
    const fp = fixpoint("realloc-fp", realloc, { maxRounds: 3 });
    let hit = false;
    try {
      fp.run(prog(num(1)));
    } catch (e) {
      hit = e instanceof FixpointLimit;
    }
    check(
      "④ 判定只认引用（结构相同但新对象 → 不算停，跑到上限）",
      hit,
      hit ? "" : "没撞上限，说明做了深比较",
    );
  }

  // ── 跨语言的 step 不许包（说清原因，别让人自己猜）
  {
    let msg = "";
    try {
      fixpoint("cross", {
        name: "cross",
        from: L6.id,
        to: L7.id,
        arity: 0,
        spec: { from: L6, to: L7, arity: 0, rules: {}, init: () => [] } as never,
        run: (x: unknown) => x,
        source: "",
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    check(
      "跨语言 step 不许包 fixpoint（说清原因）",
      msg.includes("同语言") && msg.includes("__lang__"),
      msg.split("\n")[0],
    );
  }
}
