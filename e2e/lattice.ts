/**
 * 带类型的常量格（t14）。
 *
 * 单遍传播用的环境是"名字 → 字面量节点"，不认识就不在表里。那是**一个集合**，
 * 不是格 —— 因为单遍从头到尾只走一次，没有"两个信息汇合"这件事。
 *
 * 要迭代（跑到不动点）就必须有汇合：同一个名字可能在不同来源上推出不同的结论，
 * 得有一个"取二者共同信息"的操作。那就是格。
 *
 * ── 这个格的四层
 *
 *        ⊤               什么都不知道（也可能是"结论太杂，放弃了"）
 *        │
 *      Ty(t)             知道类型是 t，但不知道值
 *        │
 *    Const(v, t)          知道值（也当然知道类型）
 *        │
 *        ⊥               还没算出来
 *
 * `join` 取两个结论里**更差**的那个（共同信息）。几条关键规则：
 *
 *   Const(1, Int) ⊔ Const(2, Int) = Ty(Int)      —— 两个不同常量，值丢了，但类型还在
 *   Const(1, Int) ⊔ Const(1, Int) = Const(1, Int) —— 一样就保留
 *   Const(1, Int) ⊔ Const(1.0, Float) = ⊤         —— **类型不同，连类型都不敢说了**
 *
 * 最后那条是"带类型"的意义所在：这门语言里 `1` 和 `1.0` 不是一回事（见 README 里
 * constant-fold 那节的说明）。所以格元素带类型，不是裸值。
 *
 * ── 和验收里那句"merge 成 ⊤"的差别（说清楚）
 *
 * 验收说的是"if 两支常量不同时 merge 成 ⊤"。这里**不是** ⊤，是 `Ty(t)` ——
 * "值不知道了，但类型还在"。要说的是同一件事：**值不再往下传了**（不会再拿它替换
 * 变量引用）。差别只在"还留着多少信息"，而多留的那点类型信息正是格带了类型才有的。
 * 真的 ⊤ 留给"类型都推不出来"的情况（比如两支一个是 Int 一个是 Float）。
 */

export type Ty = "Int" | "Float" | "Str" | "Bool" | "Void" | "Fn";

export type Lat =
  /** 还没算出来。 */
  | { readonly k: "bot" }
  /** 知道值，也当然知道类型。 */
  | { readonly k: "const"; readonly value: number | boolean | string; readonly ty: Ty }
  /** 知道类型，不知道值。 */
  | { readonly k: "ty"; readonly ty: Ty }
  /** 什么都不知道。 */
  | { readonly k: "top" };

export const BOT: Lat = { k: "bot" };
export const TOP: Lat = { k: "top" };

/** 宿主字面量的类型。 */
export function tyOfValue(v: unknown): Ty | null {
  switch (typeof v) {
    case "number":
      return Number.isInteger(v) ? "Int" : "Float";
    case "boolean":
      return "Bool";
    case "string":
      return "Str";
    default:
      return null;
  }
}

/** 字面量节点 → 格元素。不是字面量就是 ⊥（"这里没有信息"，不是"这是 ⊤"）。 */
export function latOfLit(x: unknown): Lat {
  if (x === null || typeof x !== "object") return BOT;
  const n = x as { type?: string; value?: number | boolean | string };
  // `Float` 节点带着数字，但类型上是 Float —— 不能只看 typeof
  if (n.type === "Int" || n.type === "Float" || n.type === "Bool" || n.type === "Str") {
    const ty = n.type as Ty;
    return { k: "const", value: n.value as number | boolean | string, ty };
  }
  return BOT;
}

/** 取两个结论的**共同信息**（更差的那个）。 */
export function join(a: Lat, b: Lat): Lat {
  if (a.k === "bot") return b;
  if (b.k === "bot") return a;
  if (a.k === "top" || b.k === "top") return TOP;
  if (a.k === "const" && b.k === "const") {
    // 值和类型都一样才算一样。`1` 和 `1.0` 类型不同 → 只留类型？不，类型都不同 → ⊤
    if (a.ty === b.ty && a.value === b.value) return a;
    return a.ty === b.ty ? { k: "ty", ty: a.ty } : TOP;
  }
  if (a.k === "ty" && b.k === "ty") return a.ty === b.ty ? a : TOP;
  // 一个 const 一个 ty
  const c = a.k === "const" ? a : (b as Extract<Lat, { k: "const" }>);
  const t = a.k === "ty" ? a : (b as Extract<Lat, { k: "ty" }>);
  return c.ty === t.ty ? { k: "ty", ty: c.ty } : TOP;
}

/** 印出来给人看（报错、测试断言用）。 */
export function showLat(l: Lat): string {
  switch (l.k) {
    case "bot":
      return "⊥";
    case "top":
      return "⊤";
    case "ty":
      return `Ty(${l.ty})`;
    case "const":
      return `Const(${String(l.value)}:${l.ty})`;
  }
}

/** 只有这是一个真正的常量时，才拿它去替换变量引用。 */
export function constValue(l: Lat): { value: number | boolean | string; ty: Ty } | null {
  return l.k === "const" ? { value: l.value, ty: l.ty } : null;
}

/** 按类型造一个字面量节点。 */
export function litNode(l: Extract<Lat, { k: "const" }>): Record<string, unknown> {
  return { type: l.ty, value: l.value };
}
