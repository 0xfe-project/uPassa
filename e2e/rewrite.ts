/**
 * 重写规则引擎（t11）。
 *
 * 代数化简用起来应该是**一张表**，不是一堆手写 pass：
 *
 *   rewrite("simplify", [
 *     rule("x+0 → x", { op: "+", args: [P.x, { lit: 0 }] }, (m) => m.x),
 *     rule("交换律",   { op: "+", args: [P.a, P.b] }, (m) => add(m.b, m.a), { order: "commute" }),
 *   ])
 *
 * ── 终止纪律：两层
 *
 * 第一条是**项序**：只往"更规范"的方向改。没有它，交换律 `a+b → b+a` 会无限来回。
 * 规则可以带一个 `order` 断言，说"这次改写确实让项更靠规范形了"；不满足就不改。
 *
 * 第二条是**步数上限**：项序是人写的，写错了就会挂住。挂住是最坏的失败模式 —— 它不报错、
 * 不退出，只是永远跑下去。所以加一个上限，超了**报错退出**，并说清是哪条规则在打转。
 *
 * 两层都要。项序保证"正常情况下收敛"，上限保证"我写错了序"时能看见。
 *
 * ── 规则只对**一个节点**起作用
 *
 * 和 pass 一样：规则匹配一个节点、返回一个新节点（或者说不匹配）。子节点由遍历器递归。
 * 所以规则表可以跟 pass 一样融进管线。
 *
 * ── 为什么不在这里做不动点
 *
 * "跑到不再变"是 t13 的事。这个引擎只管**一遍自底向上**：先递归子节点，再在父节点上试
 * 匹配。一遍能折的东西（`(+ 0 (+ 0 x))` 这种）靠自底向上就够；要多轮才收敛的（比如重结合
 * 之后又能触发交换律）留给 t13 的驱动器。
 */

import type { NodeOf } from "../src/nanopass/lang.ts";
import type { LangDecl } from "../src/nanopass/lang.ts";
import { buildWalkerDynamic, type WalkerSpec } from "../src/nanopass/codegen.ts";
import type { Step } from "./runner.ts";

// ───────────────────────── 模式 ─────────────────────────

/** 一个模式：要么匹配某个子树的形状，要么匹配一个字面量的值。 */
export type Pat =
  /** 匹配任意节点/值，绑到这个名字。 */
  | { readonly bind: string }
  /** 匹配带这个 tag 的节点，字段按 fields 匹配。 */
  | { readonly of: string; readonly fields: Readonly<Record<string, Pat>> }
  /** 匹配一个宿主字面量（数字/布尔/字符串），按 `===` 比。 */
  | { readonly lit: number | boolean | string };

export const P = {
  /** 绑一个名字，匹配任何东西。 */
  any(name: string): Pat {
    return { bind: name };
  },
  /** 匹配 tag 是 `tag` 的节点，字段按 `fields` 匹配（没写的字段不管）。 */
  of(tag: string, fields: Readonly<Record<string, Pat>>): Pat {
    return { of: tag, fields };
  },
  /** 匹配一个字面量值。 */
  lit(v: number | boolean | string): Pat {
    return { lit: v };
  },
};

/** 绑定环境：名字 → 匹配到的节点或值。 */
export type Bindings = Map<string, unknown>;

function matchPat(pat: Pat, x: unknown, into: Bindings): boolean {
  if ("bind" in pat) {
    into.set(pat.bind, x);
    return true;
  }
  if ("lit" in pat) {
    return x === pat.lit;
  }
  // of
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const node = x as Record<string, unknown>;
  if (node["type"] !== pat.of) return false;
  for (const [f, sub] of Object.entries(pat.fields)) {
    if (!matchPat(sub, node[f], into)) return false;
  }
  return true;
}

// ───────────────────────── 规则 ─────────────────────────

/** 一条规则能匹配哪些 tag。用来在生成期分派。 */
export interface Rule<O> {
  readonly name: string;
  /** 匹配的 tag（节点类型）。 */
  readonly tag: string;
  readonly pattern: Pat;
  /** 匹配成功就返回新节点（或 undefined 表示"匹配了但这次不改"）。 */
  readonly build: (m: Bindings) => O | undefined;
  /**
   * 项序断言：返回 true 表示"这次改写确实更靠规范形了"。
   * 没有就是"随便改" —— 那样规则必须自己能保证终止（比如恒等式只会让项变小）。
   */
  readonly order?: ((before: unknown, after: O) => boolean) | undefined;
}

export function rule<O>(
  name: string,
  tag: string,
  pattern: Pat,
  build: (m: Bindings) => O | undefined,
  opts?: { order?: (before: unknown, after: O) => boolean },
): Rule<O> {
  return { name, tag, pattern, build, order: opts?.order };
}

// ───────────────────────── 步数上限 ─────────────────────────

/**
 * 每个**节点**最多允许改多少步。超了就是哪条规则在打转。
 *
 * 为什么不是"一次 run 最多改 N 步"那样的绝对值（第一版就是）：**大输入合法地需要更多次
 * 改写**。一个 8000 个函数的程序里光 `x*2 → x+x` 就有 8000 次命中，绝对值定 10000 的话
 * 它会被判成"在打转" —— 而它其实规规矩矩地在收敛。
 *
 * 按节点数给预算就对上了："打转"是**每节点**都要改很多次（不终止），而收敛的规则集
 * 每个节点改常数次。所以这个数只要比"收敛时每节点平均改几次"大一点就够，给到 32 很宽。
 *
 * 下限 1000 是给很小的输入留的余量（10 个节点的输入也允许改 1000 次）。
 */
import { MIN_MAX_STEPS, rewriteBudget, RewriteLimit, rewriteLoop, STEPS_PER_NODE } from "./loops.ts";
export { MIN_MAX_STEPS, STEPS_PER_NODE, RewriteLimit };

/** 用来数步数的状态（走 extra formal，这样每次 run 都从 0 开始）。 */
interface Counter {
  /** 这一轮改了多少步（累计，用来撞上限）。 */
  n: number;
  /** 撞上限时是哪条规则在改。报错要用。 */
  last: string;
  /** 这一轮有没有改过任何东西。驱动"跑到不动点"用。 */
  changed: boolean;
}

// ───────────────────────── 生成 pass ─────────────────────────

/**
 * 把一张规则表变成一个 pass（from === to，语言不变）。
 *
 * 匹配在**一层**上做：遍历器先递归子节点，再在父节点上按 tag 试规则。所以
 * `(+ 0 (+ 0 x))` 一遍就能折成 `x`。
 */
export function rewrite<L extends LangDecl, O = NodeOf<L, L["entry"]>>(
  name: string,
  lang: L,
  rules: readonly Rule<O>[],
  opts?: { maxSteps?: number },
): RewriteStep<L["id"], L["id"]> {
  const maxSteps = opts?.maxSteps ?? -1; // -1 = 按输入节点数现算

  // 按 tag 分派 —— 生成期就把表建好，运行期只查一次
  const byTag = new Map<string, Rule<O>[]>();
  for (const r of rules) {
    const list = byTag.get(r.tag) ?? [];
    list.push(r);
    byTag.set(r.tag, list);
  }

  /**
   * 这里 `rec` 的返回是**真的元组** `[unknown, Counter]`（不是 `unknown`）—— 下面按
   * `[0]` / `[1]` 取结果，所以要能索引、要能解构。写成 `unknown` 的话调用点得靠 cast
   * 才活得下去，而那等于把检查关掉。
   */
  type Handler = (
    n: unknown,
    rec: (x: unknown, c: Counter) => readonly [unknown, Counter],
    c: Counter,
  ) => readonly [unknown, Counter];

  /** 一个字段描述是子节点（哪种形状）还是宿主值。 */
  type Shape =
    | { kind: "copy" }
    | { kind: "node"; nt: string }
    | { kind: "list"; nt: string }
    | { kind: "maybe"; nt: string };

  function shapeOf(decl: LangDecl, d: unknown): Shape {
    const isNT = (x: unknown): x is string => typeof x === "string" && x in decl.rules;
    if (typeof d === "string") return isNT(d) ? { kind: "node", nt: d } : { kind: "copy" };
    if (d !== null && typeof d === "object" && "list" in d) {
      const inner = (d as { list: unknown }).list;
      return isNT(inner) ? { kind: "list", nt: inner } : { kind: "copy" };
    }
    if (d !== null && typeof d === "object" && "maybe" in d) {
      const inner = (d as { maybe: unknown }).maybe;
      return isNT(inner) ? { kind: "maybe", nt: inner } : { kind: "copy" };
    }
    return { kind: "copy" };
  }

  const handlers: Record<string, Record<string, Handler>> = {};

  for (const [nt, prods] of Object.entries(lang.rules)) {
    const per: Record<string, Handler> = {};
    for (const [tag, fields] of Object.entries(prods)) {
      const rs = byTag.get(tag);
      if (rs === undefined) continue; // 这个产生式没有规则 —— 交给遍历器的 identity 走
      per[tag] = (
        n: unknown,
        rec: (x: unknown, c: Counter) => readonly [unknown, Counter],
        c: Counter,
      ): readonly [unknown, Counter] => {
        const node = n as Record<string, unknown>;

        // ① 先递归子节点（自底向上）。handler 是叶子，遍历器不会帮我们下降。
        //    这一步**不管有没有规则命中都要做**，不然规则看不到子节点已经被化简过。
        let changed = false;
        const rebuilt: Record<string, unknown> = { ...node };
        for (const [f, d] of Object.entries(fields as Record<string, unknown>)) {
          const sh = shapeOf(lang, d);
          if (sh.kind === "copy") continue;
          const before = node[f];
          if (sh.kind === "node") {
            const after = rec(before as never, c)[0];
            if (after !== before) changed = true;
            rebuilt[f] = after;
          } else if (sh.kind === "list") {
            const arr = (before ?? []) as unknown[];
            const out = arr.map((x) => rec(x as never, c)[0]);
            if (out.some((x, i) => x !== arr[i])) changed = true;
            rebuilt[f] = out;
          } else {
            if (before === undefined) continue;
            const after = rec(before as never, c)[0];
            if (after !== before) changed = true;
            rebuilt[f] = after;
          }
        }

        // ② 在这个节点上试规则。**第一条命中的就够**（规则表按顺序，先写的优先）。
        for (const r of rs) {
          const m: Bindings = new Map();
          if (!matchPat(r.pattern, rebuilt, m)) continue;
          const out = r.build(m);
          if (out === undefined) continue;
          if (r.order !== undefined && !r.order(rebuilt, out)) continue; // 项序不让改
          c.n += 1;
          c.last = r.name;
          c.changed = true;
          if (c.n > budget) {
            throw new RewriteLimit(
              `[${name}] 改写超过 ${budget} 步（输入 ${budget / STEPS_PER_NODE} 个节点 × 每节点 ${STEPS_PER_NODE}） —— 大概率是哪条规则的项序写错了，在打转。\n` +
                `  最后在改的是："${r.name}"。\n` +
                `  要么给这条规则加 order（只往规范形改），要么把它拆成不会来回的两条。`,
            );
          }
          return [out, c];
        }

        // ③ 没有规则命中：子节点改过就用新的，没改过就原样还回去（省一次分配）
        return [changed ? rebuilt : node, c];
      };
    }
    handlers[nt] = per;
  }

  // ── 跑到不动点
  //
  // 一遍只改每个节点一次，所以 ping-pong 的规则表（`a+b ⇄ b+a`）在一遍里看不出来 ——
  // 必须多轮。一轮 = 一次完整遍历；这一轮一步都没改就是不动点。
  //
  // "有没有改过"是个布尔（每命中一条规则置 true），不是全量深比较 —— 那正是 t13 验收④
  // 说的"不动点判定不能每次全量深比较"。
  // 每次 run 都得有**自己的**计数器。共享一个的话，上一次 run 的步数会漏到下一次，
  // 上限就变成"累计上限"了 —— 跑第五遍时可能第一轮就撞线。（踩过一次。）
  let counter: Counter = { n: 0, last: "", changed: false };
  /** 当前这次 run 的步数预算。按输入节点数现算 —— handler 要读它，所以在闭包这一层。 */
  let budget = MIN_MAX_STEPS;
  const spec = {
    from: lang,
    to: lang,
    arity: 1,
    init: (): unknown[] => [counter],
    rules: handlers,
  } as never;
  /** **惰性**：装载管线声明时不该编代码（生成物由 pnpm gen 出，见 e2e/link.ts）。 */
  let walker: { run: (n: unknown) => unknown } | undefined;
  // 动态 spec（规则表是运行期拼的）→ 显式走松的那条路
  const getWalker = (): { run: (n: unknown) => unknown } => (walker ??= buildWalkerDynamic(spec));

  /** 数输入有多少个节点（显式栈，深输入不占原生栈）。 */
  function countNodes(x: unknown): number {
    let n = 0;
    const work: unknown[] = [x];
    while (work.length > 0) {
      const cur = work.pop();
      if (cur === null || typeof cur !== "object") continue;
      if (Array.isArray(cur)) {
        for (const y of cur) work.push(y);
        continue;
      }
      n += 1;
      for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
        if (k === "__meta__" || k === "__lang__") continue;
        work.push(v);
      }
    }
    return n;
  }

  /**
   * 每次 run 的**一次性准备**：重置计数器（不重置的话上一次 run 的步数会漏过来）、
   * 按**输入节点数**算这次的步数预算。它也是链接产物重建这一步的入口。
   */
  const setup = (input: unknown): void => {
    counter = { n: 0, last: "", changed: false };
    budget = rewriteBudget(input, maxSteps);
  };

  /** 循环本身住在 loops.ts（链接产物也要用它重建这一步）。 */
  const run = (input: unknown): unknown => {
    setup(input);
    return rewriteLoop((x) => getWalker().run(x), name)(input);
  };

  return {
    name,
    from: lang.id,
    to: lang.id,
    arity: 1,
    spec: spec as WalkerSpec,
    run,
    // `source` 留空：产物（pnpm gen）才是生成物的唯一来源
    source: "",
    // 逻辑在 run 里（不动点循环 + 计数器），从 spec 重建会丢 —— 见 runner.ts 的 Step.opaque
    opaque: true,
    loop: { kind: "rewrite", maxRounds: Number.MAX_SAFE_INTEGER, setup },
    // 但蹦床路径可以救回来：循环和计数器是**外加的**，只要外层再包一遍就行
    rebuild: (mk) => {
      // 重建出来的是**遍历器**；循环（不动点 + 步数预算）还得套上 ——
      // 少了这一步，兜底会静默地把"跑到不动点"变成"只跑一轮"。
      const w = mk(spec);
      return (input: unknown) => {
        setup(input);
        return rewriteLoop((x) => w.run(x), name)(input);
      };
    },
    ruleCount: rules.length,
  };
}

/**
 * 长得跟管线里的 `Step` 一样，多带一个"表里几条规则"。
 *
 * `F`/`T` 是**字面量**的 id（`Step` 的默认参数是 `string`）—— 不写明的话这里会被宽化，
 * 而 `pipeline()` 的链条校验就是靠这两个字面量比的（宽了就比不出来了）。
 */
export interface RewriteStep<F extends string = string, T extends string = string> extends Step<F, T> {
  readonly ruleCount: number;
}
