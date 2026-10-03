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
  return checked(emitWalkerTrampSrc(spec), `trampoline ${spec.from.id}->${spec.to.id}`);
}

/**
 * Trampoline walker: **explicit frame stack + dispatch loop**, identity path uses zero JS stack frames.
 *
 * ── Why it exists
 *
 * Recursive version (`emitWalkerSrc`) uses one native stack frame per node, deep input blows stack.
 * Use recursive version normally (faster), switch to this **on overflow** — see per-pass fallback
 * in `e2e/runner.ts`.
 *
 * ── No relation to fusion
 *
 * This code previously lived in the fusion suite ("trampoline version of fusion group"), and was used
 * for single-pass runs too — because single-pass is just a one-element group. After fusion was cut,
 * it was extracted into standalone function: **it's "same pass, switch to iterative descent"**.
 * Nothing to do with whether fusion happens or not, so shouldn't have followed fusion out.
 *
 * Cost: allocates one frame object per node, measured ~20% slower than recursive version (measured in t18).
 * So only use as fallback.
 *
 * ── Places that still use native stack
 *
 * `rec` received in handlers goes to the same trampoline (opens nested `drive` layer), so subtree traversal
 * is iterative too. The only place still using native stack is **nesting** of "handler calls rec, child also
 * has handler" — layers equal to number of nodes with handlers on the path. This limitation is real, error
 * message makes it clear (t18 / t27).
 */
function emitWalkerTrampSrc(spec: WalkerSpec): string {
  checkTagUniqueness(spec);

  const k = spec.arity;
  const lang = spec.from.rules;
  const nts = Object.keys(lang);

  // tag → non-terminal (tag is unique in a language, guaranteed by checkTagUniqueness)
  const tagNt: Record<string, string> = {};
  for (const nt of nts) for (const tag of Object.keys(lang[nt]!)) tagNt[tag] = nt;

  // tag → child node field table, in declaration order. Driver uses this to determine descent order.
  // kind: n = single node, l = node list, m = optional node
  const tagFields: Record<string, [string, string][]> = {};
  for (const nt of nts) {
    for (const [tag, inProd] of Object.entries(lang[nt]!)) {
      if (typeof inProd === "string") continue;
      const fields: [string, string][] = [];
      for (const [f, d] of Object.entries(inProd)) {
        const sh = shapeOf(spec.from, d, `${nt}.${tag}.${f}`);
        if (sh.kind === "node") fields.push([f, "n"]);
        else if (sh.kind === "list") fields.push([f, "l"]);
        else if (sh.kind === "maybe") fields.push([f, "m"]);
      }
      tagFields[tag] = fields;
    }
  }

  // Number of result slots in frame = maximum child field count across all tags.
  // Use numbered slots rather than array: saves per-node array allocation (hot path).
  const maxSlots = Math.max(1, ...Object.values(tagFields).map((f) => f.length));
  const slotNames = Array.from({ length: maxSlots }, (_, i) => `r${i}`);
  const slotInit = slotNames.map((n) => `${n}: undefined`).join(", ");
  // Write to slot i — use switch instead of fr["r" + i]: dynamic keys degrade to dictionary lookup
  const slotCases = slotNames.map((n, i) => `      case ${i}: fr.${n} = v; return;`).join("\n");

  // Same language → allow "return original node if no children changed".
  // Same reason as identity path in emitWalkerSrc: fixed-point determination needs single `===` check (t13),
  // bonus: saves reallocation of unchanged subtrees.
  const canReuse = spec.from.id === spec.to.id;

  // Identity construction: pack collected child node results into object literal. **No recursion here** — children are in slots.
  const buildCases: string[] = [];
  for (const nt of nts) {
    for (const [tag, inProd] of Object.entries(lang[nt]!)) {
      if (typeof inProd === "string") continue;
      const props: string[] = [`type: ${s(tag)}`];
      const checks: string[] = [];
      let ri = 0;
      for (const [f, d] of Object.entries(inProd)) {
        const sh = shapeOf(spec.from, d, `${nt}.${tag}.${f}`);
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
      // Leaf always "unchanged", return n directly (otherwise reference never equal)
      const built = !canReuse ? obj : checks.length === 0 ? "n" : `(${checks.join(" || ")}) ? ${obj} : n`;
      buildCases.push(`    case ${s(tag)}:\n      return ${built};`);
    }
  }

  return `// Generated by codegen (trampoline version). Do not edit by hand. Change language declarations or pass rules, then regenerate.
//   ${spec.from.id} -> ${spec.to.id}${k > 0 ? `   (extra ${k} values, threaded)` : ""}   (descent doesn't use native stack)
//
// Explicit frame stack + dispatch loop: identity path uses zero JS stack frames.
// rec in handlers also connects to same trampoline (opens nested drive layer), so subtree traversal is iterative too.
// The only place still using native stack is nesting of "handler calls rec, child also has handler" — layers
// equal to number of nodes with handlers on the path.
function build(handlers, init) {
  const LANG = ${s(spec.to.id)};
  /** List element-wise reference comparison — "reuse if unchanged" needs this. */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = ${k};

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

  // tag → handler **flat map**. Saves looking up per-nonterminal layer every time.
  const H = Object.create(null);
  for (const tag in TAG_NT) {
    const per = handlers[TAG_NT[tag]];
    const h = per === undefined ? undefined : per[tag];
    if (h !== undefined) H[tag] = h;
  }

  // __lang__ / __meta__ patching point.
  //
  // Top level alone is not enough — handlers will **create new** nodes in the return value (e.g., desugared Lam),
  // and those need __lang__ and source location too. So we walk down, but **only into newly created nodes**:
  // nodes that already have __lang__ are products from previous round.
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
      throw new Error("[${spec.from.id}] no constructor for production " + tag);
    }
  }

  // ── Trampoline ──
  //
  // Frame shape (only one object type, fixed fields, so hidden class is stable):
  //   { node, fs, i, li, lacc, ctx, r0..rn }
  //   fs   child node field table for this tag
  //   i    processing which field
  //   li   reached which element in list field; lacc is accumulator array (null = not started yet)

  /** Find next **node** to descend into for this frame; return undefined if none (frame can finalize). */
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

  /** Write result by slot number. Use switch instead of dynamic key: dynamic key degrades to dictionary lookup. */
  function setSlot(fr, i, v) {
    switch (i) {
${slotCases}
      default:
        throw new Error("[${spec.from.id}] slot out of bounds " + i);
    }
  }

  /** Accept next child node result. When K > 0, value is [node, ...extra], extra threaded to next sibling. */
  function accept(fr, value) {
    if (K > 0) fr.ctx = value.slice(1);
    const node0 = K > 0 ? value[0] : value;
    if (fr.fs[fr.i][1] === "l") { fr.lacc.push(node0); return; }
    setSlot(fr, fr.i, node0);
    fr.i += 1;
  }

  /** Finalize this frame: run handler (or identity), pack child nodes from slots back into a node. */
  function buildOne(fr) {
    const tag = fr.node.type;
    const h = H[tag];
    let v;
    if (h !== undefined) {
      // handler is black box (leaf): its rec connects to **this trampoline**, so subtree is still iterative.
      // When K > 0 it returns tuple [node, ...extra], finish can only act on node —
      // directly feeding tuple to finish treats it as "array, return as-is", then entire tuple gets stuffed into field.
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
    return K > 0 ? [v, ...fr.ctx] : v;
  }

  let lastNode = null;

  function whereOf(node) {
    const m = node && node.__meta__;
    if (!m) return "(no location info)";
    return (m.file ?? "?") + ":" + (m.line ?? "?") + (m.col !== undefined ? ":" + m.col : "");
  }

  // Tags with handlers are treated as leaves: **driver doesn't descend**, handler calls rec itself.
  // Not doing this would descend once, then handler rec's again — child nodes processed twice
  // (non-idempotent passes break immediately: temp names advance one extra step).
  const NO_CHILDREN = [];

  function drive(root, ...ctx0) {
    // List: same as single-pass rec — one element's extra feeds the next (preserves order).
    // **Missing this branch blows up on "unrecognized production undefined"**, because arrays have no .type.
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
    let mode = 0; // 0 = have a node to process, 1 = have a result to deliver to top of stack
    lastNode = root;

    for (;;) {
      if (mode === 0) {
        lastNode = node;
        const fs = H[node.type] !== undefined ? NO_CHILDREN : FIELDS[node.type];
        if (fs === undefined) {
          throw new Error(
            "[${spec.from.id}] unrecognized production " + node.type +
              " (__lang__=" + (node && node.__lang__) + ", " + whereOf(node) + ")",
          );
        }
        // Frame's ctx is inherited from above (parent frame or this call's input) — this is threading
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
          "[${spec.from.id}] Input nested too deep: " + whereOf(lastNode) +
            ".\\n  Trampoline version's identity path doesn't use native stack, but when handler calls rec and child also has handler, they nest — layers equal to number of nodes with handlers on the path.",
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
