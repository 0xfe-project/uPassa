/**
 * 常量折叠（L6 → L6，语言不变）
 *
 *   (+ 1 2)        → 3
 *   (* 2 (+ 1 2))  → 6          （自底向上，一遍就折干净）
 *   (if #t a b)    → a          （丢掉整棵 b）
 *   (if #f a b)    → b
 *   (if x a b)     → 原样
 *
 * **这条是让判定标准真正咬人的那一条。**
 * 其余的去糖 pass 都是"形状变了但值不变" —— 写错了 tag 不对，可算出来的数还是对的。
 * 只有常量折叠会算出**错的值**。没有它，`eval(src) === 期望` 有一半是空的。
 *
 * 它同时压到框架三件事：from === to、**丢掉一棵子树**（不遍历它）、**换个产生式**
 * （Prim → Int/Float/Bool）。
 *
 * 丢掉子树在这里是安全的：Lcore 没有赋值、没有副作用。（真加了 set! 就得先判断
 * 被丢掉的支纯不纯。）
 *
 * 注意 Int / Float 要分清楚 —— 折叠不能把整数变成浮点，反过来也不行。
 */

import type { NodeOf } from "../../src/lang.ts";
import { pass } from "../../src/pass.ts";
import { L6 } from "../langs/L6.lang.ts";

type InExpr = NodeOf<typeof L6, "Expr">;
type OutExpr = NodeOf<typeof L6, "Expr">;

type Num = { readonly kind: "int" | "float"; readonly v: number };

/** 是个数字字面量吗？ */
function asNum(e: InExpr): Num | null {
  if (e.type === "Int") return { kind: "int", v: e.value };
  if (e.type === "Float") return { kind: "float", v: e.value };
  return null;
}

/** 折叠的结果该是 Int 还是 Float：全整数且结果也是整数 → Int，否则 Float。 */
function numNode(kind: "int" | "float", v: number): OutExpr {
  return kind === "int" && Number.isInteger(v) ? { type: "Int", value: v } : { type: "Float", value: v };
}

function foldArith(op: string, nums: Num[]): OutExpr | null {
  const vs = nums.map((n) => n.v);
  const allInt = nums.every((n) => n.kind === "int");
  const first = vs[0]!;

  let out: number;
  switch (op) {
    // 用下标循环而不是 vs.slice(1).reduce(...) —— slice 会为每个 Prim 节点多造一个数组。
    // （这一步跑在每个原语节点上，所以是热路径。）
    case "+":
      out = 0;
      for (let i = 0; i < vs.length; i++) out += vs[i]!;
      break;
    case "*":
      out = 1;
      for (let i = 0; i < vs.length; i++) out *= vs[i]!;
      break;
    case "-":
      out = first;
      if (vs.length === 1) out = -first;
      else for (let i = 1; i < vs.length; i++) out -= vs[i]!;
      break;
    case "/":
      if (vs.length === 2 && vs[1] === 0) return null; // 不折除零，留给运行期报错
      out = first;
      if (vs.length === 1) out = 1 / first;
      else for (let i = 1; i < vs.length; i++) out /= vs[i]!;
      break;
    case "modulo":
      if (vs.length !== 2 || vs[1] === 0) return null;
      out = first - Math.trunc(first / vs[1]!) * vs[1]!;
      break;
    case "<":
      return { type: "Bool", value: vs.every((n, i) => i === 0 || vs[i - 1]! < n) };
    default:
      return null;
  }
  return numNode(allInt ? "int" : "float", out);
}

function foldEquality(args: InExpr[]): OutExpr | null {
  // 只折同类的字面量；混合类型留到类型检查那期去管
  const kinds = new Set(args.map((a) => a.type));
  if (kinds.size !== 1) return null;
  const kind = args[0]!.type;
  if (kind === "Bool" || kind === "Str") {
    const vs = args.map((a) => (a as { value: boolean | string }).value);
    return { type: "Bool", value: vs.every((v, i) => i === 0 || vs[i - 1] === v) };
  }
  if (kind === "Int" || kind === "Float") {
    const vs = args.map((a) => (a as { value: number }).value);
    return { type: "Bool", value: vs.every((v, i) => i === 0 || vs[i - 1] === v) };
  }
  return null;
}

export const constantFold = pass({
  from: L6,
  to: L6,
  rules: {
    Expr: {
      Prim: (n, rec): OutExpr => {
        const args = rec(n.args);

        if (n.op === "=") {
          const folded = args.every(isLiteral) ? foldEquality(args) : null;
          if (folded !== null) return folded;
          return { type: "Prim", op: n.op, args };
        }

        const nums = args.map(asNum);
        if (nums.every((x) => x !== null)) {
          const folded = foldArith(n.op, nums as Num[]);
          if (folded !== null) return folded;
        }
        return { type: "Prim", op: n.op, args };
      },

      // 条件折成字面量之后，只递归**活着的那一支** —— 另一支整棵丢掉
      If: (n, rec): OutExpr => {
        const cond = rec(n.cond);
        if (cond.type === "Bool") return cond.value ? rec(n.then) : rec(n.alt);
        return { type: "If", cond, then: rec(n.then), alt: rec(n.alt) };
      },
    },
  },
});

function isLiteral(e: InExpr): boolean {
  return e.type === "Int" || e.type === "Float" || e.type === "Bool" || e.type === "Str";
}
