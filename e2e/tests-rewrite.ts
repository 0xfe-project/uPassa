/**
 * t11 的机制测试：重写规则引擎 + 终止纪律。
 *
 * 四条验收：
 *   ① 规则表能编译成匹配器并跑
 *   ② 项序生效（不许改回头）
 *   ③ 故意写一张不终止的规则表 → 超步数上限**报错退出**，不挂住
 *   ④ 规则命中数与期望一致
 */

import { L6 } from "./langs/L6.lang.ts";
import { P, rewrite, rule, RewriteLimit } from "./rewrite.ts";

export type Check = (name: string, ok: boolean, detail?: string) => void;

type Node = Record<string, unknown>;
const num = (v: number): Node => ({ type: "Int", value: v });
const add = (a: unknown, b: unknown): Node => ({ type: "Prim", op: "+", args: [a, b] });
const prog = (e: unknown): Node => ({ type: "Prog", defs: [], body: [e] });

const isLit = (x: unknown): boolean =>
  x !== null && typeof x === "object" && ((x as Node)["type"] === "Int" || (x as Node)["type"] === "Float");

/** 匹配 (op ...args)，绑 args。 */
const anyPrim = (op: string): ReturnType<typeof P.of> => P.of("Prim", { op: P.lit(op), args: P.any("args") });

export function rewriteChecks(check: Check): void {
  // ── ① 规则表能跑：恒等式 x+0 → x
  {
    const rw = rewrite("t11-id", L6, [
      rule("x+0 → x", "Prim", anyPrim("+"), (m) => {
        const args = m.get("args") as Node[];
        if (args.length !== 2) return undefined;
        if ((args[1] as Node)["type"] === "Int" && (args[1] as Node)["value"] === 0) return args[0];
        if ((args[0] as Node)["type"] === "Int" && (args[0] as Node)["value"] === 0) return args[1];
        return undefined;
      }),
    ]);
    const out = JSON.stringify(rw.run(prog(add(num(1), num(0)))));
    check(
      "① 规则表能编译成匹配器并跑",
      out.includes('"value":1') && !out.includes('"Prim"'),
      out.slice(0, 70),
    );
  }

  // ── ② 项序：字面量在左时不许再换
  {
    const rw = rewrite("t11-order", L6, [
      rule(
        "交换律（带项序）",
        "Prim",
        anyPrim("+"),
        (m) => {
          const args = m.get("args") as Node[];
          if (args.length !== 2) return undefined;
          return add(args[1], args[0]);
        },
        {
          // 项序：左边是字面量、右边不是 → 已经规范，不许再换
          order: (before) => {
            const b = before as { args: Node[] };
            return !(isLit(b.args[0]) && !isLit(b.args[1]));
          },
        },
      ),
    ]);

    /** 取出 body 里那个 Prim 的两个参数类型，比如 "Int,Var"。 */
    const argsOf = (x: unknown): string => {
      const body = (x as Node)["body"] as Node[];
      const args = ((body[0] as Node)["args"] ?? []) as Node[];
      return args.map((a) => a["type"] as string).join(",");
    };

    // 已经规范（字面量在左）：不许换
    const already = argsOf(rw.run(prog(add(num(1), { type: "Var", name: "x" }))));
    check("② 项序生效：已经规范的项不改", already === "Int,Var", already);

    // 不规范（字面量在右）：换过来就停
    const swapped = argsOf(rw.run(prog(add({ type: "Var", name: "x" }, num(1)))));
    check("② 项序生效：不规范的项换过来就停", swapped === "Int,Var", swapped);
  }

  // ── ③ 不终止的规则表 → 报错，不挂住
  {
    const rw = rewrite(
      "t11-loop",
      L6,
      [
        rule("交换律（无项序）", "Prim", anyPrim("+"), (m) => {
          const args = m.get("args") as Node[];
          if (args.length !== 2) return undefined;
          return add(args[1], args[0]); // 每次都能命中 → 无限来回
        }),
      ],
      { maxSteps: 60 },
    );
    let ctor = "";
    let msg = "";
    try {
      rw.run(prog(add(num(1), num(2))));
    } catch (e) {
      ctor = (e as Error).constructor.name;
      msg = (e as Error).message;
    }
    check(
      "③ 不终止的规则表：超上限报错退出（不是挂住）",
      ctor === "RewriteLimit" && msg.includes("交换律") && msg.includes("60"),
      `${ctor}: ${msg.split("\\n")[0]}`,
    );
  }

  // ── ④ 命中数与期望一致
  {
    let hits = 0;
    const rw = rewrite("t11-count", L6, [
      rule("x+0 → x", "Prim", anyPrim("+"), (m) => {
        const args = m.get("args") as Node[];
        if (args.length !== 2) return undefined;
        if ((args[1] as Node)["type"] === "Int" && (args[1] as Node)["value"] === 0) {
          hits += 1;
          return args[0];
        }
        return undefined;
      }),
    ]);
    // (+ 1 (+ 2 0))：里层命中一次；折完变成 (+ 1 2)，外层不再命中 → 1 次
    // （一遍自底向上就够，因为里层先折完、外层的 args 变成了 [1, 2]）
    rw.run(prog(add(num(1), add(num(2), num(0)))));
    check("④ 规则命中数与期望一致", hits === 1, `实际命中 ${hits} 次`);

    // 跨轮：`(+ (+ 0 x) 0)`，规则两侧都认（x+0 → x，0+x → x）。
    //
    // 一轮里内层先折成 x（外层因此变成 `(+ x 0)`，但这一轮外层**已经处理过了**），
    // 所以必须再来一轮才能折外层 → 总共 2 次命中。这条验的就是"跑到不动点"。
    hits = 0;
    const rw2 = rewrite("t11-fix", L6, [
      rule("x+0 → x", "Prim", anyPrim("+"), (m) => {
        const args = m.get("args") as Node[];
        if (args.length !== 2) return undefined;
        const isZero = (x: unknown): boolean => (x as Node)["type"] === "Int" && (x as Node)["value"] === 0;
        if (isZero(args[1])) {
          hits += 1;
          return args[0];
        }
        if (isZero(args[0])) {
          hits += 1;
          return args[1];
        }
        return undefined;
      }),
    ]);
    const out = rw2.run(prog(add(add(num(0), { type: "Var", name: "x" }), num(0))));
    const bodyType = ((out as Node)["body"] as Node[])[0]!["type"];
    check(
      "④ 跑到不动点（跨轮累计 2 次）",
      hits === 2 && bodyType === "Var",
      `命中 ${hits} 次，结果 type=${String(bodyType)}`,
    );
  }
}
