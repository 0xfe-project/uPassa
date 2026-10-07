/**
 * Language declaration.
 *
 * A single declaration serves dual purpose: TS types for nodes, and traversal metadata for codegen.
 * No second source of truth - hand-written union types no longer exist.
 */

// ───────────────────────── Notation ─────────────────────────

/** Zero or more. One level of nesting corresponds to nanopass field-levels. */
export function list<const T extends string>(t: T): { readonly list: T } {
  return { list: t };
}

/** Optional. Corresponds to nanopass (maybe x). */
export function maybe<const T extends string>(t: T): { readonly maybe: T } {
  return { maybe: t };
}

/**
 * Host type registry. Extend via declaration merging:
 *
 *   declare module "../src/nanopass/lang.ts" {
 *     interface Hosts { symbol: symbol }
 *   }
 */
export interface Hosts {
  string: string;
  number: number;
  boolean: boolean;
}

// ───────────────────────── Shape of declarations ─────────────────────────

export type FieldDesc = string | { readonly list: FieldDesc } | { readonly maybe: FieldDesc };

export interface LangDecl {
  /** Language id. Written to each node's __lang__, and used in error messages. */
  readonly id: string;
  readonly entry: string;
  /**
   * Nonterminal → production (tag) → field name → field description.
   *
   * Intentionally only allows Record, not "production value is a string".
   * That form (transparent production: this production is just another nonterminal)
   * is tempting, but it lets
   *     Param: { name: "string" }        ← treating field name as tag
   * pass type checking, and Param's node type silently becomes never.
   * Add that feature later if needed, with proper subtyping mechanism.
   */
  readonly rules: Record<string, Record<string, Record<string, FieldDesc>>>;
}

export function language<const D extends LangDecl>(d: D): D {
  return d;
}

// ───────────────────────── Type inference ─────────────────────────

export type RulesOf<D> = D extends { rules: infer R } ? R : never;
export type Nonterminals<D> = keyof RulesOf<D> & string;
export type ProdsOf<D, NT extends Nonterminals<D>> = RulesOf<D>[NT];

type Host<T> = T extends keyof Hosts ? Hosts[T] : unknown;

/**
 * Single rule: field value matches rules key → child node; otherwise → host value.
 *
 * This determines both types (here) and traversal (codegen's isChild).
 * So "which fields to recurse" cannot drift from types - the "forget to mark rec,
 * silently don't recurse" bug structurally cannot happen.
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
 * Framework fields.
 *
 * __lang__  Filled by codegen - plain objects have no RTTI, can't tell
 *           "same tag, different language".
 * __meta__  Filled by frontend (line numbers, source file...), passes carry it
 *           to output nodes, else first rewrite loses it.
 *
 * Not in NodeOf. Tried adding directly to ProdNode, but recursive mapped types
 * with extra intersection immediately trigger TS2589 / "Two different types with
 * this name exist". So only use WithMeta wrapper at boundaries (fixtures, frontend output).
 */
export interface NodeMeta {
  readonly __lang__?: string;
  readonly __meta__?: unknown;
}

/** Add framework fields to a tree (or node). Use on fixtures and frontend output side. */
export type WithMeta<T> = T & NodeMeta;

export type ProdNode<D, P extends string, F> = {
  readonly [Q in keyof F | "type"]: Q extends "type" ? P : Q extends keyof F ? FieldType<D, F[Q]> : never;
};

/** Node union for a nonterminal. */
export type NodeOf<D, K extends string> =
  K extends Nonterminals<D>
    ? { [P in keyof ProdsOf<D, K>]: ProdNode<D, P & string, ProdsOf<D, K>[P]> }[keyof ProdsOf<D, K>]
    : never;

/** Node union for entry nonterminal, saves writing NodeOf<typeof L, "Expr"> each time. */
export type Nodes<D> = NodeOf<D, D extends { entry: infer E extends string } ? E : never>;

/** Is a field of a production a child node? Codegen uses this to decide whether to recurse. */
export function isChild(decl: LangDecl, tag: string, field: string): boolean {
  for (const prods of Object.values(decl.rules)) {
    const prod = prods[tag];
    if (prod !== undefined && typeof prod === "object" && field in prod) {
      return typeof prod[field] === "string" && prod[field] in decl.rules;
    }
  }
  return false;
}

// ───────────────────────── Derivation ─────────────────────────

/** Nonterminal → production → field name → field description */
type AddMap = Record<string, Record<string, Record<string, FieldDesc>>>;

/** Remove tags listed in RM from X. If X is transparent production (string), keep as-is. */
type Strip<X, RM> = X extends Record<string, unknown> ? Omit<X, Extract<RM, keyof X>> : X;

/**
 * How production tables merge: delete first (RM), then add (A **overrides** B).
 *
 * Must use Omit + intersection "override" semantics, not direct `A & B` -
 * redefining an existing production in add (e.g. adding field to Lam) is valid use,
 * but `{body: "Expr"} & {body: "Body"}` collapses to `body: never`, losing
 * the whole production.
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
 * Derive new language from existing one. Corresponds to nanopass (extends L)
 * plus +/- in terminals/production.
 *
 *   const L1 = derive({ id: "L1", base: Lsrc, remove: ["IfAlt"] });
 *   const L2 = derive({ id: "L2", base: Lsrc, add: { Expr: { Lit: { num: "number" } } } });
 *
 * Type-level is true merge: removed productions disappear from NodeOf, so using
 * it to write passes will error.
 * Codegen reads flattened rules here - derivation happens once, downstream sees complete language.
 */
export interface DeriveSpec<
  B extends LangDecl,
  I extends string,
  A extends AddMap,
  RM extends readonly string[],
> {
  /** New language id. */
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
  // Remove first, then add — the same order `MergeProds` describes. The other order silently
  // deletes a production that was just redefined, and the type level would still claim it exists.
  for (const tag of remove ?? []) for (const nt of Object.keys(rules)) delete rules[nt]![tag];
  for (const [nt, prods] of Object.entries((add ?? {}) as unknown as RM2)) {
    rules[nt] = { ...(rules[nt] ?? {}), ...prods };
  }
  return { id, entry: base.entry, rules } as never;
}
