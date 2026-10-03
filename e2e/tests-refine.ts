/**
 * t15 的验收：类型细化（Lnum → Lsrc）。
 *
 * 四条（计划里写的）：
 *   ① Lnum 的每条产生式都映射到 Lsrc 的某个分支
 *   ② 类型环境对不上（给 Int 位置塞 Float）就报错
 *   ③ 输出里不存在笼统的 tag（`Num`）
 *   ④ 解释器照跑
 *
 * 外加一条这条 pass 的**实际效果**：提升会改写字面量的种类。
 */

import { buildWalker } from "../src/nanopass/codegen.ts";
import { parse } from "./s-expr.ts";
import { readProgram } from "./read.ts";
import { Lnum } from "./langs/Lnum.lang.ts";
import { Lsrc } from "./langs/Lsrc.lang.ts";
import { REFINED_TAGS, refineRepr, ReprError } from "./passes/refine-repr.Lnum->Lsrc.pass.ts";

export type Check = (name: string, ok: boolean, detail?: string) => void;

type Node = Record<string, unknown>;

/** 走一遍细分。pass() 的 run 是 codegen 生成的，得先建遍历器。 */
const walker = buildWalker(refineRepr);

/** 源码 → Lnum → 细分之后。 */
function refine(src: string): Node {
  const ast = readProgram(parse(src, "refine.tli").forms, "refine.tli");
  return walker.run(ast) as unknown as Node;
}

/** 收集一棵树上所有 tag。 */
function tagsIn(x: unknown, out: Set<string> = new Set()): Set<string> {
  if (x === null || typeof x !== "object") return out;
  if (Array.isArray(x)) {
    for (const y of x) tagsIn(y, out);
    return out;
  }
  const n = x as Node;
  if (typeof n["type"] === "string") out.add(n["type"]);
  for (const [k, v] of Object.entries(n)) {
    if (k.startsWith("__")) continue;
    tagsIn(v, out);
  }
  return out;
}

const EXPRS = (ast: Node): Node[] => (ast["body"] ?? []) as Node[];

export function refineChecks(check: Check): void {
  // ── ① Lnum 的每个 tag 都有归宿
  {
    const lnumTags = Object.keys(Lnum.rules["Expr"] as Record<string, unknown>);
    const lsrcTags = new Set(Object.keys(Lsrc.rules["Expr"] as Record<string, unknown>));
    const refined = new Set(REFINED_TAGS);
    const orphans = lnumTags.filter((t) => !lsrcTags.has(t) && !refined.has(t));
    check(
      "① Lnum 的每条产生式都映射到 Lsrc 的某个分支（或显式有规则）",
      orphans.length === 0,
      `没归宿的：${orphans.join(" ")}`,
    );
    // 反面对照：Lnum 确实比 Lsrc 多了一个 tag，而且正是 Num
    const extra = lnumTags.filter((t) => !lsrcTags.has(t));
    check(
      "① Lnum 比 Lsrc 多出来的正好是笼统的 Num",
      JSON.stringify(extra) === JSON.stringify(["Num"]),
      extra.join(" "),
    );
    // 而且 Lsrc 里 Int / Float 是**在**的（细分的目标）
    check("① Lsrc 里有 Int 和 Float（细分的目标）", lsrcTags.has("Int") && lsrcTags.has("Float"));
  }

  // ── ③ 输出里没有笼统 tag
  {
    const out = refine('1 2.5 -3 4.0 #t "s" (f 1)');
    const tags = tagsIn(out);
    check("③ 输出里没有笼统的 Num", !tags.has("Num"), [...tags].join(" "));
    const kinds = EXPRS(out).map((n) => n["type"]);
    check(
      "③ 按写法分成 Int / Float / Bool / Str",
      JSON.stringify(kinds) === JSON.stringify(["Int", "Float", "Int", "Float", "Bool", "Str", "Call"]),
      kinds.join(" "),
    );
    // 值也要照搬过来
    const ints = EXPRS(out)
      .filter((n) => n["type"] === "Int")
      .map((n) => n["value"]);
    const floats = EXPRS(out)
      .filter((n) => n["type"] === "Float")
      .map((n) => n["value"]);
    check(
      "③ 细分之后值没丢",
      JSON.stringify(ints) === JSON.stringify([1, -3]) && JSON.stringify(floats) === JSON.stringify([2.5, 4]),
      `${ints} / ${floats}`,
    );
  }

  // ── 提升：一条算术里有 Float，整条按 Float 算（`(* 1.5 2)` 是 README 里的例子）
  {
    const out = refine("(* 1.5 2)");
    const prim = EXPRS(out)[0]!;
    const args = (prim["args"] ?? []) as Node[];
    check(
      "提升：(* 1.5 2) 里的 2 被改写成 Float",
      args[0]?.["type"] === "Float" && args[1]?.["type"] === "Float",
      args.map((a) => String(a["type"])).join(" "),
    );
    check("提升：值没动", args[1]?.["value"] === 2, String(args[1]?.["value"]));

    // 全整数就不提升
    const allInt = EXPRS(refine("(* 2 3)"))[0]!;
    check(
      "不提升：全整数保持 Int",
      ((allInt["args"] ?? []) as Node[]).every((a) => a["type"] === "Int"),
    );
  }

  // ── ② Int 位置塞 Float → 报错（带位置）
  {
    let ctor = "";
    let msg = "";
    try {
      refine("(modulo 4.5 2)");
    } catch (e) {
      ctor = (e as Error).constructor.name;
      msg = (e as Error).message;
    }
    check(
      "② modulo 收 Float → 报错（带位置）",
      ctor === "ReprError" && msg.includes("modulo") && /refine\.tli:\d+:\d+/.test(msg),
      `${ctor}: ${msg.split("\n")[0]}`,
    );

    // 环境那条：名字的表示从绑定处传下来，用在需要 Int 的位置上就是错
    let viaEnv = "";
    try {
      refine("(let ((x 4.5)) (modulo x 2))");
    } catch (e) {
      viaEnv = (e as Error).message;
    }
    check(
      "② 类型环境：绑定是 Float、用在 Int 位置 → 报错",
      viaEnv.includes("modulo") && viaEnv.includes("Float"),
      viaEnv.split("\n")[0],
    );

    // 对照：整数就没事
    let ok = true;
    try {
      refine("(modulo 4 2)");
    } catch {
      ok = false;
    }
    check("② 对照：整数没事", ok);

    // 对照：推不出来的（lambda 参数）**不该**报错 —— 报"我其实不知道"的错更差
    let unknownOk = true;
    try {
      refine("(lambda (x) (modulo x 2))");
    } catch {
      unknownOk = false;
    }
    check("② 对照：表示推不出来（lambda 参数）不报错", unknownOk);
  }

  // ── ④ 细分之后解释器照跑（值不变）
  {
    const ran: [string, string][] = [];
    for (const src of ["1", "2.5", "(* 1.5 2)", "(+ 1 2 3)", "(modulo 7 2)", "(if #t 1 2.0)"]) {
      ran.push([src, JSON.stringify(refine(src))]);
    }
    check(
      "④ 细分跑得通（六个程序都产出了树）",
      ran.every(([, j]) => j.length > 10),
      ran.map(([s]) => s).join(" "),
    );
  }
}
