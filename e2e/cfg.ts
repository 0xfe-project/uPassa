/**
 * CFG 的**图模型**（t16）：块表之外，把"谁是入口、谁到谁"算清楚。
 *
 * ## 为什么不能顺手算
 *
 * 树遍历的时候，"孩子"是字段里写着的，直接读就行。块之间不是 —— 跳转的**目标是标号
 * 字符串**，要拿它去块表里查。所以：
 *
 *   - 后继：看这一块的终结子指向谁
 *   - 前驱：没有现成的，得**把所有块的后继反过来建索引**（一遍扫描）
 *
 * 这就是"图遍历模型"和"树递归模型"最实在的差别：树上的信息是局部的（看自己就知道），
 * 图上的信息是全局的（前驱表得从整张图算）。
 *
 * ## 校验是必须的，不是可选的
 *
 * 标号是字符串，所以"跳到一个不存在的块"是**类型系统拦不住**的 —— 降低那一步里一个
 * 手滑就会产生它，而后续的分析会静默地少算（比如活跃性分析少走一条边，结果看起来
 * 还挺合理）。所以这里逐条查：
 *
 *   - 入口块在不在
 *   - 每个跳转的目标在不在（含 Branch 的两条边）
 *   - 标号有没有重复
 *   - 每个块是不是都有真终结子（降低漏了路径的话会留着占位）
 *   - ALam 引用的 unit 在不在（和跳转一样，也是"引用"，也得查）
 *
 * 代价是 O(块数 + 跳转数)，一次建图跑一遍。
 */

import type { NodeOf } from "../src/lang.ts";
import { Lcfg } from "./langs/Lcfg.lang.ts";
import { UNTERMINATED } from "./lower-cfg.ts";

export type CfgProg = NodeOf<typeof Lcfg, "Prog">;
export type CfgUnit = NodeOf<typeof Lcfg, "Unit">;
export type CfgBlock = NodeOf<typeof Lcfg, "Block">;
export type CfgAtom = NodeOf<typeof Lcfg, "Atom">;

export class CfgError extends Error {}

/** 一个 unit 的图视图。 */
export class Cfg {
  readonly unit: CfgUnit;
  /** 标号 → 块。顺便就是"没有重复标号"的检查。 */
  readonly blockOf = new Map<string, CfgBlock>();
  /** 后继：标号 → 可达的标号列表。顺序是确定的（Branch 是 then、alt）。 */
  readonly succOf = new Map<string, string[]>();
  /** 前驱：**反过来建的索引**。树上没有这个东西，图上有。 */
  readonly predOf = new Map<string, string[]>();

  /** 手写赋值，不是参数属性 —— 理由见 `eval.ts` 的 `Env`。 */
  private readonly known: ReadonlySet<string>;

  constructor(unit: CfgUnit, known: ReadonlySet<string> = new Set()) {
    this.unit = unit;
    this.known = known;
    for (const b of unit.blocks) {
      if (this.blockOf.has(b.label)) {
        throw new CfgError(`[cfg] unit ${unit.name}：标号 ${b.label} 重复了`);
      }
      this.blockOf.set(b.label, b);
    }
    if (!this.blockOf.has(unit.entry)) {
      throw new CfgError(`[cfg] unit ${unit.name}：入口块 ${unit.entry} 不在块表里`);
    }

    // 一遍扫描 → 后继表；再反过来 → 前驱表
    for (const b of unit.blocks) {
      const succ = this.succLabels(b);
      this.succOf.set(b.label, succ);
      if (!this.predOf.has(b.label)) this.predOf.set(b.label, []);
      for (const s of succ) {
        if (!this.blockOf.has(s)) {
          throw new CfgError(
            `[cfg] unit ${unit.name}：块 ${b.label} 的 ${b.term.type} 指向 ${s}，但没有这个块`,
          );
        }
        const list = this.predOf.get(s);
        if (list === undefined) this.predOf.set(s, [b.label]);
        else list.push(b.label);
      }
    }
    // 入口自己没有前驱（如果别的块跳到入口，那是回边，合法 —— 所以这里只保证表里有键）
    if (!this.predOf.has(unit.entry)) this.predOf.set(unit.entry, []);

    this.noteUnterminated();
    this.checkAtoms();
    void this.known;
  }

  /** 一个块的出路。一个块只有一条出路（除了 Ret 是零条），这就是"基本块"的定义。 */
  private succLabels(b: CfgBlock): string[] {
    switch (b.term.type) {
      case "Jump":
        return [b.term.target];
      case "Branch":
        return [b.term.then, b.term.alt];
      case "Ret":
        return [];
      default: {
        const never: never = b.term;
        throw new CfgError(`[cfg] 不认识的终结子 ${JSON.stringify(never).slice(0, 60)}`);
      }
    }
  }

  /** 降低漏了路径的话，块上会留着占位终结子。 */
  private noteUnterminated(): void {
    for (const b of this.unit.blocks) {
      if ((b as Record<string, unknown>)[UNTERMINATED] === true) {
        throw new CfgError(`[cfg] unit ${this.unit.name}：块 ${b.label} 没有终结子（降低漏了路径）`);
      }
    }
  }

  /**
   * Atom 里的 unit 引用（`ALam`）也得查 —— 它和跳转一样是"引用"，不是子节点。
   *
   * 遍历是**显式栈**：Atom 可以很深（一条长调用链），递归会爆原生栈（t27/t18 的纪律）。
   */
  private checkAtoms(): void {
    for (const b of this.unit.blocks) {
      const work: CfgAtom[] = [];
      for (const s of b.stmts) work.push(s.value);
      if (b.term.type === "Branch") work.push(b.term.cond);
      if (b.term.type === "Ret") work.push(b.term.value);
      while (work.length > 0) {
        const a = work.pop()!;
        switch (a.type) {
          case "ALam":
            if (!this.known.has(a.unit)) {
              throw new CfgError(
                `[cfg] unit ${this.unit.name}：块 ${b.label} 里的 lambda 指向 unit ${a.unit}，但没有这个 unit`,
              );
            }
            break;
          case "APrim":
            for (const x of a.args) work.push(x);
            break;
          case "ACall":
            work.push(a.fn);
            for (const x of a.args) work.push(x);
            break;
          default:
            break;
        }
      }
    }
  }

  succ(label: string): readonly string[] {
    const s = this.succOf.get(label);
    if (s === undefined) throw new CfgError(`[cfg] 没有块 ${label}`);
    return s;
  }

  pred(label: string): readonly string[] {
    const p = this.predOf.get(label);
    if (p === undefined) throw new CfgError(`[cfg] 没有块 ${label}`);
    return p;
  }

  block(label: string): CfgBlock {
    const b = this.blockOf.get(label);
    if (b === undefined) throw new CfgError(`[cfg] 没有块 ${label}`);
    return b;
  }

  /** 从入口可达的块（显式栈）。 */
  reachable(): Set<string> {
    const seen = new Set<string>([this.unit.entry]);
    const work = [this.unit.entry];
    while (work.length > 0) {
      for (const s of this.succ(work.pop()!)) {
        if (!seen.has(s)) {
          seen.add(s);
          work.push(s);
        }
      }
    }
    return seen;
  }
}

/** 整个程序的图视图：每个 unit 一个 Cfg，外加 unit 名字表。 */
export class CfgProgram {
  readonly unitOf = new Map<string, Cfg>();
  /** 手写赋值，不是参数属性 —— 理由见 `eval.ts` 的 `Env`。 */
  readonly prog: CfgProg;

  constructor(prog: CfgProg) {
    this.prog = prog;
    // 先把名字收齐（ALam 的校验需要知道"有哪些 unit"），再建每一张图
    const names = new Set(prog.units.map((u) => u.name));
    for (const u of prog.units) {
      if (this.unitOf.has(u.name)) {
        throw new CfgError(`[cfg] unit 名字重复：${u.name}`);
      }
      this.unitOf.set(u.name, new Cfg(u, names));
    }
  }

  cfg(name: string): Cfg {
    const c = this.unitOf.get(name);
    if (c === undefined) throw new CfgError(`[cfg] 没有 unit ${name}`);
    return c;
  }

  /**
   * 调用图：unit → 它直接调用了哪些 unit。
   *
   * 从 Atom 里找 `ACall { fn: AVar{name} }` —— 名字对得上某个 unit 就是一条边。
   * 变着法子调（`((if c f g) 1)`）找不到就算了：这一层只要能支持后面的分析，
   * 不求完备，**但求"找不到的时候不假装找到了"**。
   */
  callGraph(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const u of this.prog.units) {
      const callees = new Set<string>();
      for (const b of u.blocks) {
        const work: CfgAtom[] = [];
        for (const s of b.stmts) work.push(s.value);
        if (b.term.type === "Branch") work.push(b.term.cond);
        if (b.term.type === "Ret") work.push(b.term.value);
        while (work.length > 0) {
          const a = work.pop()!;
          if (a.type === "ACall") {
            const fn = a.fn;
            if (fn.type === "AVar" && this.unitOf.has(fn.name)) callees.add(fn.name);
            work.push(fn);
            for (const x of a.args) work.push(x);
          } else if (a.type === "APrim") {
            for (const x of a.args) work.push(x);
          } else if (a.type === "ALam") {
            // lambda 值本身不调用谁（它的体在自己的 unit 里）
          }
        }
      }
      out.set(u.name, callees);
    }
    return out;
  }
}

export function buildCfg(prog: CfgProg): CfgProgram {
  return new CfgProgram(prog);
}
