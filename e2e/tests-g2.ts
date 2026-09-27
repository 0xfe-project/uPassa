/**
 * t14 的验收：G2 的首批 pass。
 *
 * 三条（对应计划里写的验收）：
 *   ① 常量传播**跑到收敛**，带类型的格：`if` 两支常量不同时值不再往下传
 *   ② 全局 DCE：从入口不可达的定义被删、可达的保留
 *   ③ 格到 ⊤ 就停，不无限迭代
 *
 * 另外两条是这条 pass 的**前提**，单独钉住：
 *   ④ 浮点/字符串这类类型：格是**带类型**的，`1` 和 `1.0` 不是一回事
 *   ⑤ 没有 body 时不删任何定义（只有定义的程序是"库"，不是"死代码"）
 */

import { globalConst } from "./passes/global-const.L6.pass.ts";
import { globalDce } from "./passes/global-dce.L7.pass.ts";
import { BOT, TOP, join, showLat, type Lat } from "./lattice.ts";

export type Check = (name: string, ok: boolean, detail?: string) => void;

type Node = Record<string, unknown>;
const V = (n: string): Node => ({ type: "Var", name: n });
const I = (v: number): Node => ({ type: "Int", value: v });
const Prim = (op: string, ...a: unknown[]): Node => ({ type: "Prim", op, args: a });
const DefVal = (n: string, v: unknown): Node => ({ type: "DefVal", name: n, value: v });
const Bind = (n: string, v: unknown): Node => ({ type: "Bind", name: n, value: v });
const Lam = (params: string[], body: unknown): Node => ({
  type: "Lam",
  params: params.map((p) => ({ type: "Param", name: p })),
  body: { type: "BindFree", names: [], body },
});
const prog = (defs: unknown[], body: unknown[]): Node => ({ type: "Prog", defs, body });

/** 印成一行的 s-表达式，方便断言。 */
function sexp(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return x.map(sexp).join(" ");
  const n = x as Node;
  switch (n["type"]) {
    case "Int":
    case "Float":
    case "Str":
    case "Bool":
      return JSON.stringify(n["value"]);
    case "Var":
      return String(n["name"]);
    case "Prim":
      return `(${String(n["op"])} ${((n["args"] ?? []) as unknown[]).map(sexp).join(" ")})`;
    case "If":
      return `(if ${sexp(n["cond"])} ${sexp(n["then"])} ${sexp(n["alt"])})`;
    case "Let":
      return `(let (${((n["bindings"] ?? []) as Node[]).map((b) => `${String(b["name"])}=${sexp(b["value"])}`).join(" ")}) ${sexp(n["body"])})`;
    case "Lam":
      return `(lambda ${((n["params"] ?? []) as Node[]).map((p) => String(p["name"])).join(" ")} ...)`;
    case "BindFree":
      return sexp(n["body"]);
    case "Call":
      return `(${sexp(n["fn"])} ${((n["args"] ?? []) as unknown[]).map(sexp).join(" ")})`;
    case "Prog":
      return (
        ((n["defs"] ?? []) as Node[]).map((d) => `${String(d["name"])}=${sexp(d["value"])}`).join(" ") +
        " | " +
        ((n["body"] ?? []) as unknown[]).map(sexp).join(" ")
      );
    default:
      return `<${String(n["type"])}>`;
  }
}

const runConst = (defs: unknown[], body: unknown[]): string => sexp(globalConst.run(prog(defs, body)));

const dceNames = (defs: unknown[], body: unknown[]): string =>
  (((globalDce.run(prog(defs, body)) as Node)["defs"] ?? []) as Node[])
    .map((d) => String(d["name"]))
    .join(",") || "（空）";

export function g2Checks(check: Check): void {
  // ── ① 常量传播跑到收敛（链 + 前向引用）
  {
    // 正序链：一次就够（定义顺序就是拓扑序）
    const fwd = runConst(
      [DefVal("x", I(1)), DefVal("y", V("x")), DefVal("z", Prim("+", V("y"), I(1)))],
      [V("z")],
    );
    check("① 传播链：y 代成 1、z 代成 (+ 1 1)、body 推成 2", fwd === "x=1 y=1 z=(+ 1 1) | 2", fwd);

    // **反向**链：d 依赖 c，c 依赖 b，b 依赖 a，a 最后定义。
    // 一轮只能推进一层，所以**必须多轮** —— 这条就是"跑到收敛，不是单遍"的实据。
    const back = runConst(
      [
        DefVal("d", Prim("+", V("c"), I(1))),
        DefVal("c", Prim("+", V("b"), I(1))),
        DefVal("b", Prim("+", V("a"), I(1))),
        DefVal("a", I(1)),
      ],
      [V("d")],
    );
    const rounds = globalConst.rounds();
    check(
      "① 反向链要靠多轮收敛（不是单遍）",
      rounds >= 3 && back.endsWith("| 4"),
      `轮数 ${rounds}，结果 ${back}`,
    );

    // 收敛以后再来一遍：一轮都不用（已经在不动点）
    const again = globalConst.run(globalConst.run(prog([DefVal("a", I(1))], [V("a")])));
    const rounds2 = globalConst.rounds();
    check("① 已在不动点：0 轮", rounds2 === 0, `轮数 ${rounds2}，结果 ${sexp(again)}`);
  }

  // ── ①b 带类型的格：`if` 两支常量**不同** → 值不再往下传
  {
    // c 是未知的全局 → (if c 1 2) 两支 join：Const(1,Int) ⊔ Const(2,Int) = Ty(Int)
    const out = runConst([DefVal("x", { type: "If", cond: V("c"), then: I(1), alt: I(2) })], [V("x")]);
    // 值不再传播：body 还是 `x` 这个变量引用
    // （定义右边那个 If 原样留着 —— 折它是 constant-fold 的活）
    check("① if 两支常量不同：值不再传播（body 还是 x）", out === "x=(if c 1 2) | x", out);

    // 对照：条件已知是 #t → 取那一支，值可以传
    const yes = runConst(
      [
        DefVal("t", { type: "Bool", value: true }),
        DefVal("x", { type: "If", cond: V("t"), then: I(7), alt: I(9) }),
      ],
      [V("x")],
    );
    // 值传下去了（body 变成 7）；定义右边那个 If 自己不折 —— 那是 constant-fold 的活
    check("① 条件已知：取那一支，值传下去", yes === "t=true x=(if true 7 9) | 7", yes);

    // 两支**类型都不同** → ⊤
    const mixed = join({ k: "const", value: 1, ty: "Int" }, { k: "const", value: 1.5, ty: "Float" });
    check("① 类型不同的两支 → ⊤（连类型都不敢说）", mixed.k === "top", showLat(mixed));
  }

  // ── ①c 作用域：被遮蔽的名字不替换
  {
    const shadowed = sexp(
      globalConst.run(
        prog([DefVal("x", I(7))], [{ type: "Let", bindings: [Bind("x", I(1))], body: V("x") }]),
      ),
    );
    check("① 局部绑定遮蔽全局：不替换", shadowed === "x=7 | (let (x=1) x)", shadowed);

    // 反面对照：没有遮蔽就该换
    const notShadowed = sexp(globalConst.run(prog([DefVal("x", I(7))], [V("x")])));
    check("① 没有遮蔽：照换（对照）", notShadowed === "x=7 | 7", notShadowed);
  }

  // ── ② 全局 DCE
  {
    const p = (defs: unknown[], body: unknown[]) => [defs, body] as const;
    check(
      "② 不可达的删掉、可达的留着",
      dceNames(
        ...p(
          [DefVal("used", Lam(["x"], V("x"))), DefVal("unused", Lam(["y"], V("y")))],
          [{ type: "Call", fn: V("used"), args: [I(1)] }],
        ),
      ) === "used",
    );
    check(
      "② 递归自引用算可达",
      dceNames(
        ...p([DefVal("rec", Lam(["x"], { type: "Call", fn: V("rec"), args: [V("x")] }))], [V("rec")]),
      ) === "rec",
    );
    check(
      "② 互相引用的一对都留",
      dceNames(
        ...p(
          [
            DefVal("a", Lam([], { type: "Call", fn: V("b"), args: [] })),
            DefVal("b", Lam([], I(1))),
            DefVal("c", I(9)),
          ],
          [{ type: "Call", fn: V("a"), args: [] }],
        ),
      ) === "a,b",
    );
    check(
      "② 被局部绑定遮蔽的引用不算引用（全局那个可以被删）",
      dceNames(...p([DefVal("x", I(1))], [{ type: "Let", bindings: [Bind("x", I(2))], body: V("x") }])) ===
        "（空）",
    );
    check("② 没有 body 时不删（只有定义的程序是库）", dceNames([DefVal("lonely", I(3))], []) === "lonely");
    // 幂等：没得删的时候返回同一个对象
    const once = globalDce.run(prog([DefVal("k", I(1))], [V("k")]));
    check("② 没得删就返回同一个对象（幂等）", globalDce.run(once) === once);
  }

  // ── ③ 格到 ⊤ 就停（不无限迭代）
  //
  //    格是有限的、join 单调向上，所以迭代必然在 ≤ 3 步内到顶。这里直接验 join 的单调性：
  //    反复 join 同一个元素不会继续变（到 ⊤ 就固定了）。
  {
    const c1: Lat = { k: "const", value: 1, ty: "Int" };
    const c2: Lat = { k: "const", value: 2, ty: "Int" };
    const t: Lat = { k: "ty", ty: "Int" };
    const steps = [join(c1, c2), join(join(c1, c2), c1), join(join(join(c1, c2), c1), c2)];
    check(
      "③ 格到顶就停（join 是单调的，不会来回）",
      steps[0]!.k === "ty" && steps[1]!.k === "ty" && steps[2]!.k === "ty",
      steps.map(showLat).join(" → "),
    );
    check("③ ⊥ 是单位元、⊤ 是吸收元", join(BOT, c1).k === "const" && join(c1, TOP).k === "top");

    // 端到端：混合类型的 join 到 ⊤ 之后不再变
    const muddled = join(join({ k: "const", value: 1, ty: "Int" }, { k: "ty", ty: "Float" }), c2);
    check("③ 推不出来就停在 ⊤", muddled.k === "top", showLat(muddled));
  }

  // ── ④ 带类型的格：值相同但类型不同**不算**同一个常量
  {
    const intOne: Lat = { k: "const", value: 1, ty: "Int" };
    const floatOne: Lat = { k: "const", value: 1, ty: "Float" };
    check("④ 1 和 1.0 不是一回事（类型不同 → ⊤）", join(intOne, floatOne).k === "top");
    check("④ 类型相同、值相同 → 保留常量", showLat(join(intOne, intOne)) === "Const(1:Int)");
    check(
      "④ 类型相同、值不同 → 退到只会类型",
      showLat(join(intOne, { k: "const", value: 2, ty: "Int" })) === "Ty(Int)",
    );
  }
}
