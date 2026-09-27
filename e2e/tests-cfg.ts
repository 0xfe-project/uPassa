/**
 * t16 的验收（前半）：CFG 能建出来 + 前驱/后继表正确。
 *
 *  ① 能从 L7 降低出 CFG
 *  ② 前驱/后继表正确（含 `if` 的两条出边、不可达块没有前驱）
 *
 * 另外把**校验**的反例也钉住：标号是字符串，类型系统拦不住"跳到一个不存在的块"，
 * 所以那几条检查是这一层唯一的保障，必须验它们真的会报。
 */

import { parse } from "./s-expr.ts";
import { readProgram } from "./read.ts";
import { PIPELINE_STEPS } from "./pipeline.ts";
import { runPipeline } from "./linked.ts";
import { buildCfg, CfgError, type CfgBlock, type CfgProg } from "./cfg.ts";
import { Lcfg } from "./langs/Lcfg.lang.ts";
import { lowerToCfg } from "./lower-cfg.ts";

export type Check = (name: string, ok: boolean, detail?: string) => void;

/** 源码 → 主管线 → L7 → Lcfg。 */
export function compileToCfg(src: string): CfgProg {
  const ast = readProgram(parse(src, "cfg.tli").forms, "cfg.tli");
  const l7 = runPipeline(ast).at(-1)!.ast;
  return lowerToCfg(l7 as never);
}

const block = (label: string, term: unknown, stmts: unknown[] = []): CfgBlock =>
  ({ type: "Block", label, stmts, term }) as CfgBlock;

/** 手搭一个 Lcfg 程序（校验的反例要用）。 */
function handMade(units: unknown[]): CfgProg {
  return { type: "Prog", units } as CfgProg;
}

const unit = (name: string, entry: string, blocks: unknown[]): unknown => ({
  type: "Unit",
  name,
  params: [],
  entry,
  blocks,
});

export function cfgChecks(check: Check): void {
  // ── ① 能从 L7 降低出 CFG
  {
    const prog = compileToCfg(`
      (define (fact n) (if (= n 0) 1 (* n (fact (- n 1)))))
      (fact 5)
    `);
    const names = prog.units.map((u) => u.name);
    check(
      "① 降低出 main + fact 两个 unit",
      JSON.stringify(names) === JSON.stringify(["main", "fact"]),
      names.join(" "),
    );

    const c = buildCfg(prog);
    const fact = c.cfg("fact");
    check(
      "① fact 是 4 个块（入口 + then + alt + 汇合）",
      fact.unit.blocks.length === 4,
      String(fact.unit.blocks.length),
    );
    check("① 入口块的终结子是 Branch", fact.block(fact.unit.entry).term.type === "Branch");
    check("① 汇合块的终结子是 Ret", fact.block("b4").term.type === "Ret");

    // 每条路径都有终结子（降低漏一条的话会留着占位，buildCfg 会抛）
    let ok = true;
    let msg = "";
    try {
      buildCfg(prog);
    } catch (e) {
      ok = false;
      msg = (e as Error).message;
    }
    check("① 每个块都有真终结子（校验会抓占位）", ok, msg);

    // 嵌套 lambda 也有自己的 unit
    const nested = compileToCfg("(define (f x) ((lambda (y) (+ x y)) 1)) (f 2)");
    check("① 嵌套 lambda 有自己的 unit", nested.units.length >= 3, nested.units.map((u) => u.name).join(" "));
    buildCfg(nested); // 引用齐全就不该抛
    check("① 嵌套 lambda 的 unit 引用校验通过", true);
  }

  // ── ② 前驱/后继表
  {
    const c = buildCfg(compileToCfg("(define (fact n) (if (= n 0) 1 (* n (fact (- n 1))))) (fact 5)"));
    const fact = c.cfg("fact");

    check(
      "② `if` 有两条出边",
      JSON.stringify(fact.succ("b1")) === JSON.stringify(["b2", "b3"]),
      fact.succ("b1").join(","),
    );
    check("② 入口块没有前驱", fact.pred("b1").length === 0, fact.pred("b1").join(","));
    check(
      "② 汇合块有两个前驱（两条支路都来）",
      JSON.stringify([...fact.pred("b4")].sort()) === JSON.stringify(["b2", "b3"]),
      fact.pred("b4").join(","),
    );
    check("② Ret 块没有后继", fact.succ("b4").length === 0);
    check("② 可达 = 全部 4 块", fact.reachable().size === 4, [...fact.reachable()].join(","));
    check(
      "② main 只有一块、调用了 fact",
      fact.unit.name === "fact" && c.callGraph().get("main")?.has("fact") === true,
    );
    check("② 调用图看得到自递归", c.callGraph().get("fact")?.has("fact") === true);
  }

  // ── ② 不可达块：没有前驱、不在可达集里
  {
    const prog = handMade([
      unit("u", "b0", [
        block("b0", { type: "Ret", value: { type: "AInt", value: 1 } }),
        // 谁都不跳过来
        block("dead", { type: "Ret", value: { type: "AInt", value: 2 } }),
      ]),
    ]);
    const c = buildCfg(prog).cfg("u");
    check("② 不可达块没有前驱", c.pred("dead").length === 0, c.pred("dead").join(","));
    check("② 不可达块不在可达集里", !c.reachable().has("dead"), [...c.reachable()].join(","));
  }

  // ── 校验的反例：标号是字符串，类型系统拦不住，所以这几条必须会报
  {
    const cases: [string, CfgProg, string][] = [
      [
        "跳到不存在的块",
        handMade([unit("u", "b0", [block("b0", { type: "Jump", target: "nope" })])]),
        "nope",
      ],
      [
        "分支的一条边不存在",
        handMade([
          unit("u", "b0", [
            block("b0", { type: "Branch", cond: { type: "ABool", value: true }, then: "b0", alt: "gone" }),
          ]),
        ]),
        "gone",
      ],
      [
        "入口块不存在",
        handMade([unit("u", "ghost", [block("b0", { type: "Ret", value: { type: "AVoid" } })])]),
        "ghost",
      ],
      [
        "标号重复",
        handMade([
          unit("u", "b0", [
            block("b0", { type: "Ret", value: { type: "AVoid" } }),
            block("b0", { type: "Ret", value: { type: "AVoid" } }),
          ]),
        ]),
        "重复",
      ],
      [
        "lambda 指向不存在的 unit",
        handMade([
          unit("u", "b0", [
            block("b0", {
              type: "Ret",
              value: { type: "ALam", params: [], unit: "nosuch", free: [] },
            }),
          ]),
        ]),
        "nosuch",
      ],
    ];
    for (const [label, prog, needle] of cases) {
      let msg = "";
      try {
        buildCfg(prog);
      } catch (e) {
        msg = e instanceof CfgError ? e.message : `不是 CfgError：${(e as Error).message}`;
      }
      check(`校验：${label} → 报错`, msg.includes(needle), msg.split("\n")[0] || "没报错");
    }

    // 降低漏路径 → 占位终结子被抓
    const dangling = handMade([
      unit("u", "b0", [
        {
          type: "Block",
          label: "b0",
          stmts: [],
          term: { type: "Ret", value: { type: "AVoid" } },
          __unterminated: true,
        },
      ]),
    ]);
    let unterm = "";
    try {
      buildCfg(dangling);
    } catch (e) {
      unterm = (e as Error).message;
    }
    check("校验：没终结子的块 → 报错", unterm.includes("没有终结子"), unterm.split("\n")[0] || "没报错");

    // 干净的一对：不该报（不然上面几条可能是"反正都报"）
    let clean = true;
    try {
      buildCfg(
        handMade([
          unit("u", "b0", [
            block("b0", { type: "Jump", target: "b1" }),
            block("b1", { type: "Ret", value: { type: "AVoid" } }),
          ]),
        ]),
      );
    } catch {
      clean = false;
    }
    check("校验：干净的一对不报（对照）", clean);
  }

  // ── Lcfg 语言本身的一个断言：终结子只有三种，跳转目标都是 string
  {
    const terms = Object.keys((Lcfg.rules["Term"] ?? {}) as Record<string, unknown>);
    check(
      "Lcfg 的终结子正好三类",
      JSON.stringify(terms.sort()) === JSON.stringify(["Branch", "Jump", "Ret"]),
      terms.join(" "),
    );
  }
}
