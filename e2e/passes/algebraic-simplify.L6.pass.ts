/**
 * t12：第一批代数规则。全部 from === to（语言不变，L6）。
 *
 * 每条规则只说"什么形状能改成什么形状"。**终止靠两件事**（见 rewrite.ts）：
 *
 *   ① 项序（order）/ 正规形 —— 只往规范形改，改完就再也匹配不上
 *   ② 步数上限 —— 我写错了序时，报错退出而不是挂住
 *
 * ── 正规形：AC 正规形（展平 + 排序）
 *
 * `+` / `*` 的正规形是：**一棵展平、排好序的 n 元节点**。
 * `(* (+ a b) 2)` 这种是**违规的**，要么展平要么排序。
 *
 * ## 为什么不是"重结合成右嵌套" —— 这里踩过一次真的坑
 *
 * 一开始我把正规形定成"右结合 + 字面量排后面"。**这个正规形不存在**：
 *
 *     2 + (3 + (1 + 4))     ← 右结合，但 2 排在复合项前面，违反"字面量排后面"
 *     (2 + 3) + (1 + 4)     ← 字面量顺序对了，但左嵌套，违反右结合
 *
 * 两条规则各自都对，合起来**互相修**。改一次、再改回来，无限打转。跑真程序时被步数上限
 * 抓了个正着（报错说"最后在改的是 + 操作数规范化"）。根因不是实现 bug，是**正规形选错了**：
 * 在**二元**节点上，"操作数排序"和"结合律"不可能共存 —— 排一次序就把复合操作数挪到另一边，
 * 结合深度跟着变，重结合再改回来。
 *
 * 所以：**展平**。（这也正是 AC 正规形总要展平的原因。）展平之后没有"结合性"这个自由度
 * 可争了，排序是兄弟之间的事：
 *
 *     (+ (+ a b) (+ c d))  →  (+ a b c d)         展平
 *     (+ 2 (+ 3 (+ 1 4)))  →  (+ 1 2 3 4)         展平 + 排序
 *
 * 输出的 n 元节点交给管线里**之后**的 `normalize-prim-arity` 二值化（左嵌套）。
 * 所以这个 pass 要放在 `normalize-prim-arity` **之前** —— 顺序反了的话，压平的机会就没了。
 *
 * ## 浮点的诚实话
 *
 * 展平会改结合顺序，而 IEEE754 的加法/乘法**不满足结合律**（`1e16 + (-1e16) + 1` 就是
 * 例子）。所以展平对**浮点**不保值。这里做两层处理：
 *
 *   - 展平列表里只要出现 `Float` 字面量，这一条就不展平（保守，能测）；
 *   - 但 `Var` 背后可能是浮点，这个**这个 pass 不知道**。所以严格说：这是本 demo 语言的
 *     约定（`+`/`*` 按精确算术看待），不是通用做法。真编译器要么不开这个优化，要么用
 *     `-ffast-math` / 类型信息（t15 之后就有类型了，那时可以只对 Int 展平）。
 *
 * **排序本身永远是保值的**（加法和乘法满足交换律，IEEE754 也一样），所以只用排序的规则
 * 没有这个问题 —— 但排序和结合性不能共存（见上），所以它们被一起关掉了。
 */

import { P, rewrite, rule, type Rule } from "../rewrite.ts";
import { L6 } from "../langs/L6.lang.ts";

type Node = Record<string, unknown>;

const isKind = (x: unknown, t: string): boolean =>
  x !== null && typeof x === "object" && (x as Node)["type"] === t;

const isInt = (x: unknown): boolean => isKind(x, "Int");

const intVal = (x: unknown): number | null => (isInt(x) ? ((x as Node)["value"] as number) : null);

const isPrim = (x: unknown, op: string): boolean => isKind(x, "Prim") && (x as Node)["op"] === op;

function argsOf(m: ReadonlyMap<string, unknown>): Node[] {
  return (m.get("args") as Node[]) ?? [];
}

/** 排序键：变量 < 其它复合 < 字面量。字面量之间按字面量顺序。 */
function keyOf(x: Node): [number, string] {
  if (isKind(x, "Int") || isKind(x, "Float") || isKind(x, "Bool") || isKind(x, "Str")) {
    return [2, JSON.stringify(x)];
  }
  if (x["type"] === "Var") return [0, String(x["name"])];
  return [1, JSON.stringify(x)];
}

const CMP = (a: Node, b: Node): number => {
  const [ga, sa] = keyOf(a);
  const [gb, sb] = keyOf(b);
  return ga !== gb ? ga - gb : sa < sb ? -1 : sa > sb ? 1 : 0;
};

/** 这一串操作数里有没有浮点字面量（有就不展平 —— 见文件头"浮点的诚实话"）。 */
function hasFloatLit(xs: readonly Node[]): boolean {
  for (const x of xs) {
    if (isKind(x, "Float")) return true;
    if (isKind(x, "Prim")) {
      if (hasFloatLit(((x as { args?: Node[] }).args ?? []) as Node[])) return true;
    }
  }
  return false;
}

/** 把同一运算的嵌套节点展平成一串操作数。 */
function flatten(op: string, x: Node, out: Node[]): void {
  if (isPrim(x, op)) {
    for (const a of (x["args"] ?? []) as Node[]) flatten(op, a, out);
  } else {
    out.push(x);
  }
}

const prim = (op: string, args: unknown[]): Node => ({ type: "Prim", op, args });
const int = (value: number): Node => ({ type: "Int", value });

// ───────────────────────── ① 恒等元 / 吸收元 ─────────────────────────

/**
 * `+` 里的 0 全部丢掉；`*` 里的 1 全部丢掉；`*` 里有 0 就是 0。
 *
 * 不需要项序：改完操作数一定**变少**（或者整棵子树没了），不可能回头。
 */
function identityRules(): Rule<Node>[] {
  const strip = (op: string, identity: number): Rule<Node> =>
    rule(
      `${op} 里丢掉恒等元 ${identity}`,
      "Prim",
      P.of("Prim", { op: P.lit(op), args: P.any("args") }),
      (m) => {
        const args = argsOf(m);
        if (args.length < 2) return undefined;
        const kept = args.filter((a) => intVal(a) !== identity);
        if (kept.length === args.length) return undefined; // 一个都没丢
        if (kept.length === 0) return int(identity); // 全是恒等元
        if (kept.length === 1) return kept[0]!; // 只剩一个，节点白搭
        return prim(op, kept);
      },
    );

  const absorbZero: Rule<Node> = rule(
    "* 里有 0 就是 0",
    "Prim",
    P.of("Prim", { op: P.lit("*"), args: P.any("args") }),
    (m) => {
      const args = argsOf(m);
      if (args.length < 2) return undefined;
      return args.some((a) => intVal(a) === 0) ? int(0) : undefined;
    },
  );

  const unit: Rule<Node>[] = [
    rule("x - 0 → x", "Prim", P.of("Prim", { op: P.lit("-"), args: P.any("args") }), (m) => {
      const args = argsOf(m);
      if (args.length !== 2) return undefined;
      if (intVal(args[1]) === 0) return args[0]!;
      return undefined;
    }),
    rule("x / 0 → x", "Prim", P.of("Prim", { op: P.lit("/"), args: P.any("args") }), (m) => {
      const args = argsOf(m);
      if (args.length !== 2) return undefined;
      if (intVal(args[1]) === 1) return args[0]!;
      return undefined;
    }),
  ];

  return [absorbZero, strip("+", 0), strip("*", 1), ...unit];
}

// ───────────────────────── ② 强度削减 ─────────────────────────

/** `x * 2 → x + x`。按解释器能力定：这里没有移位，所以用加法。 */
function strengthRules(): Rule<Node>[] {
  return [
    rule(
      "x * 2 → x + x",
      "Prim",
      P.of("Prim", { op: P.lit("*"), args: P.any("args") }),
      (m) => {
        const args = argsOf(m);
        if (args.length !== 2) return undefined;
        const [a, b] = args as [Node, Node];
        if (intVal(a) === 2) return prim("+", [b, b]);
        if (intVal(b) === 2) return prim("+", [a, a]);
        return undefined;
      },
      // 项序：只往"没有乘法"的方向走。`x + x` 不是 `*`，匹配不上 → 只改一次。
      { order: (before) => isPrim(before, "*") },
    ),
  ];
}

// ───────────────────────── ③ AC 展平 + 排序 ─────────────────────────

/**
 * `+` / `*`：展平同一运算的嵌套，操作数排序，输出一个 n 元节点。
 *
 * 这就是正规形本身 —— 改完的结果**再也匹配不上这条规则**（原子节点、已排序、无同类嵌套），
 * 所以不需要额外的项序断言。收敛是结构性的，不是靠我写对了一个序。
 */
function acRules(): Rule<Node>[] {
  const forOp = (op: string): Rule<Node> =>
    rule(
      `${op} 展平 + 排序（AC 正规形）`,
      "Prim",
      P.of("Prim", { op: P.lit(op), args: P.any("args") }),
      (m) => {
        const args = argsOf(m);
        if (args.length < 2) return undefined;

        // ── 快路径：已经是正规形就别动
        //
        // 只在**操作数这一层**看（O(操作数个数)）：没有同类嵌套、而且已经有序。
        // 都满足的话展平就是原样、排序是空操作 —— 不用真去展平。
        // 关键是不能每个节点都扫一遍整棵子树，那就是 O(n²)（见 t22）。
        const nested = args.some((a) => isPrim(a, op));
        if (!nested) {
          let ordered = true;
          for (let i = 1; i < args.length; i++) {
            if (CMP(args[i - 1]!, args[i]!) > 0) {
              ordered = false;
              break;
            }
          }
          if (ordered) return undefined;
        }

        // ── 真要改：展平 + 浮点守卫 + 排序
        const flat: Node[] = [];
        for (const a of args) flatten(op, a, flat);
        // 浮点不展平（会改结合顺序；IEEE754 不满足结合律 —— 见文件头）
        if (hasFloatLit(flat)) return undefined;

        return prim(op, flat.slice().sort(CMP));
      },
    );

  return [forOp("+"), forOp("*")];
}

/** 全部规则，按顺序（先写的先试）。 */
export function algebraicRules(): Rule<Node>[] {
  return [...identityRules(), ...strengthRules(), ...acRules()];
}

/** 把它们变成一个 pass（L6 → L6）。 */
export const algebraicSimplify = rewrite("algebraic-simplify", L6, algebraicRules());
