/**
 * 语言声明。
 *
 * 一份声明同时是：节点的 TS 类型、以及 codegen 读的遍历元数据。
 * 没有第二份真相 —— 手写的 union 类型不再存在。
 */

// ───────────────────────── 记法 ─────────────────────────

/** 零或多个。嵌套一层就是 nanopass 的 field-levels。 */
export function list<const T extends string>(t: T): { readonly list: T } {
  return { list: t };
}

/** 可有可无。对应 nanopass 的 (maybe x)。 */
export function maybe<const T extends string>(t: T): { readonly maybe: T } {
  return { maybe: t };
}

/**
 * 宿主类型登记表。用声明合并扩展：
 *
 *   declare module "../src/lang.ts" {
 *     interface Hosts { symbol: symbol }
 *   }
 */
export interface Hosts {
  string: string;
  number: number;
  boolean: boolean;
}

// ───────────────────────── 声明的形状 ─────────────────────────

export type FieldDesc = string | { readonly list: FieldDesc } | { readonly maybe: FieldDesc };

export interface LangDecl {
  /** 语言 id。会写进每个节点的 __lang__，也是报错时的语言名。 */
  readonly id: string;
  readonly entry: string;
  /**
   * 非终结符 → 产生式(tag) → 字段名 → 字段描述。
   *
   * 这里故意只允许 Record，不再允许“产生式的值是个字符串”。那个形式（透明产生式：
   * 这个产生式就是另一个非终结符）很诱人，但它让
   *     Param: { name: "string" }        ← 把字段名当成了 tag
   * 也能通过类型检查，而且 Param 的节点类型会静默变成 never。
   * 要这个特性的时候再加，且得带子类型那套机制。
   */
  readonly rules: Record<string, Record<string, Record<string, FieldDesc>>>;
}

export function language<const D extends LangDecl>(d: D): D {
  return d;
}

// ───────────────────────── 类型的推导 ─────────────────────────

export type RulesOf<D> = D extends { rules: infer R } ? R : never;
export type Nonterminals<D> = keyof RulesOf<D> & string;
export type ProdsOf<D, NT extends Nonterminals<D>> = RulesOf<D>[NT];

type Host<T> = T extends keyof Hosts ? Hosts[T] : unknown;

/**
 * 唯一的规则：字段值能对上 rules 的键 → 子节点；否则 → 宿主值。
 *
 * 这一条同时决定类型（这里）和遍历（codegen 的 isChild）。所以「哪些字段要递归」
 * 不可能和类型漂移 —— 那个「漏标 rec 就静默不递归」的毛病在结构上不存在。
 */
type FieldType<D, F> = F extends string
  ? F extends Nonterminals<D>
    ? NodeOf<D, F>
    : Host<F>
  : F extends { readonly list: infer I extends FieldDesc }
    ? FieldType<D, I>[]
    : F extends { readonly maybe: infer I extends FieldDesc }
      ? FieldType<D, I> | undefined
      : never;

/**
 * 框架字段。
 *
 * __lang__  由 codegen 填 —— 裸对象没有 RTTI，分不清“同一个 tag 属于哪门语言”。
 * __meta__  由前端填（行号、源文件名……），pass 负责把它带到输出节点，不然第一次重写就丢了。
 *
 * 这两个不放进 NodeOf。试过直接拼到 ProdNode 上，结果是递归的映射类型里多一层交叉，
 * 立刻触发 TS2589 / “Two different types with this name exist”。所以只在边界（fixture、
 * 前端产物）用 WithMeta 套一下。
 */
export interface NodeMeta {
  readonly __lang__?: string;
  readonly __meta__?: unknown;
}

/** 给一棵树（或一个节点）加框架字段。用在夹具和前端产物那一侧。 */
export type WithMeta<T> = T & NodeMeta;

export type ProdNode<D, P extends string, F> = {
  readonly [Q in keyof F | "type"]: Q extends "type" ? P : Q extends keyof F ? FieldType<D, F[Q]> : never;
};

/** 某个非终结符的节点联合。 */
export type NodeOf<D, K extends string> =
  K extends Nonterminals<D>
    ? { [P in keyof ProdsOf<D, K>]: ProdNode<D, P & string, ProdsOf<D, K>[P]> }[keyof ProdsOf<D, K>]
    : never;

/** 入口非终结符的节点联合，省得每次写 NodeOf<typeof L, "Expr">。 */
export type Nodes<D> = NodeOf<D, D extends { entry: infer E extends string } ? E : never>;

/** 某个产生式的某个字段是不是子节点。codegen 用这个决定要不要递归。 */
export function isChild(decl: LangDecl, tag: string, field: string): boolean {
  for (const prods of Object.values(decl.rules)) {
    const prod = prods[tag];
    if (prod !== undefined && typeof prod === "object" && field in prod) {
      return typeof prod[field] === "string" && prod[field] in decl.rules;
    }
  }
  return false;
}

// ───────────────────────── 派生 ─────────────────────────

/** 非终结符 → 产生式 → 字段名 → 字段描述 */
type AddMap = Record<string, Record<string, Record<string, FieldDesc>>>;

/** 从 X 里删掉 RM 列出的那些 tag。X 是透明产生式（字符串）时原样保留。 */
type Strip<X, RM> = X extends Record<string, unknown> ? Omit<X, Extract<RM, keyof X>> : X;

/**
 * 产生式表怎么合：先删（RM），再加（A **覆盖** B）。
 *
 * 必须用 Omit + 交叉的「覆盖」语义，不能直接 `A & B` —— add 里重定义一个已有产生式
 * （比如给 Lam 添一个字段）是正当用法，而 `{body: "Expr"} & {body: "Body"}` 会塌成
 * `body: never`，整个产生式就没了。
 */
type MergeProds<B, A, RM extends readonly string[]> = Omit<Strip<B, RM[number]>, keyof A & string> & A;

export type MergeRules<BR, AR, RM extends readonly string[]> = {
  [NT in keyof BR | keyof AR]: MergeProds<
    NT extends keyof BR ? BR[NT] : {},
    NT extends keyof AR ? AR[NT] : {},
    RM
  >;
};

/**
 * 从一个语言派生新语言。对应 nanopass 的 (extends L) 加 terminals/production 里的 +/-。
 *
 *   const L1 = derive({ id: "L1", base: Lsrc, remove: ["IfAlt"] });
 *   const L2 = derive({ id: "L2", base: Lsrc, add: { Expr: { Lit: { num: "number" } } } });
 *
 * 类型层是真的合并：删掉的产生式会从 NodeOf 里消失，所以拿它去写 pass 会报错。
 * codegen 读的是这里摊平出来的 rules —— 派生只发生一次，下游看到的是完整语言。
 */
export interface DeriveSpec<
  B extends LangDecl,
  I extends string,
  A extends AddMap,
  RM extends readonly string[],
> {
  /** 新语言的 id。 */
  readonly id: I;
  readonly base: B;
  readonly add?: A;
  readonly remove?: RM;
}

export function derive<
  const B extends LangDecl,
  const I extends string,
  const A extends AddMap = {},
  const RM extends readonly string[] = [],
>({
  id,
  base,
  add,
  remove,
}: DeriveSpec<B, I, A, RM>): {
  readonly id: I;
  readonly entry: B["entry"];
  readonly rules: MergeRules<RulesOf<B>, A, RM>;
} {
  type RM2 = Record<string, Record<string, FieldDesc>>;
  const rules: RM2 = {};
  for (const [nt, prods] of Object.entries(base.rules as RM2)) rules[nt] = { ...prods };
  for (const [nt, prods] of Object.entries((add ?? {}) as unknown as RM2)) {
    rules[nt] = { ...(rules[nt] ?? {}), ...prods };
  }
  for (const tag of remove ?? []) for (const nt of Object.keys(rules)) delete rules[nt]![tag];
  return { id, entry: base.entry, rules } as never;
}
