/**
 * codegen: Generate traversers from language declaration shapes.
 *
 * What's generated is a walk function + a rec. The shape is completely determined by the declarations
 * of the two languages, so the handlers you write are black boxes — we don't read source code, don't parse TS,
 * don't eval user code.
 *
 * Three things error at generation time, not left to runtime:
 *   1. Input language has a production, output language doesn't, and you didn't provide a handler
 *   2. On the identity path, the fields don't match for the same tag in input/output
 *   3. The same tag appears in two non-terminals — then rec can't dispatch by tag
 *
 * arity = 0 generates "node in, node out". arity = k > 0 generates "node + k values in,
 * node + k values out", and these k values are **threaded**: the extra returned by one child
 * becomes the extra parameter for the next sibling. So identity clauses can't be written as
 * `a: walk(n.a), b: walk(n.b)`, must be written as multiple assignment steps where a is called first
 * and its result fed to b.
 */

import type { FieldDesc, LangDecl, NodeOf } from "./lang.ts";
import type { Pass, Rec } from "./pass.ts";

export class CodegenError extends Error {}

/**
 * What codegen needs. Intentionally wider than Pass — the generator only cares about shape and arity,
 * not type parameters. Pass<F, O, Ctx> structurally satisfies this.
 */
export interface WalkerSpec {
  readonly from: LangDecl;
  readonly to: LangDecl;
  readonly arity: number;
  /** Initial value for extra parameters (a fresh copy per run). */
  readonly init?: (() => unknown[]) | undefined;
  readonly rules: { readonly [nt: string]: { readonly [tag: string]: unknown } | undefined };
}

type Prod = Record<string, FieldDesc>;

const s = (x: string): string => JSON.stringify(x);

function isNT(decl: LangDecl, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(decl.rules, name);
}

/** Whether a field is a child node or a host value; if a child node, what shape. */
type Shape =
  | { kind: "copy" }
  | { kind: "node"; nt: string }
  | { kind: "list"; nt: string }
  | { kind: "maybe"; nt: string };

function shapeOf(decl: LangDecl, d: FieldDesc, where: string): Shape {
  if (typeof d === "string") return isNT(decl, d) ? { kind: "node", nt: d } : { kind: "copy" };
  if ("list" in d) {
    const inner = d.list;
    if (typeof inner !== "string") {
      throw new CodegenError(
        `[codegen] ${where}: nested list not yet supported — define a new non-terminal layer.`,
      );
    }
    return isNT(decl, inner) ? { kind: "list", nt: inner } : { kind: "copy" };
  }
  const inner = d.maybe;
  if (typeof inner !== "string") {
    throw new CodegenError(`[codegen] ${where}: nested maybe not yet supported.`);
  }
  return isNT(decl, inner) ? { kind: "maybe", nt: inner } : { kind: "copy" };
}

function sameShape(a: Shape, b: Shape): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "copy") return true;
  return (a as { nt: string }).nt === (b as { nt: string }).nt;
}

function describe(sh: Shape): string {
  return sh.kind === "copy" ? "host value" : `${sh.kind}:${(sh as { nt: string }).nt}`;
}

/** Generation-time check: same tag can't belong to two non-terminals, otherwise rec doesn't know where to go. */
function checkTagUniqueness(spec: WalkerSpec): void {
  const seen = new Map<string, string>();
  for (const [nt, prods] of Object.entries(spec.from.rules)) {
    for (const tag of Object.keys(prods)) {
      const prev = seen.get(tag);
      if (prev !== undefined && prev !== nt) {
        throw new CodegenError(
          `[${spec.from.id}] production ${s(tag)} appears in both non-terminal ${s(prev)} and ${s(nt)}. ` +
            `rec dispatches by tag, so a tag can only belong to one non-terminal.`,
        );
      }
      seen.set(tag, nt);
    }
  }
}

/** Check whether fields can match for the same tag in input/output. */
function checkFields(spec: WalkerSpec, nt: string, tag: string, inProd: Prod, outProd: Prod): void {
  for (const [f, d] of Object.entries(inProd)) {
    if (!(f in outProd)) {
      throw new CodegenError(
        `[${spec.from.id} -> ${spec.to.id}] ${s(`${nt}.${tag}`)}.${f}: input language has this field, ${spec.to.id} doesn't.`,
      );
    }
    const a = shapeOf(spec.from, d, `${nt}.${tag}.${f}`);
    const b = shapeOf(spec.to, outProd[f] as FieldDesc, `${nt}.${tag}.${f}`);
    if (!sameShape(a, b)) {
      throw new CodegenError(
        `[${spec.from.id} -> ${spec.to.id}] ${s(`${nt}.${tag}`)}.${f}: field shapes don't match (` +
          `${describe(a)} vs ${describe(b)}). identity can only handle same-shaped fields automatically; ` +
          `different shapes require a handler.`,
      );
    }
  }
  for (const f of Object.keys(outProd)) {
    if (!(f in inProd)) {
      throw new CodegenError(
        `[${spec.from.id} -> ${spec.to.id}] ${s(`${nt}.${tag}`)}.${f}: ${spec.to.id} has this field but input language doesn't, ` +
          `identity can't fill it.`,
      );
    }
  }
}

/** Generate an identity clause: recurse along input fields, produce output language node. */
function emitIdentity(
  spec: WalkerSpec,
  nt: string,
  tag: string,
  inProd: Prod,
  outProd: Prod | undefined,
): string {
  if (outProd === undefined) {
    throw new CodegenError(
      `[${spec.from.id} -> ${spec.to.id}] production ${s(`${nt}.${tag}`)} has no corresponding item in ${spec.to.id}, ` +
        `and you didn't provide a handler — either add a rule or remove it from the input language.`,
    );
  }
  checkFields(spec, nt, tag, inProd, outProd);

  const k = spec.arity;
  const ctxVars = Array.from({ length: k }, (_, i) => `c${i}`);
  const props: string[] = [`type: ${s(tag)}`];
  let tmp = 0;

  // Only same-language passes allow "return original object if unchanged".
  //
  // Why: when switching languages, finish stamps the node with the new __lang__; reusing the original
  // object would leave its __lang__ on the old language — that's a semantic change, not an optimization.
  // For same-language passes __lang__ is already the same, reuse makes no difference.
  //
  // Two benefits, both real:
  //   ① Fixed-point determination can check just the root node's **reference** (O(1)) — no need for
  //      full deep comparison each round (t13 acceptance ④)
  //   ② Unchanged subtrees no longer reallocate on every pass
  const canReuse = spec.from.id === spec.to.id;

  /** Element-wise reference comparison — lists also shouldn't be rebuilt unnecessarily. */
  const sameList = `sameList`;

  // k === 0: don't collect extra, compute child nodes and put them directly in properties, track "changed".
  if (k === 0) {
    const decls: string[] = [];
    const checks: string[] = [];
    for (const [f, d] of Object.entries(inProd)) {
      const sh = shapeOf(spec.from, d, `${nt}.${tag}.${f}`);
      if (sh.kind === "copy") {
        props.push(`${s(f)}: n.${f}`);
        continue;
      }
      const v = `v${tmp++}`;
      if (sh.kind === "node") {
        decls.push(`const ${v} = walk_${sh.nt}(n.${f});`);
        checks.push(`${v} !== n.${f}`);
      } else if (sh.kind === "list") {
        decls.push(`const ${v} = n.${f}.map(walk_${sh.nt});`);
        checks.push(`!${sameList}(${v}, n.${f})`);
      } else {
        decls.push(`const ${v} = n.${f} === undefined ? undefined : walk_${sh.nt}(n.${f});`);
        checks.push(`${v} !== n.${f}`);
      }
      props.push(`${s(f)}: ${v}`);
    }
    const obj = `finish(n, { ${props.join(", ")} })`;
    // Leaf nodes (no child fields at all) are always "unchanged" — the constructed object has the same
    // structure as n, so it's a waste to allocate. **Without this special case, references will never
    // be equal**, and fixed-point determination will never reach it (been there).
    const assign = !canReuse ? obj : checks.length === 0 ? "n" : `(${checks.join(" || ")}) ? ${obj} : n`;
    if (decls.length === 0) return `      out = ${assign};`;
    return `      {\n${indent(`${decls.join("\n")}\n${k === 0 ? "out" : "out"} = ${assign};`, "        ")}\n      }`;
  }

  // k > 0: must collect extra in order, so need statements.
  const stmts: string[] = [`let changed = false;`];
  for (const [f, d] of Object.entries(inProd)) {
    const sh = shapeOf(spec.from, d, `${nt}.${tag}.${f}`);
    if (sh.kind === "copy") {
      props.push(`${s(f)}: n.${f}`);
      continue;
    }
    if (sh.kind === "node") {
      const t = `t${tmp++}`;
      stmts.push(`const ${t} = walk_${sh.nt}(n.${f}${ctxVars.length > 0 ? ", " + ctxVars.join(", ") : ""});`);
      stmts.push(unpack(t, ctxVars));
      stmts.push(`if (${t}[0] !== n.${f}) changed = true;`);
      props.push(`${s(f)}: ${t}[0]`);
    } else if (sh.kind === "list") {
      const out = `o${tmp++}`;
      const t = `t${tmp++}`;
      const y = `y${tmp++}`;
      stmts.push(`const ${out} = [];`);
      stmts.push(`for (const ${y} of n.${f}) {`);
      stmts.push(`  const ${t} = walk_${sh.nt}(${y}, ${ctxVars.join(", ")});`);
      stmts.push(`  ${unpack(t, ctxVars)}`);
      stmts.push(`  if (${t}[0] !== ${y}) changed = true;`);
      stmts.push(`  ${out}.push(${t}[0]);`);
      stmts.push(`}`);
      props.push(`${s(f)}: ${out}`);
    } else {
      const out = `o${tmp++}`;
      const t = `t${tmp++}`;
      stmts.push(`let ${out};`);
      stmts.push(`if (n.${f} !== undefined) {`);
      stmts.push(`  const ${t} = walk_${sh.nt}(n.${f}, ${ctxVars.join(", ")});`);
      stmts.push(`  ${unpack(t, ctxVars)}`);
      stmts.push(`  if (${t}[0] !== n.${f}) changed = true;`);
      stmts.push(`  ${out} = ${t}[0];`);
      stmts.push(`}`);
      props.push(`${s(f)}: ${out}`);
    }
  }

  const obj = `finish(n, { ${props.join(", ")} })`;
  const assign = canReuse ? `changed ? ${obj} : n` : obj;
  const body = [...stmts, `out = ${ret(assign, ctxVars)};`].join("\n");
  return `      {\n${indent(body, "      ")}\n      }`;
}

/** `c0 = t[1]; c1 = t[2];` — unpack extra from tuple back into parameter slots. */
function unpack(t: string, ctxVars: string[]): string {
  return ctxVars.map((c, i) => `${c} = ${t}[${i + 1}];`).join(" ");
}

/** Build return value: just the node itself if no extra, tuple if extra present. */
function ret(node: string, ctxVars: string[]): string {
  return ctxVars.length === 0 ? node : `[${node}${ctxVars.map((c) => `, ${c}`).join("")}]`;
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l) => (l.trim() === "" ? l : pad + l))
    .join("\n");
}

/** Generate a handler clause. Node returned by handler gets __lang__ and __meta__ added by finish. */
function emitHandler(spec: WalkerSpec, nt: string, tag: string): string {
  const k = spec.arity;
  const ctxVars = Array.from({ length: k }, (_, i) => `c${i}`);
  const call = `handlers[${s(nt)}][${s(tag)}](n, rec${ctxVars.length > 0 ? ", " + ctxVars.join(", ") : ""})`;
  if (k === 0) return `      out = finish(n, ${call});`;
  return (
    `      {\n` +
    `        const t = ${call};\n` +
    `        out = ${ret(
      `finish(n, t[0])`,
      ctxVars.map((_, i) => `t[${i + 1}]`),
    )};\n` +
    `      }`
  );
}

function emitWalkerSrc(spec: WalkerSpec): string {
  checkTagUniqueness(spec);

  const k = spec.arity;
  const params = Array.from({ length: k }, (_, i) => `c${i}`);
  const fnParams = ["n", ...params].join(", ");

  const fns: string[] = [];
  const byTag: Record<string, string> = {};

  for (const [nt, prods] of Object.entries(spec.from.rules)) {
    const cases: string[] = [];
    for (const [tag, inProd] of Object.entries(prods)) {
      byTag[tag] = `walk_${nt}`;
      if (typeof inProd === "string") continue; // transparent production, not yet implemented
      const hasHandler = spec.rules[nt]?.[tag] !== undefined;
      const body = hasHandler
        ? emitHandler(spec, nt, tag)
        : emitIdentity(spec, nt, tag, inProd, spec.to.rules[nt]?.[tag] as Prod | undefined);
      // After changing to assignment, must have break — otherwise will fall through to default throw
      cases.push(`    case ${s(tag)}: {\n${body}\n      break;\n    }`);
    }
    cases.push(
      `    default:\n` +
        `      throw new Error("[${spec.from.id}] non-terminal ${nt} has no production " + n.type + ` +
        `" (node has __lang__=" + n.__lang__ + ", " + whereOf(n) + ")");`,
    );
    fns.push(
      `  function walk_${nt}(${fnParams}) {\n` +
        `    let out;\n` +
        // Depth is only used to **remember the deepest node** — to report its location on overflow.
        // No longer pass a depth parameter down: that would change all call signatures (even handlers would need it).
        `    const d = ++depth;\n` +
        `    if (d > maxDepth) { maxDepth = d; deepest = n; }\n` +
        `    switch (n.type) {\n${cases.join("\n")}\n    }\n` +
        `    depth--;\n` +
        `    return out;\n` +
        `  }`,
    );
  }

  const byTagSrc = Object.entries(byTag)
    .map(([t, fn]) => `    ${s(t)}: ${fn},`)
    .join("\n");

  const recSrc =
    k === 0
      ? `  function rec(x) {
    if (Array.isArray(x)) return x.map(rec);
    if (x === null || x === undefined) return x;
    const w = BY_TAG[x.type];
    if (w === undefined) {
      throw new Error(
        "[${spec.from.id}] rec() encountered unrecognized production " + x.type + " (__lang__=" + x.__lang__ + ", " + whereOf(x) + ")",
      );
    }
    return w(x);
  }`
      : `  function rec(x, ...c) {
    if (Array.isArray(x)) {
      // Lists work the same way: one element's extra feeds the next
      const out = [];
      for (const y of x) {
        const t = rec(y, ...c);
        c = t.slice(1);
        out.push(t[0]);
      }
      return [out, ...c];
    }
    if (x === null || x === undefined) return [x, ...c];
    const w = BY_TAG[x.type];
    if (w === undefined) {
      throw new Error(
        "[${spec.from.id}] rec() encountered unrecognized production " + x.type + " (__lang__=" + x.__lang__ + ", " + whereOf(x) + ")",
      );
    }
    return w(x, ...c);
  }`;

  return `// Generated by codegen, do not edit by hand. Change language declarations or pass rules, then regenerate.
//   ${spec.from.id} -> ${spec.to.id}${k > 0 ? `   (extra ${k} values, threaded)` : ""}
function build(handlers, init) {
  const LANG = ${s(spec.to.id)};

  // Depth is only used to **report location on stack overflow**, not to impose limits.
  // Why not impose limits: the real boundary depends on input shape (pure let chains can go thousands
  // of layers deep, wide nodes hit limits earlier). A static threshold would reject inputs that currently work.
  let depth = 0;
  let maxDepth = 0;
  let deepest = null;

  function whereOf(node) {
    const m = node && node.__meta__;
    if (!m) return "(no location info)";
    return (m.file ?? "?") + ":" + (m.line ?? "?") + (m.col !== undefined ? ":" + m.col : "");
  }

  /** Convert RangeError: Maximum call stack size exceeded to a comprehensible error. */
  function guard(f) {
    try {
      return f();
    } catch (e) {
      if (e instanceof RangeError && /stack/i.test(String(e.message))) {
        const err = new Error(
          "[${spec.from.id}] Input nested too deep: " +
            whereOf(deepest) +
            " (reached " + maxDepth + " layers before overflow).\\n" +
            "  Generated traverser recurses down the tree; depth is limited by JS call stack. " +
            "This is not an input error, it's a known limitation (t27 / t18).",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  // __lang__ / __meta__ patching point.
  //
  // Top level alone is not enough — handlers will **create new** nodes in the return value (e.g., desugared Lam),
  // and those need __lang__ and source location too. So we walk down, but **only into newly created nodes**:
  // nodes that already have __lang__ are products of rec (processed by previous walker, already stamped),
  // we don't descend into them.
  //
  // So the cost is O(number of nodes created this time), not O(subtree size). Not doing this would be
  // O(n²) — walking the subtree once per node.
  function finish(from, to) {
    if (to === null || typeof to !== "object" || Array.isArray(to)) return to;
    const meta = from !== null && from !== undefined ? from.__meta__ : undefined;
    if (to.__lang__ === undefined) to.__lang__ = LANG;
    if (to.__meta__ === undefined && meta !== undefined) to.__meta__ = meta;
    for (const k of Object.keys(to)) {
      if (k === "__meta__" || k === "__lang__") continue;
      stampFresh(to[k], meta);
    }
    return to;
  }

  function stampFresh(x, meta) {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const y of x) stampFresh(y, meta);
      return;
    }
    if (x.__lang__ !== undefined) return; // already processed subtree, stop here
    x.__lang__ = LANG;
    if (x.__meta__ === undefined && meta !== undefined) x.__meta__ = meta;
    for (const k of Object.keys(x)) {
      if (k === "__meta__" || k === "__lang__") continue;
      stampFresh(x[k], meta);
    }
  }

${recSrc}

${fns.join("\n\n")}

  /** List element-wise reference comparison — "reuse if unchanged" needs this. */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
${byTagSrc}
  };

  // extra is **internal** communication within this pass (corresponds to processor's extra return values
  // in nanopass), so run only passes out the node — start with init value, discard extra.
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_${spec.from.entry}(x${k > 0 ? ", ...init()" : ""});
      return ${k === 0 ? "r" : "r[0]"};
    });
  }

  return { run, rec, arity: ${k} };
}
`;
}

/** Compile generated source code. Production mode writes to file; here new Function is to avoid build step. */
/**
 * Walker entry point for the framework's own tests. **Production path doesn't use this** (that goes through linked artifacts).
 *
 * `rec`'s signature follows the `Pass` type, not `unknown`:
 * - Input is a node of the **entry non-terminal** (not arbitrary unknown) — so correctly written fixtures
 *   can be passed in, incorrectly written ones (missing field, tag not in language) will error at call site.
 *   Previously this accepted `unknown`, so call sites like `w.rec(TREE)` all needed `as never` to survive,
 *   which effectively disabled checking.
 * - Return is a **tuple** (`Ret<…>` shape), call sites can `[0]` / destructure, no cast needed.
 *
 * One exception: **array fields**. `rec` only accepts single nodes (t24's remaining gap), lists go through
 * the framework-generated list helper, which is typed as passing `never` — runtime works fine.
 */
export function buildWalker<F extends LangDecl, O extends LangDecl, Ctx extends readonly unknown[] = []>(
  pass: Pass<F, O, Ctx>,
): {
  run: (n: NodeOf<F, F["entry"]>) => NodeOf<O, O["entry"]>;
  rec: Rec<F, O, Ctx>;
} {
  return buildWalkerDynamic(pass as unknown as WalkerSpec) as never;
}

/**
 * **Dynamic spec** path: `handlers` is assembled at runtime (rule engine in `rewrite.ts`,
 * framework's own tests), can't provide `Rules<…>` type-wise, so input/output here are `unknown`.
 *
 * Why keep a separate entry point instead of having `buildWalker` accept `unknown`: that would make
 * **all** call sites loose — even proper passes would regress to "wrong fixture only explodes at runtime".
 * The loose path should be explicit choice, obvious when selected that it's intentional.
 */
export function buildWalkerDynamic(spec: unknown): {
  run: (n: unknown) => unknown;
  rec: (n: unknown, ...ctx: unknown[]) => unknown;
} {
  const pass = spec as WalkerSpec;
  const src = emitWalker(pass as unknown as WalkerSpec);
  const build = new Function(`${src}\nreturn build;`)() as (
    handlers: unknown,
    init: () => unknown[],
  ) => {
    run: (n: unknown) => unknown;
    rec: (n: unknown, ...ctx: unknown[]) => unknown;
  };
  return build(pass.rules, pass.init ?? (() => []));
}

// ───────────────────────── Fusion: the user-facing entry ─────────────────────────

/**
 * Can this run of passes be fused into one traversal?
 *
 * The conditions the emitters enforce:
 * - every pass declares the **same set of nonterminal names** (fusion wires passes together by name)
 * - every pass has **arity 0** — a pass with extra values controls its own descent, which the shallow
 *   phase cannot express
 *
 * A single pass is trivially fusable. The trampoline emitter also allows a single pass with arity > 0;
 * the recursive emitter does not (it only ever fuses arity 0).
 *
 * Use this to group a pipeline without catching exceptions from the emitters.
 */
export function canFuse(specs: readonly WalkerSpec[]): boolean {
  if (specs.length === 0) return false;
  const names = (sp: WalkerSpec): string => Object.keys(sp.from.rules).sort().join(",");
  const first = names(specs[0]!);
  return specs.every((sp) => names(sp) === first && sp.arity === 0);
}

/**
 * Build a fused group: a contiguous run of passes collapsed into **one traversal**.
 *
 * This is the user-facing entry to fusion. `specs` must already satisfy `canFuse`; the emitters
 * throw at generation time if they do not.
 *
 * ── What the caller is responsible for
 *
 * Fusion changes evaluation order (see the fusion docs above), so the caller must decide **which**
 * runs are safe to fuse. The framework cannot decide that for you: it requires knowing whether any
 * pass inspects a child node's tag before a later pass changes it, and that analysis is not done.
 *
 * `opts.trampoline` picks the deep variant (identity path uses no native stack, ~20% slower). Use it
 * when input depth is not under your control.
 */
export function buildFusedGroup(
  specs: readonly WalkerSpec[],
  opts?: { trampoline?: boolean },
): {
  run: (n: unknown) => unknown;
} {
  const src = opts?.trampoline ? emitFusedGroupTramp(specs) : emitFusedGroupRec(specs);
  const build = new Function(`${src}\nreturn build;`)() as (
    handlersList: unknown,
    init: () => unknown[],
  ) => { run: (n: unknown) => unknown };
  // Every pass in a fusable group has arity 0, so the init is unused.
  return build(
    specs.map((sp) => sp.rules),
    () => [],
  );
}

// ───────────────────────── Generator self-check ─────────────────────────

/**
 * Generated source code goes through syntax validation **before being handed out**.
 *
 * Why needed: the worst class of bugs when writing generators is "generated source code is half-complete" —
 * e.g., template literal intended to output `\n` but outputs actual newline, cutting generated code in half.
 * I've hit this bug three times in the same file, each time only manifesting at `new Function` (or at runtime),
 * and the error is `Unexpected EOF`, giving no clue which generator line is the problem.
 *
 * Here we parse once immediately, bringing line number + context into the error when it breaks.
 * Cost is one extra parse at generation time — generation is rare, doesn't matter.
 */
function checked(src: string, what: string): string {
  try {
    new Function(`${src}\nreturn build;`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Locate: lines in generated code with **unpaired quotes** are where it got cut in half.
    // (This class of bug's only source is wrong escaping in template literals — I've hit this three times in the same pit.)
    const lines = src.split("\n");
    const odd = lines
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => (l.match(/"/g)?.length ?? 0) % 2 === 1)
      .slice(0, 4);
    const where =
      odd.length > 0
        ? `  Lines with unpaired quotes (breakpoint is near these lines):\n` +
          odd.map(([n, l]) => `  ${n}| ${l.slice(0, 110)}`).join("\n")
        : `  No lines with unpaired quotes found (tail: ${lines.slice(-2).join(" ⏎ ").slice(0, 110)})`;
    throw new CodegenError(
      `[codegen] Generated source code (${what}) failed syntax check: ${msg}\n` +
        `  Total ${lines.length} lines.\n${where}\n` +
        `  Most common generator mistake is template literal escaping — to output \\n you must write \\\\n, ` +
        `writing just \\n becomes actual newline, cutting generated code in half.`,
    );
  }
  return src;
}

/** Generate traverser source code for a single pass. */
export function emitWalker(spec: WalkerSpec): string {
  return checked(emitWalkerSrc(spec), `${spec.from.id}->${spec.to.id}`);
}

/** Generate traverser source code for a single pass (trampoline version: descent doesn't use native stack). */
export function emitWalkerTramp(spec: WalkerSpec): string {
  return emitFusedGroupTramp([spec]);
}

/** Generate traverser source code for a fused group of passes (recursive version, fast). */
export function emitFusedGroupRec(specs: readonly WalkerSpec[]): string {
  const label = specs.map((x) => x.from.id).join(" -> ");
  return checked(emitFusedGroupRecSrc(specs), `fused ${label}`);
}

/** Generate traverser source code for a fused group of passes (trampoline version, identity path uses no native stack). */
export function emitFusedGroupTramp(specs: readonly WalkerSpec[]): string {
  const label = specs.map((x) => x.from.id).join(" -> ");
  return checked(emitFusedGroupTrampSrc(specs), `fused trampoline ${label}`);
}

// ───────────────────────── Pipeline fusion ─────────────────────────

/**
 * Fuse a group of "same nonterminal names, arity 0" passes into a single traversal.
 *
 * ── What the naive approach gets wrong
 *
 * The tempting formulation is `F_i(node) = F_{i+1}(P_i(node))`, with P_i's rec bound to F_i. The
 * problem is that **child nodes get processed twice**: once via rec (running i..end), and once via
 * the outer F_{i+1} (which recurses into the parent's result, and therefore walks the children again).
 *
 * ── What we actually do: deep + shallow
 *
 *   deep(node)   = run the first pass **deeply** on this node (children go through deep),
 *                  then run passes 2..k **shallowly** on the result
 *   shallow_i(v) = pass i's handler/identity on this one node, **children used as-is**
 *                  (they have already been processed by the whole group)
 *
 * So each node is visited once per pass, and intermediate results stay in locals instead of being
 * materialized into a tree.
 *
 * ── Where the semantics differ from "one pass at a time" (must be stated)
 *
 * Run A (unfused): P1 over the whole tree, then P2 over the whole tree, ... So P1, when it looks at
 * a parent node, sees child nodes that have **only been processed by P1**.
 * Run B (fused): P1 sees child nodes that have **been processed by the whole group**.
 *
 * So if P1's handler inspects a child's **tag**, and P2 changes that tag, the two runs are not
 * equivalent. The two passes in this group (normalizeBegin / normalizePrimArity) only look at their
 * own node's fields and the child **count**, never a child's tag — so it is safe.
 *
 * That check requires an analysis of "which passes inspect a child's tag", which **is not done**.
 * So fusion is restricted to "same nonterminal names + arity 0", and every group is guarded by
 * "byte-identical before and after fusion" (see the e2e assertions).
 *
 * One measured observation to go with it: none of the 12 passes in this pipeline has a handler that
 * inspects a child's tag — they only look at their own node's fields, the child **count**, and a
 * child's type (that is dispatch, not a semantic decision). So the whole fused chain comes out
 * byte-identical. But that is an **observation, not a proof**; the guardrail stays.
 */

/**
 * Recursive fusion: fast, but depth is bounded by the native stack.
 *
 * The trampoline version (emitFusedGroupTramp) turns the identity path into an iterative loop, so
 * depth is unbounded, but it allocates one frame object per node — measured ~20% slower. Both are
 * kept; the caller picks.
 *
 *   fast (recursive)   1.38x   identity chain depth ~13k
 *   deep (trampoline)  0.79x   identity chain depth 2M+
 *
 * Default to the fast one: most inputs never get deep enough to overflow, and the 20% is paid by
 * **every** input. Cases where input depth is not under your control (user-written source,
 * machine-generated code) should pick the trampoline.
 */
function emitFusedGroupRecSrc(specs: readonly WalkerSpec[]): string {
  if (specs.length === 0) throw new CodegenError("[fuse] empty group");
  const first = specs[0]!;
  // Fusion wires passes together by **nonterminal name**, so what matters is the name set, not the language id.
  const ntNames = (sp: WalkerSpec): string => Object.keys(sp.from.rules).sort().join(",");
  for (const sp of specs) {
    if (ntNames(sp) !== ntNames(first)) {
      throw new CodegenError(
        `[fuse] nonterminal names in group don't match: ${sp.from.id} has ${ntNames(sp)}, ${first.from.id} has ${ntNames(first)}`,
      );
    }
    if (sp.arity !== 0) {
      throw new CodegenError(
        `[fuse] ${sp.from.id}: a pass with arity ${sp.arity} cannot be fused (a pass with extra controls its own descent)`,
      );
    }
    checkTagUniqueness(sp);
  }
  const lang = first.from.rules;

  const nts = Object.keys(lang);
  const fns: string[] = [];

  // ── Shallow: one per pass, dispatching on tag
  for (let i = 1; i < specs.length; i++) {
    const sp = specs[i]!;
    for (const nt of nts) {
      const prods = sp.from.rules[nt] ?? {};
      const cases: string[] = [];
      for (const tag of Object.keys(prods)) {
        const hasHandler = sp.rules[nt]?.[tag] !== undefined;
        // Shallow: identity just returns the value as-is (children are already final), only handlers act
        const body = hasHandler
          ? `      out = finish(v, handlersList[${i}][${s(nt)}][${s(tag)}](v, idRec));`
          : `      out = v;`;
        cases.push(`    case ${s(tag)}: {\n${body}\n      break;\n    }`);
      }
      cases.push(
        `    default:\n` +
          `      throw new Error("[fuse] nonterminal ${nt} in ${sp.from.id} has no production " + v.type + " (" + whereOf(v) + ")");`,
      );
      fns.push(
        `  function sh_${i}_${nt}(v) {\n    let out;\n    switch (v.type) {\n${cases.join("\n")}\n    }\n    return out;\n  }`,
      );
    }
  }

  // ── Deep: run pass 0 with children going through deep; afterwards shallow-run the rest
  const shallowCalls = specs
    .slice(1)
    .map((_, idx) => `    v = sh_${idx + 1}_(v);`)
    .join("\n");

  for (const nt of nts) {
    const prods = lang[nt]!;
    const cases: string[] = [];
    for (const [tag, inProd] of Object.entries(prods)) {
      if (typeof inProd === "string") continue;
      const hasHandler = first.rules[nt]?.[tag] !== undefined;
      const body = hasHandler
        ? `      v = finish(n, handlersList[0][${s(nt)}][${s(tag)}](n, deep));`
        : emitDeepIdentity(first, nt, tag, inProd);
      cases.push(`    case ${s(tag)}: {\n${body}\n      break;\n    }`);
    }
    cases.push(
      `    default:\n` +
        `      throw new Error("[fuse ${first.from.id}] nonterminal ${nt} has no production " + n.type + " (" + whereOf(n) + ")");`,
    );
    const shallow = specs.length > 1 ? shallowCalls.replace(/sh_(\d+)_\(/g, `sh_$1_${nt}(`) : "";
    fns.push(
      `  function deep_${nt}(n) {\n` +
        `    let v;\n` +
        `    const d = ++depth;\n` +
        `    if (d > maxDepth) { maxDepth = d; deepest = n; }\n` +
        `    switch (n.type) {\n${cases.join("\n")}\n    }\n` +
        `    depth--;\n` +
        (shallow ? `${shallow}\n` : ``) +
        `    return v;\n  }`,
    );
  }

  const byTag = Object.entries(first.from.rules)
    .flatMap(([nt, prods]) => Object.keys(prods).map((tag) => `    ${s(tag)}: deep_${nt},`))
    .join("\n");

  return `// Generated by codegen (fused). Do not edit by hand. Change language declarations or pass rules, then regenerate.
//   ${specs.map((x) => x.from.id).join(" -> ")}   (${specs.length} passes fused into 1 traversal)
function build(handlersList, init) {
  // A group's result belongs to the **last** pass's output language — not the first pass's.
  const LANG = ${s(specs[specs.length - 1]!.to.id)};
  const idRec = (x) => x;
  let depth = 0;
  let maxDepth = 0;
  let deepest = null;

  function whereOf(node) {
    const m = node && node.__meta__;
    if (!m) return "(no location info)";
    return (m.file ?? "?") + ":" + (m.line ?? "?") + (m.col !== undefined ? ":" + m.col : "");
  }

  function guard(f) {
    try { return f(); } catch (e) {
      if (e instanceof RangeError && /stack/i.test(String(e.message))) {
        const err = new Error("[fuse ${first.from.id}] input nested too deep: " + whereOf(deepest) + " (overflowed at depth " + maxDepth + ").");
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  function finish(from, to) {
    if (to === null || typeof to !== "object" || Array.isArray(to)) return to;
    const meta = from !== null && from !== undefined ? from.__meta__ : undefined;
    if (to.__lang__ === undefined) to.__lang__ = LANG;
    if (to.__meta__ === undefined && meta !== undefined) to.__meta__ = meta;
    for (const k of Object.keys(to)) {
      if (k === "__meta__" || k === "__lang__") continue;
      stampFresh(to[k], meta);
    }
    return to;
  }

  function stampFresh(x, meta) {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) { for (const y of x) stampFresh(y, meta); return; }
    if (x.__lang__ !== undefined) return;
    x.__lang__ = LANG;
    if (x.__meta__ === undefined && meta !== undefined) x.__meta__ = meta;
    for (const k of Object.keys(x)) {
      if (k === "__meta__" || k === "__lang__") continue;
      stampFresh(x[k], meta);
    }
  }

  function deep(x) {
    // List (list field / rec receiving a run of children): descend each in order
    if (Array.isArray(x)) return x.map(deep);
    const w = DEEP[x.type];
    if (w === undefined) {
      throw new Error("[fuse ${first.from.id}] rec() hit unrecognized production " + x.type + " (" + whereOf(x) + ")");
    }
    return w(x);
  }

${fns.join("\n\n")}

  const DEEP = {
${byTag}
  };

  function run(x) {
    depth = 0; maxDepth = 0; deepest = null;
    return guard(() => deep(x));
  }

  return { run, arity: 0 };
}
`;
}

/** Identity during the deep phase: children descend via deep. */
function emitDeepIdentity(spec: WalkerSpec, nt: string, tag: string, inProd: Prod): string {
  const props: string[] = [`type: ${s(tag)}`];
  for (const [f, d] of Object.entries(inProd)) {
    const sh = shapeOf(spec.from, d, `${nt}.${tag}.${f}`);
    if (sh.kind === "copy") props.push(`${s(f)}: n.${f}`);
    else if (sh.kind === "node") props.push(`${s(f)}: deep_${sh.nt}(n.${f})`);
    else if (sh.kind === "list") props.push(`${s(f)}: n.${f}.map(deep_${sh.nt})`);
    else props.push(`${s(f)}: n.${f} === undefined ? undefined : deep_${sh.nt}(n.${f})`);
  }
  return `      v = finish(n, { ${props.join(", ")} });`;
}

/**
 * Trampoline fusion: **explicit frame stack + dispatch loop**, identity path uses zero JS stack frames.
 *
 * ── Why it exists
 *
 * Recursive fusion (`emitFusedGroupRecSrc`) uses one native stack frame per node, deep input blows
 * the stack. Use the recursive version normally (faster), switch to this **on overflow** — see the
 * per-group fallback in `e2e/runner.ts`.
 *
 * Cost: allocates one frame object per node, measured ~20% slower than the recursive version (t18).
 * So it is only the fallback. Output of the two paths is **byte-identical**; e2e checks both.
 *
 * ── Places that still use native stack
 *
 * `rec` received in handlers goes to the same trampoline (opens a nested `drive` layer), so subtree
 * traversal is iterative too. The only place still using native stack is **nesting** of "handler
 * calls rec, child also has handler" — layers equal to the number of nodes with handlers on the path.
 * This limitation is real; the error message says so (t18 / t27).
 */
function emitFusedGroupTrampSrc(specs: readonly WalkerSpec[]): string {
  if (specs.length === 0) throw new CodegenError("[fuse] empty group");
  const first = specs[0]!;
  // Fusion wires passes together by **nonterminal name**, so what matters is the name set, not the language id.
  const ntNames = (sp: WalkerSpec): string => Object.keys(sp.from.rules).sort().join(",");
  for (const sp of specs) {
    if (ntNames(sp) !== ntNames(first)) {
      throw new CodegenError(
        `[fuse] nonterminal names in group don't match: ${sp.from.id} has ${ntNames(sp)}, ${first.from.id} has ${ntNames(first)}`,
      );
    }
    if (sp.arity !== first.arity) {
      throw new CodegenError(
        `[fuse] arity mismatch in group: ${sp.from.id} has ${sp.arity}, ${first.from.id} has ${first.arity}`,
      );
    }
    if (specs.length > 1 && sp.arity !== 0) {
      throw new CodegenError(
        `[fuse] ${sp.from.id}: a pass with arity ${sp.arity} cannot fuse with others (shallow cannot express threading)`,
      );
    }
    checkTagUniqueness(sp);
  }

  const lang = first.from.rules;
  const nts = Object.keys(lang);

  // ── Generated tables

  // tag → nonterminal (a tag is unique within a language; checkTagUniqueness guarantees this)
  const tagNt: Record<string, string> = {};
  for (const nt of nts) for (const tag of Object.keys(lang[nt]!)) tagNt[tag] = nt;

  // tag → child node field table, in declaration order. The driver uses this for descent order.
  // kind: n = single node, l = node list, m = optional node
  const tagFields: Record<string, [string, string][]> = {};
  for (const nt of nts) {
    for (const [tag, inProd] of Object.entries(lang[nt]!)) {
      if (typeof inProd === "string") continue;
      const fields: [string, string][] = [];
      for (const [f, d] of Object.entries(inProd)) {
        const sh = shapeOf(first.from, d, `${nt}.${tag}.${f}`);
        if (sh.kind === "node") fields.push([f, "n"]);
        else if (sh.kind === "list") fields.push([f, "l"]);
        else if (sh.kind === "maybe") fields.push([f, "m"]);
      }
      tagFields[tag] = fields;
    }
  }

  // Number of result slots in a frame = maximum child field count across all tags.
  // Numbered slots rather than an array: saves one array allocation per node (hot path).
  const maxSlots = Math.max(1, ...Object.values(tagFields).map((f) => f.length));
  const slotNames = Array.from({ length: maxSlots }, (_, i) => `r${i}`);
  const slotInit = slotNames.map((n) => `${n}: undefined`).join(", ");
  // Write to slot i — switch, not fr["r" + i]: a dynamic key degrades to dictionary lookup
  const slotCases = slotNames.map((n, i) => `      case ${i}: fr.${n} = v; return;`).join("\n");

  // Identity construction: pack the collected child results into a literal. There is **no recursion**
  // here — the children are sitting in the slots.
  //
  // Single pass and same language → allow "return the original node when no child changed". Same
  // reason as the identity path in emitWalkerSrc: fixed-point determination needs a single `===`
  // (t13), and it saves reallocating unchanged subtrees. Not possible when fusing several passes —
  // that is a chain, and a node belongs to different stages.
  const canReuse = specs.length === 1 && first.from.id === specs[0]!.to.id;

  const buildCases: string[] = [];
  for (const nt of nts) {
    for (const [tag, inProd] of Object.entries(lang[nt]!)) {
      if (typeof inProd === "string") continue;
      const props: string[] = [`type: ${s(tag)}`];
      const checks: string[] = [];
      let ri = 0;
      for (const [f, d] of Object.entries(inProd)) {
        const sh = shapeOf(first.from, d, `${nt}.${tag}.${f}`);
        if (sh.kind === "copy") props.push(`${s(f)}: n.${f}`);
        else {
          if (canReuse) {
            checks.push(
              sh.kind === "list"
                ? `!sameList(fr.${slotNames[ri]}, n.${f})`
                : `fr.${slotNames[ri]} !== n.${f}`,
            );
          }
          props.push(`${s(f)}: fr.${slotNames[ri]}`);
          ri += 1;
        }
      }
      const obj = `{ ${props.join(", ")} }`;
      // Same as above: a leaf is always "unchanged", return n directly (otherwise the reference never compares equal)
      const built = !canReuse ? obj : checks.length === 0 ? "n" : `(${checks.join(" || ")}) ? ${obj} : n`;
      buildCases.push(`    case ${s(tag)}:\n      return ${built};`);
    }
  }

  return `// Generated by codegen (fused + trampoline). Do not edit by hand. Change language declarations or pass rules, then regenerate.
//   ${specs.map((x) => x.from.id).join(" -> ")} -> ${specs[specs.length - 1]!.to.id}   (${specs.length} passes fused into 1 traversal)
//
// This is an **explicit frame stack + dispatch loop**, not recursive descent: the identity path uses
// zero JS stack frames. rec in handlers connects to the same trampoline (opens a nested drive layer),
// so subtree traversal is iterative too. The only place still using native stack is nesting of
// "handler calls rec, child also has handler" — layers equal to the number of nodes with handlers on the path.
function build(handlersList, init) {
  // A group's result belongs to the **last** pass's output language — not the first pass's
  const LANG = ${s(specs[specs.length - 1]!.to.id)};
  /** List element-wise reference comparison — "reuse if unchanged" needs this. */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = ${first.arity};
  const idRec = (x) => x;

  const TAG_NT = {
${Object.entries(tagNt)
  .map(([tag, nt]) => `    ${s(tag)}: ${s(nt)},`)
  .join("\n")}
  };

  // tag → child node field table (in declaration order). kind: n single node / l list / m optional
  const FIELDS = {
${Object.entries(tagFields)
  .map(([tag, fields]) => `    ${s(tag)}: ${JSON.stringify(fields)},`)
  .join("\n")}
  };

  // One flat tag → handler table per pass. Saves looking up the nonterminal layer every time.
  const HANDLERS = [];
  for (let i = 0; i < handlersList.length; i++) {
    const flat = Object.create(null);
    for (const tag in TAG_NT) {
      const nt = TAG_NT[tag];
      const per = handlersList[i][nt];
      const h = per === undefined ? undefined : per[tag];
      if (h !== undefined) flat[tag] = h;
    }
    HANDLERS.push(flat);
  }
  const H0 = HANDLERS[0];
  const SHALLOW = HANDLERS.slice(1);

  // __lang__ / __meta__ patching point.
  //
  // Top level alone is not enough — handlers **create new** nodes in the return value (e.g., a
  // desugared Lam), and those need __lang__ and source location too. So we walk down, but **only
  // into newly created nodes**: nodes that already have __lang__ are the previous round's products.
  // Cost is O(number of nodes created this time), not O(subtree size).
  function finish(from, to) {
    if (to === null || typeof to !== "object" || Array.isArray(to)) return to;
    const meta = from !== null && from !== undefined ? from.__meta__ : undefined;
    if (to.__lang__ === undefined) to.__lang__ = LANG;
    if (to.__meta__ === undefined && meta !== undefined) to.__meta__ = meta;
    for (const k of Object.keys(to)) {
      if (k === "__meta__" || k === "__lang__") continue;
      stampFresh(to[k], meta);
    }
    return to;
  }

  function stampFresh(x, meta) {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) { for (const y of x) stampFresh(y, meta); return; }
    if (x.__lang__ !== undefined) return;
    x.__lang__ = LANG;
    if (x.__meta__ === undefined && meta !== undefined) x.__meta__ = meta;
    for (const k of Object.keys(x)) {
      if (k === "__meta__" || k === "__lang__") continue;
      stampFresh(x[k], meta);
    }
  }

  function buildIdentity(tag, n, fr) {
    switch (tag) {
${buildCases.join("\n")}
    default:
      throw new Error("[fuse ${first.from.id}] no constructor for production " + tag);
    }
  }

  // ── Trampoline ──
  //
  // Frame shape (one object type, fixed fields, so the hidden class is stable):
  //   { node, fs, i, li, lacc, ctx, r0..rn }
  //   fs   child node field table for this tag
  //   i    which field is being processed
  //   li   which element of a list field we reached; lacc is the accumulator array (null = not started)

  /** Find the next **node** to descend into for this frame; undefined means the frame can finalize. */
  function takeChild(fr) {
    for (;;) {
      if (fr.i >= fr.fs.length) return undefined;
      const f = fr.fs[fr.i];
      const v = fr.node[f[0]];
      const kind = f[1];
      if (kind === "n") {
        return v;
      }
      if (kind === "m") {
        if (v === undefined) { fr.i += 1; continue; }
        return v;
      }
      // list
      if (fr.lacc === null) { fr.lacc = []; fr.li = 0; }
      if (fr.li < v.length) { const x = v[fr.li]; fr.li += 1; return x; }
      setSlot(fr, fr.i, fr.lacc);
      fr.lacc = null;
      fr.i += 1;
    }
  }

  /** Write a result by slot number. Switch, not a dynamic key: a dynamic key degrades to dictionary lookup. */
  function setSlot(fr, i, v) {
    switch (i) {
${slotCases}
      default:
        throw new Error("[fuse ${first.from.id}] slot out of bounds " + i);
    }
  }

  /** Accept the next child result. When K > 0 the value is [node, ...extra], extra threaded to the next sibling. */
  function accept(fr, value) {
    if (K > 0) fr.ctx = value.slice(1);
    const node0 = K > 0 ? value[0] : value;
    if (fr.fs[fr.i][1] === "l") { fr.lacc.push(node0); return; }
    setSlot(fr, fr.i, node0);
    fr.i += 1;
  }

  /** Finalize this frame: run pass 0 (handler or identity), then shallow-run the remaining passes. */
  function buildOne(fr) {
    const tag = fr.node.type;
    const h = H0[tag];
    let v;
    if (h !== undefined) {
      // A handler is a black box (leaf): its rec is **this trampoline**, so the subtree stays iterative.
      // When K > 0 it returns the tuple [node, ...extra]; finish can only act on the node —
      // feeding the tuple straight to finish treats it as "array, return as-is", and then the whole
      // tuple gets stuffed into the field.
      if (K > 0) {
        const t = h(fr.node, drive, ...fr.ctx);
        v = finish(fr.node, t[0]);
        fr.ctx = t.slice(1);
      } else {
        v = finish(fr.node, h(fr.node, drive));
      }
    } else {
      v = finish(fr.node, buildIdentity(tag, fr.node, fr));
    }
    for (let i = 0; i < SHALLOW.length; i++) {
      // Dispatch on the **current** value's tag, not the frame's original tag.
      // An earlier pass in the group may have rewritten the node to a different tag
      // (e.g. Neg -> Sub), and the later passes must see the node as it now is —
      // otherwise fused and unfused runs disagree. The recursive emitter does this
      // correctly (its sh_i_* helpers switch on v.type); this one did not.
      const s = SHALLOW[i][v.type];
      if (s !== undefined) v = finish(fr.node, s(v, idRec));
    }
    return K > 0 ? [v, ...fr.ctx] : v;
  }

  let lastNode = null;

  function whereOf(node) {
    const m = node && node.__meta__;
    if (!m) return "(no location info)";
    return (m.file ?? "?") + ":" + (m.line ?? "?") + (m.col !== undefined ? ":" + m.col : "");
  }

  // A tag with a handler is treated as a leaf: **the driver does not descend**, the handler calls rec itself.
  // Otherwise it would descend once and the handler would rec again — child nodes processed twice
  // (a non-idempotent pass breaks immediately: temp names advance one extra step).
  const NO_CHILDREN = [];

  function drive(root, ...ctx0) {
    // List: same as single-pass rec — one element's extra feeds the next (order preserved).
    // **Missing this branch blows up on "unrecognized production undefined"**, because an array has no .type.
    if (Array.isArray(root)) {
      let c = ctx0;
      const out = [];
      for (const y of root) {
        const t = drive(y, ...c);
        if (K > 0) {
          c = t.slice(1);
          out.push(t[0]);
        } else {
          out.push(t);
        }
      }
      return K > 0 ? [out, ...c] : out;
    }
    const stack = [];
    let node = root;
    let value;
    let mode = 0; // 0 = have a node to process, 1 = have a result to deliver to the top of the stack
    lastNode = root;

    for (;;) {
      if (mode === 0) {
        lastNode = node;
        const fs = H0[node.type] !== undefined ? NO_CHILDREN : FIELDS[node.type];
        if (fs === undefined) {
          throw new Error(
            "[fuse ${first.from.id}] unrecognized production " + node.type +
              " (__lang__=" + (node && node.__lang__) + ", " + whereOf(node) + ")",
          );
        }
        // A frame's ctx is inherited from above (parent frame or this call's input) — that is the threading
        const fr = {
          node,
          fs,
          i: 0,
          li: 0,
          lacc: null,
          ctx: stack.length > 0 ? stack[stack.length - 1].ctx : ctx0,
          ${slotInit},
        };
        const next = takeChild(fr);
        if (next === undefined) {
          value = buildOne(fr);
          mode = 1;
        } else {
          stack.push(fr);
          node = next;
        }
        continue;
      }

      if (stack.length === 0) return value;
      const fr = stack[stack.length - 1];
      accept(fr, value);
      const next = takeChild(fr);
      if (next === undefined) {
        stack.pop();
        value = buildOne(fr);
      } else {
        node = next;
        mode = 0;
      }
    }
  }

  function run(x) {
    try {
      const r = K > 0 ? drive(x, ...init()) : drive(x);
      return K > 0 ? r[0] : r;
    } catch (e) {
      if (e instanceof RangeError && /stack/i.test(String(e.message))) {
        const err = new Error(
          "[fuse ${first.from.id}] input nested too deep: " + whereOf(lastNode) +
            ".\\n  The fused traverser's identity path doesn't use native stack, but when a handler calls rec and the child also has a handler, they nest — layers equal to the number of nodes with handlers on the path (t18 / t27).",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  return { run, arity: K };
}
`;
}
