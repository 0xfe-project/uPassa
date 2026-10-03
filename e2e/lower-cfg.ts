/**
 * L7 → Lcfg：把函数体降低成基本块（t16）。
 *
 * ## 为什么不是一条 `pass()`
 *
 * 两条理由，都是真的：
 *
 * ① **它是整程序重构，不是"一棵树换个形状"**。输出是"一堆 Unit，每个 Unit 一堆块" ——
 *    单位和单位之间不是树上的父子关系，pass 的模型（handler 收一个节点、返回一个节点）
 *    在这里对不上。
 * ② 实践上也走不通：降低的入口是 `Program`，而"在 `Program` 上挂规则"会撞 TS2589
 *    （t24 记着的那个坑）。
 *
 * 所以这一步是**手搭的 Step**（跟 `rewrite` / `global-const` / `global-dce` 一个路子），
 * 里面就是一个普通的递归函数。
 *
 * **但这不代表 CFG 上的 pass 就用不了框架** —— 块的排序、不可达消除、穿线那些挂在
 * `Unit` / `Block` 上，不是 `Program`，可以正常写 pass。
 *
 * ## 降低算法：这一步比树遍历多了一样东西
 *
 * 一个表达式里可能出现 `if`，于是"算出一个值"这件事会**分裂控制流**。所以递归的返回值
 * 不只是 Atom，还有"控制流接下来落在哪个块"：
 *
 *     lower(e, cur) → { atom, cur }
 *
 *   - 不分支的（字面量、Var、Prim、Call）：子表达式挨个 lower（**注意它们可能换块**），
 *     拼成 Atom。
 *   - `If`：造 3 个块 —— then 支、alt 支、汇合块；两支各自把值写进**同一个临时名**。
 *   - `Let`：绑定值先算并写 `Assign`，再 lower 体（平行 let，绑定值都在外层环境里求）。
 *   - `Begin`：一个个 lower，值取最后一个。
 *
 * 那个"cur 会变"就是这一层和树遍历最不一样的地方：树遍历里，处理完一个孩子，"位置"
 * 还是在同一个父节点上；这里处理完一个孩子，**当前块可能已经换了**。
 *
 * 临时名和标号都是单调递增的计数器，所以同一次降低是确定的。
 *
 * ## 名字在这一层是**平的**
 *
 * 顶层定义、局部绑定、参数，在 CFG 里都只是名字。区分它们是后面挂在块上的分析的事
 * （t17 的活跃性就要做这个）。这一层的目的是**控制流**。
 */

import type { NodeOf } from "../src/nanopass/lang.ts";
import type { Step } from "./runner.ts";
import { L7 } from "./langs/L7.lang.ts";
import { Lcfg } from "./langs/Lcfg.lang.ts";

type InExpr = NodeOf<typeof L7, "Expr">;
type InProgram = NodeOf<typeof L7, "Program">;
type InParam = NodeOf<typeof L7, "Param">;

export type OutProg = NodeOf<typeof Lcfg, "Prog">;
export type OutUnit = NodeOf<typeof Lcfg, "Unit">;
export type OutBlock = NodeOf<typeof Lcfg, "Block">;
export type OutStmt = NodeOf<typeof Lcfg, "Stmt">;
export type OutTerm = NodeOf<typeof Lcfg, "Term">;
export type OutAtom = NodeOf<typeof Lcfg, "Atom">;

/**
 * 框架给的节点类型是 `readonly` 的（那对"换个形状"的 pass 是对的）。
 * 但降低是**造**节点、一块一块拼起来，所以内部用可变版本，最后一次性交出去。
 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MBlock = Mutable<OutBlock>;
type MUnit = Mutable<OutUnit>;
type MProg = Mutable<OutProg>;

/** 还没定终结子的块的占位。校验会抓它 —— 说明降低漏了一条路径。 */
export const UNTERMINATED = "__unterminated";

class Builder {
  /** 当前正在造的 unit 的块表。嵌套 lambda 会在自己的表里造。 */
  private blocks: MBlock[] = [];
  private units: MUnit[] = [];
  /** 标号/临时名的计数器。单调递增 —— 同一次降低是确定的。 */
  private n = 0;

  label(): string {
    return `b${this.n++}`;
  }

  temp(): string {
    return `t${this.n++}`;
  }

  mkBlock(label: string): MBlock {
    const b: MBlock = {
      type: "Block",
      label,
      stmts: [],
      // 占位：所有路径最后都会设成真的终结子。留着的会被 validate 抓出来。
      term: { type: "Ret", value: { type: "AVoid" } } as OutTerm,
    };
    (b as Record<string, unknown>)[UNTERMINATED] = true;
    this.blocks.push(b);
    return b;
  }

  term(block: MBlock, t: OutTerm): void {
    block.term = t;
    delete (block as Record<string, unknown>)[UNTERMINATED];
  }

  assign(block: MBlock, name: string, value: OutAtom): void {
    block.stmts.push({ type: "Assign", name, value } as OutStmt);
  }

  /**
   * 造一个 unit：把体的降低结果放进**它自己的**块表，然后用 `Ret` 收尾。
   *
   * 注意这里要临时把 `blocks` 换掉再换回来 —— 嵌套 lambda 的块属于它自己的 unit，
   * 不能混进外层的块表里。这个"换表"就是帧结构的来源：每进入一个函数体就换一次。
   */
  unit(name: string, params: InParam[], body: InExpr): string {
    const outer = this.blocks;
    this.blocks = [];
    const entry = this.mkBlock(this.label());
    const { atom, cur } = this.lower(body, entry);
    this.term(cur, { type: "Ret", value: atom } as OutTerm);
    const blocks = this.blocks;
    this.blocks = outer;
    this.units.push({ type: "Unit", name, params, entry: entry.label, blocks } as OutUnit);
    return name;
  }

  /** 顶层：非 lambda 的定义和尾随表达式都进 `main`。 */
  main(defs: { name: string; value: InExpr }[], body: InExpr[]): MUnit {
    const entry = this.mkBlock(this.label());
    let cur = entry;
    for (const d of defs) {
      const r = this.lower(d.value, cur);
      this.assign(r.cur, d.name, r.atom);
      cur = r.cur;
    }
    let last: OutAtom = { type: "AVoid" } as OutAtom;
    for (const e of body) {
      const r = this.lower(e, cur);
      last = r.atom;
      cur = r.cur;
    }
    this.term(cur, { type: "Ret", value: last } as OutTerm);
    return { type: "Unit", name: "main", params: [], entry: entry.label, blocks: this.blocks } as OutUnit;
  }

  result(mainUnit: MUnit): MProg {
    return { type: "Prog", units: [mainUnit, ...this.units] };
  }

  lower(e: InExpr, curIn: MBlock): { atom: OutAtom; cur: MBlock } {
    let cur = curIn;

    /** 先 lower 一个子表达式，把当前块接上。 */
    const sub = (x: InExpr): OutAtom => {
      const r = this.lower(x, cur);
      cur = r.cur;
      return r.atom;
    };

    switch (e.type) {
      case "If": {
        const cond = sub(e.cond);
        const lThen = this.label();
        const lAlt = this.label();
        const lJoin = this.label();
        const t = this.temp();
        // 当前块在这里就断了：它的出路是两条
        this.term(cur, { type: "Branch", cond, then: lThen, alt: lAlt } as OutTerm);

        const bThen = this.mkBlock(lThen);
        const vThen = this.lower(e.then, bThen);
        this.assign(vThen.cur, t, vThen.atom);
        this.term(vThen.cur, { type: "Jump", target: lJoin } as OutTerm);

        const bAlt = this.mkBlock(lAlt);
        const vAlt = this.lower(e.alt, bAlt);
        this.assign(vAlt.cur, t, vAlt.atom);
        this.term(vAlt.cur, { type: "Jump", target: lJoin } as OutTerm);

        const join = this.mkBlock(lJoin);
        return { atom: { type: "AVar", name: t } as OutAtom, cur: join };
      }

      case "Let":
      case "Letrec": {
        // let 是平行的：绑定值都在**外层**环境里求，所以先全算完再登记。
        // （letrec 的绑定互相可见，但这一层不追作用域 —— 见文件头"名字是平的"。）
        for (const b of e.bindings) {
          const r = this.lower(b.value, cur);
          this.assign(r.cur, b.name, r.atom);
          cur = r.cur;
        }
        return this.lower(e.body, cur);
      }

      case "Begin": {
        let last: OutAtom = { type: "AVoid" } as OutAtom;
        for (const x of e.exprs) last = sub(x);
        return { atom: last, cur };
      }

      default: {
        // 剩下的：字面量 / Var / Prim / Call / Lam —— 参数是 Atom（不分支），
        // 但**参数自己**可能分裂控制流，所以还是得挨个 lower。
        switch (e.type) {
          case "Void":
            return { atom: { type: "AVoid" } as OutAtom, cur };
          case "Int":
            return { atom: { type: "AInt", value: e.value } as OutAtom, cur };
          case "Float":
            return { atom: { type: "AFloat", value: e.value } as OutAtom, cur };
          case "Bool":
            return { atom: { type: "ABool", value: e.value } as OutAtom, cur };
          case "Str":
            return { atom: { type: "AStr", value: e.value } as OutAtom, cur };
          case "Var":
            return { atom: { type: "AVar", name: e.name } as OutAtom, cur };
          case "Prim":
            return {
              atom: { type: "APrim", op: e.op, args: e.args.map(sub) } as OutAtom,
              cur,
            };
          case "Call": {
            const fn = sub(e.fn);
            const args = e.args.map(sub);
            return { atom: { type: "ACall", fn, args } as OutAtom, cur };
          }
          case "Lam": {
            // 嵌套 lambda：体是**另一个 unit**。L7 里 Lam 的体外裹了一层 BindFree ——
            // 那一层装的就是自由变量表（uncover-free 算的），**带下来**：活跃性分析要用
            // （lambda 值在创建的地方就"用到"了捕获的名字）。
            const bf = e.body as { body: InExpr; names: string[] };
            const name = this.unit(`λ${String(this.n)}`, e.params, bf.body);
            return {
              atom: { type: "ALam", params: e.params, unit: name, free: bf.names } as OutAtom,
              cur,
            };
          }
          default: {
            const never: never = e;
            throw new Error(`降低成 CFG：不认识这个产生式 ${JSON.stringify(never).slice(0, 80)}`);
          }
        }
      }
    }
  }
}

/** 把一个 L7 程序降低成 Lcfg。 */
export function lowerToCfg(prog: InProgram): OutProg {
  const b = new Builder();
  const lambdaDefs: { name: string; value: InExpr }[] = [];
  const valueDefs: { name: string; value: InExpr }[] = [];
  for (const d of prog.defs) {
    if (d.type !== "DefVal") continue;
    (d.value.type === "Lam" ? lambdaDefs : valueDefs).push({ name: d.name, value: d.value });
  }
  // 先建 main（非 lambda 的定义 + 尾随表达式），再建每个顶层函数
  const main = b.main(valueDefs, prog.body);
  for (const d of lambdaDefs) {
    // 顶层 lambda 也一样：外层没有捕获（它是全局的），所以 free 是空的
    const lam = d.value as Extract<InExpr, { type: "Lam" }>;
    b.unit(d.name, lam.params, (lam.body as { body: InExpr }).body);
  }
  return b.result(main);
}

export const toCfg: Step<"L7", "Lcfg"> = {
  name: "to-cfg",
  from: L7.id,
  to: Lcfg.id,
  arity: 0,
  spec: { from: L7, to: Lcfg, arity: 0, rules: {}, init: () => [] } as never,
  source: "// 手搭的：整程序重构，不走 codegen\n",
  opaque: true, // 逻辑在 run 里，从 spec 重建会丢
  run: (input: unknown): unknown => lowerToCfg(input as InProgram),
};
