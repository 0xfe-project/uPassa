/**
 * codegen：从语言声明的形状生成遍历器。
 *
 * 生成的是一个 walk 函数 + 一个 rec。形状完全由两个语言的声明决定，
 * 所以你写的那些 handler 是黑的 —— 不读源码、不解析 TS、不 eval 用户代码。
 *
 * 三件事在生成期就报错，不留到运行期：
 *   1. 输入语言里有个产生式，输出语言没有，而你又没给 handler
 *   2. identity 那条路上，输入/输出同一个 tag 的字段对不上
 *   3. 同一个 tag 出现在两个非终结符里 —— 那样 rec 就没法靠 tag 分派
 *
 * arity = 0 生成的是「节点进、节点出」。arity = k > 0 生成的是「节点 + k 个值进，
 * 节点 + k 个值出」，而且这 k 个值是**线程**的：一个子节点吐出来的 extra 直接当
 * 下一个兄弟节点的 extra 参数。所以 identity 子句不能写成 `a: walk(n.a), b: walk(n.b)`，
 * 得写成先调 a、把结果喂给 b 的几步赋值。
 */

import type { FieldDesc, LangDecl, NodeOf } from "./lang.ts";
import type { Pass, Rec } from "./pass.ts";

export class CodegenError extends Error {}

/**
 * codegen 需要的东西。故意比 Pass 宽 —— 生成器只关心形状和元数，不关心类型参数。
 * Pass<F, O, Ctx> 结构上就满足它。
 */
export interface WalkerSpec {
  readonly from: LangDecl;
  readonly to: LangDecl;
  readonly arity: number;
  /** 额外参数的初值（每次 run 一份新的）。 */
  readonly init?: (() => unknown[]) | undefined;
  readonly rules: { readonly [nt: string]: { readonly [tag: string]: unknown } | undefined };
}

type Prod = Record<string, FieldDesc>;

const s = (x: string): string => JSON.stringify(x);

function isNT(decl: LangDecl, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(decl.rules, name);
}

/** 一个字段是子节点还是宿主值；子节点的话是哪种形状。 */
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
      throw new CodegenError(`[codegen] ${where}: 嵌套的 list 还不支持 —— 定义一层新的非终结符。`);
    }
    return isNT(decl, inner) ? { kind: "list", nt: inner } : { kind: "copy" };
  }
  const inner = d.maybe;
  if (typeof inner !== "string") {
    throw new CodegenError(`[codegen] ${where}: 嵌套的 maybe 还不支持。`);
  }
  return isNT(decl, inner) ? { kind: "maybe", nt: inner } : { kind: "copy" };
}

function sameShape(a: Shape, b: Shape): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "copy") return true;
  return (a as { nt: string }).nt === (b as { nt: string }).nt;
}

function describe(sh: Shape): string {
  return sh.kind === "copy" ? "宿主值" : `${sh.kind}:${(sh as { nt: string }).nt}`;
}

/** 生成期检查：同一个 tag 不能属于两个非终结符，否则 rec 不知道往哪走。 */
function checkTagUniqueness(spec: WalkerSpec): void {
  const seen = new Map<string, string>();
  for (const [nt, prods] of Object.entries(spec.from.rules)) {
    for (const tag of Object.keys(prods)) {
      const prev = seen.get(tag);
      if (prev !== undefined && prev !== nt) {
        throw new CodegenError(
          `[${spec.from.id}] 产生式 ${s(tag)} 同时出现在非终结符 ${s(prev)} 和 ${s(nt)} 里。` +
            `rec 靠 tag 分派，所以一个 tag 只能属于一个非终结符。`,
        );
      }
      seen.set(tag, nt);
    }
  }
}

/** 检查输入/输出同一个 tag 的字段能不能对上。 */
function checkFields(spec: WalkerSpec, nt: string, tag: string, inProd: Prod, outProd: Prod): void {
  for (const [f, d] of Object.entries(inProd)) {
    if (!(f in outProd)) {
      throw new CodegenError(
        `[${spec.from.id} -> ${spec.to.id}] ${s(`${nt}.${tag}`)}.${f}: 输入语言有这个字段，${spec.to.id} 没有。`,
      );
    }
    const a = shapeOf(spec.from, d, `${nt}.${tag}.${f}`);
    const b = shapeOf(spec.to, outProd[f] as FieldDesc, `${nt}.${tag}.${f}`);
    if (!sameShape(a, b)) {
      throw new CodegenError(
        `[${spec.from.id} -> ${spec.to.id}] ${s(`${nt}.${tag}`)}.${f}: 字段形状对不上（` +
          `${describe(a)} vs ${describe(b)}）。identity 只能自动处理两边同形的字段，不同形就得自己写 handler。`,
      );
    }
  }
  for (const f of Object.keys(outProd)) {
    if (!(f in inProd)) {
      throw new CodegenError(
        `[${spec.from.id} -> ${spec.to.id}] ${s(`${nt}.${tag}`)}.${f}: ${spec.to.id} 有这个字段而输入语言没有，` +
          `identity 填不出来。`,
      );
    }
  }
}

/** 生成一条 identity 子句：照着输入字段递归，产出输出语言的节点。 */
function emitIdentity(
  spec: WalkerSpec,
  nt: string,
  tag: string,
  inProd: Prod,
  outProd: Prod | undefined,
): string {
  if (outProd === undefined) {
    throw new CodegenError(
      `[${spec.from.id} -> ${spec.to.id}] 产生式 ${s(`${nt}.${tag}`)} 在 ${spec.to.id} 里没有对应项，` +
        `而你又没给 handler —— 要么加一条规则，要么把它从输入语言里去掉。`,
    );
  }
  checkFields(spec, nt, tag, inProd, outProd);

  const k = spec.arity;
  const ctxVars = Array.from({ length: k }, (_, i) => `c${i}`);
  const props: string[] = [`type: ${s(tag)}`];
  let tmp = 0;

  // 同语言 pass 才允许"没改就返回原对象"。
  //
  // 为什么：换语言时 finish 会给节点打上新的 __lang__，复用原对象的话它的 __lang__
  // 就留在旧语言上了 —— 那是语义变化，不是优化。同语言时 __lang__ 本来就一样，复用没差别。
  //
  // 好处有两个，都是真的：
  //   ① 不动点判定可以只看根节点的**引用**（O(1)）—— 不用每轮全量深比较（t13 验收④）
  //   ② 没动过的子树不再每过一遍就重新分配一遍
  const canReuse = spec.from.id === spec.to.id;

  /** 逐元素比一遍引用 —— 列表也一样不能瞎重建。 */
  const sameList = `sameList`;

  // k === 0：不收 extra，直接把子节点算好放进属性里，顺手记下"改没改"。
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
    // 叶子节点（一个子字段都没有）永远"没变" —— 构造出来的对象和 n 结构相同，
    // 那就是白分配。**这里不特判的话引用永远不等**，不动点判定就永远到不了（踩过）。
    const assign = !canReuse ? obj : checks.length === 0 ? "n" : `(${checks.join(" || ")}) ? ${obj} : n`;
    if (decls.length === 0) return `      out = ${assign};`;
    return `      {\n${indent(`${decls.join("\n")}\n${k === 0 ? "out" : "out"} = ${assign};`, "        ")}\n      }`;
  }

  // k > 0：必须按顺序收 extra，所以得用语句。
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

/** `c0 = t[1]; c1 = t[2];` —— 把元组里的 extra 收回参数槽。 */
function unpack(t: string, ctxVars: string[]): string {
  return ctxVars.map((c, i) => `${c} = ${t}[${i + 1}];`).join(" ");
}

/** 造返回值：没 extra 就是节点本身，有 extra 就是元组。 */
function ret(node: string, ctxVars: string[]): string {
  return ctxVars.length === 0 ? node : `[${node}${ctxVars.map((c) => `, ${c}`).join("")}]`;
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l) => (l.trim() === "" ? l : pad + l))
    .join("\n");
}

/** 生成一条 handler 子句。handler 出来的节点由 finish 补 __lang__ 和 __meta__。 */
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
      if (typeof inProd === "string") continue; // 透明产生式，还没做
      const hasHandler = spec.rules[nt]?.[tag] !== undefined;
      const body = hasHandler
        ? emitHandler(spec, nt, tag)
        : emitIdentity(spec, nt, tag, inProd, spec.to.rules[nt]?.[tag] as Prod | undefined);
      // return 改成赋值之后必须有 break —— 不然会穿透到 default 抛错
      cases.push(`    case ${s(tag)}: {\n${body}\n      break;\n    }`);
    }
    cases.push(
      `    default:\n` +
        `      throw new Error("[${spec.from.id}] 非终结符 ${nt} 里没有产生式 " + n.type + ` +
        `"（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");`,
    );
    fns.push(
      `  function walk_${nt}(${fnParams}) {\n` +
        `    let out;\n` +
        // 深度只用来**记住最深的那个节点** —— 溢出的时候拿它的位置报错。
        // 不再往下传一个 depth 参数：那会改掉所有调用签名（连 handler 都得带上）。
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
        "[${spec.from.id}] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x);
  }`
      : `  function rec(x, ...c) {
    if (Array.isArray(x)) {
      // 列表也是一样：一个元素的 extra 吐给下一个
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
        "[${spec.from.id}] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x, ...c);
  }`;

  return `// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   ${spec.from.id} -> ${spec.to.id}${k > 0 ? `   （extra ${k} 个值，线程）` : ""}
function build(handlers, init) {
  const LANG = ${s(spec.to.id)};

  // 深度只用来在**栈溢出时报告位置**，不做限制。
  // 为什么不做限制：真正的边界取决于输入形状（纯 let 链能到几千层，宽节点更浅），
  // 定一个静态阈值会误杀现在跑得过的输入。
  let depth = 0;
  let maxDepth = 0;
  let deepest = null;

  function whereOf(node) {
    const m = node && node.__meta__;
    if (!m) return "（没有位置信息）";
    return (m.file ?? "?") + ":" + (m.line ?? "?") + (m.col !== undefined ? ":" + m.col : "");
  }

  /** 把 RangeError: Maximum call stack size exceeded 换成能看懂的报错。 */
  function guard(f) {
    try {
      return f();
    } catch (e) {
      if (e instanceof RangeError && /stack/i.test(String(e.message))) {
        const err = new Error(
          "[${spec.from.id}] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\\n" +
            "  生成的遍历器是递归下树的，深度受 JS 调用栈限制。这不是输入错，是已知限制（t27 / t18）。",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  // __lang__ / __meta__ 的补丁处。
  //
  // 只有顶层不够 —— handler 会在返回值里**新造**节点（比如 desugar 出的 Lam），那些也得带上
  // __lang__ 和源位置。所以往下走，但**只走新造的**：已经有 __lang__ 的是 rec 的产物
  // （上一个 walker 处理过、已经带好了），不再下去。
  //
  // 所以代价是 O(本次新造的节点数)，不是 O(子树大小)。不这么写就是每节点走一遍子树 = O(n²)。
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
    if (x.__lang__ !== undefined) return; // 已经处理过的子树，到此为止
    x.__lang__ = LANG;
    if (x.__meta__ === undefined && meta !== undefined) x.__meta__ = meta;
    for (const k of Object.keys(x)) {
      if (k === "__meta__" || k === "__lang__") continue;
      stampFresh(x[k], meta);
    }
  }

${recSrc}

${fns.join("\n\n")}

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
${byTagSrc}
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
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

/** 把生成的源码编出来。生产形态是写文件；这里 new Function 是为了不留构建步骤。 */
/**
 * 框架自己的测试用的 walker 入口。**生产路径不走这里**（那边走链接产物）。
 *
 * `rec` 的签名跟着 `Pass` 的类型走，不是 `unknown`：
 * - 输入是**入口非终结符**的节点（不是任意 unknown）—— 所以夹具写对了就能传进去，
 *   写错了（少个字段、tag 不在语言里）在调用点就报。以前这里收 `unknown`，于是
 *   `w.rec(TREE)` 这种调用点全得 `as never` 才活得下去，等于把检查关掉。
 * - 返回是**元组**（`Ret<…>` 的形状），调用点能 `[0]` / 解构，也不用 cast。
 *
 * 一处例外：**数组字段**。`rec` 只收单个节点（t24 那个剩下的缺口），列表要走框架
 * 生成的那个列表 helper，在类型上是按 `never` 传的 —— 运行期没问题。
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
 * **动态 spec** 的那条路：`handlers` 是运行期拼出来的（`rewrite.ts` 的规则引擎、
 * 框架自己的测试），类型上给不出 `Rules<…>`，所以这里进出都是 `unknown`。
 *
 * 为什么单独留一个入口，而不是让 `buildWalker` 收 `unknown`：那样**所有**调用点都跟着
 * 变松 —— 正经的 pass 也会退回"传错夹具在运行期才炸"。松的那条路要显式选，选的时候
 * 一眼看得出是有意为之。
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

// ───────────────────────── 生成器自检 ─────────────────────────

/**
 * 生成的源码在**交出去之前**先过一遍语法校验。
 *
 * 为什么需要：写生成器时最惨的一类 bug 是"生成出来的源码是半截的" —— 比如模板字面量里
 * 想输出 `\n` 结果输出了真换行，把生成代码切成两截。那个 bug 我在同一个文件上踩了三次，
 * 每次都要等到 `new Function`（或者在运行期）才现形，而且报错是 `Unexpected EOF`，
 * 完全看不出是生成器哪一行的问题。
 *
 * 这里当场 parse 一遍，报错时把出问题的行号连上下文一起带出来。
 * 代价是生成时多一次 parse —— 生成很罕见，无所谓。
 */
function checked(src: string, what: string): string {
  try {
    new Function(`${src}\nreturn build;`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 定位：生成的代码里**引号不成对**的行，就是被切成两截的地方。
    // （这类 bug 的唯一来源是模板字面量里的转义写错了 —— 我在同一个坑里踩过三次。）
    const lines = src.split("\n");
    const odd = lines
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => (l.match(/"/g)?.length ?? 0) % 2 === 1)
      .slice(0, 4);
    const where =
      odd.length > 0
        ? `  引号不成对的行（断点就在这些行附近）：\n` +
          odd.map(([n, l]) => `  ${n}| ${l.slice(0, 110)}`).join("\n")
        : `  没找到引号不成对的行（末端：${lines.slice(-2).join(" ⏎ ").slice(0, 110)}）`;
    throw new CodegenError(
      `[codegen] 生成的源码（${what}）过不了语法检查：${msg}\n` +
        `  共 ${lines.length} 行。\n${where}\n` +
        `  生成器最常犯的错是模板字面量里的转义 —— 想输出 \\n 就得写 \\\\n，` +
        `写成一个 \\n 会变成真换行，把生成代码切成两截。`,
    );
  }
  return src;
}

/** 生成单个 pass 的遍历器源码。 */
export function emitWalker(spec: WalkerSpec): string {
  return checked(emitWalkerSrc(spec), `${spec.from.id}->${spec.to.id}`);
}

/** 生成一组 pass 的融合遍历器源码（递归版，快）。 */
export function emitFusedGroupRec(specs: readonly WalkerSpec[]): string {
  const label = specs.map((x) => x.from.id).join("→");
  return checked(emitFusedGroupRecSrc(specs), `融合 ${label}`);
}

/** 生成一组 pass 的融合遍历器源码（蹦床版，identity 不占原生栈）。 */
export function emitFusedGroupTramp(specs: readonly WalkerSpec[]): string {
  const label = specs.map((x) => x.from.id).join("→");
  return checked(emitFusedGroupTrampSrc(specs), `蹦床 ${label}`);
}

// ───────────────────────── 管线融合（G6 第一块）─────────────────────────

/**
 * 一组「同语言、arity 0」的 pass 融成一个遍历。
 *
 * ── 朴素的做法错在哪
 *
 * 天真的写法是 `F_i(node) = F_{i+1}(P_i(node))`，其中 P_i 的 rec 绑到 F_i。问题是
 * **子节点会被处理两遍**：一次经由 rec（走 i..end），一次经由外层的 F_{i+1}
 * （它递归进父节点的结果，于是又走一遍子节点）。
 *
 * ── 实际做法：deep + shallow
 *
 *   deep(node)   = 用第一门 pass 深做这个节点（子节点走 deep），
 *                  然后依次把第 2..k 门 pass **浅做**在这个结果上
 *   shallow_i(v) = 第 i 门 pass 在这个节点上的 hander/identity，**子节点原样用**
 *                  （它们已经被整组处理过了）
 *
 * 这样每个节点每门 pass 只走一次，而且中间结果不用物化成树。
 *
 * ── 和「一门一门跑」的语义差别（必须说清楚）
 *
 * 跑法 A（不融合）：P1 全树 → P2 全树 → …，所以 P1 在父节点上看到的是**只被 P1
 * 处理过**的子节点。
 * 跑法 B（融合）：P1 在父节点上看到的是**被整组处理过**的子节点。
 *
 * 所以如果 P1 的 handler 会去**看子节点的 tag**，而 P2 会改那个 tag，两者就不等价。
 * 本组的两个 pass（normalizeBegin / normalizePrimArity）只看自己节点的字段和子节点
 * **个数**，不看子节点的 tag —— 所以安全。
 *
 * 这类判断需要分析「哪门 pass 会看子节点的 tag」，**现在没做**。所以融合的范围限制在
 * 「非终结符名字一致 + arity 0」，并且每一组都用「融合前后逐字节相同」当护栏
 * （见 e2e 的断言）。
 *
 * 顺带一条实测的观察：本管线里 12 门 pass 的 handler **没有一个会看子节点的 tag** ——
 * 它们只看自己节点的字段、子节点的**个数**、以及子节点的 type（那是分派，不是语义判断）。
 * 所以整条融合链跑出来逐字节相同。但这是**观察，不是证明**；护栏还得留着。
 */
/**
 * 融合的**递归**版：快，但深度受原生栈限制。
 *
 * 蹦床版（emitFusedGroupTramp）把 identity 那条路变成迭代，深度不受限，但每节点多分配
 * 一个帧对象 —— 实测慢 20% 左右。所以两个都留着，由调用方选。
 *
 *   快（递归）  1.38×    identity 链深度 ~13k
 *   深（蹦床）  0.79×    identity 链深度 200 万+
 *
 * 默认用快的那个：绝大多数输入不会深到爆栈，而 20% 是每一条输入都要付的。
 * 输入深度不可控的场景（用户写的源码、机器生成的代码）该选蹦床版。
 */
function emitFusedGroupRecSrc(specs: readonly WalkerSpec[]): string {
  if (specs.length === 0) throw new CodegenError("[fuse] 空格子");
  const first = specs[0]!;
  // 融合的连线是按**非终结符名字**走的，所以卡的是名字集合，不是语言 id。
  const ntNames = (sp: WalkerSpec): string => Object.keys(sp.from.rules).sort().join(",");
  for (const sp of specs) {
    if (ntNames(sp) !== ntNames(first)) {
      throw new CodegenError(
        `[fuse] 组里的非终结符名字对不上：${sp.from.id} 是 ${ntNames(sp)}，${first.from.id} 是 ${ntNames(first)}`,
      );
    }
    if (sp.arity !== 0) {
      throw new CodegenError(
        `[fuse] ${sp.from.id}: arity ${sp.arity} 的 pass 不能融合（带 extra 的会自己控制下降）`,
      );
    }
    checkTagUniqueness(sp);
  }
  const lang = first.from.rules;

  const nts = Object.keys(lang);
  const fns: string[] = [];

  // ── 浅做：每门 pass 一个，按 tag 分派
  for (let i = 1; i < specs.length; i++) {
    const sp = specs[i]!;
    for (const nt of nts) {
      const prods = sp.from.rules[nt] ?? {};
      const cases: string[] = [];
      for (const tag of Object.keys(prods)) {
        const hasHandler = sp.rules[nt]?.[tag] !== undefined;
        // 浅做：identity 就是原样返回（子节点已经是终态），handler 才动
        const body = hasHandler
          ? `      out = finish(v, handlersList[${i}][${s(nt)}][${s(tag)}](v, idRec));`
          : `      out = v;`;
        cases.push(`    case ${s(tag)}: {\n${body}\n      break;\n    }`);
      }
      cases.push(
        `    default:\n` +
          `      throw new Error("[fuse] ${sp.from.id} 的非终结符 ${nt} 里没有产生式 " + v.type + "（" + whereOf(v) + "）");`,
      );
      fns.push(
        `  function sh_${i}_${nt}(v) {\n    let out;\n    switch (v.type) {\n${cases.join("\n")}\n    }\n    return out;\n  }`,
      );
    }
  }

  // ── 深做：用第 0 门 pass，子节点走 deep；做完之后依次浅做
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
        `      throw new Error("[fuse ${first.from.id}] 非终结符 ${nt} 里没有产生式 " + n.type + "（" + whereOf(n) + "）");`,
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

  return `// 由 codegen 生成（融合）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   ${specs.map((x) => x.from.id).join(" → ")}   （${specs.length} 门融成 1 个遍历）
function build(handlersList, init) {
  const LANG = ${s(first.to.id)};
  const idRec = (x) => x;
  let depth = 0;
  let maxDepth = 0;
  let deepest = null;

  function whereOf(node) {
    const m = node && node.__meta__;
    if (!m) return "（没有位置信息）";
    return (m.file ?? "?") + ":" + (m.line ?? "?") + (m.col !== undefined ? ":" + m.col : "");
  }

  function guard(f) {
    try { return f(); } catch (e) {
      if (e instanceof RangeError && /stack/i.test(String(e.message))) {
        const err = new Error("[fuse ${first.from.id}] 输入嵌套太深：" + whereOf(deepest) + "（走到 " + maxDepth + " 层就溢出了）。");
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
    // 列表（list 字段 / rec 收到一串子节点）：逐个下树，顺序保持
    if (Array.isArray(x)) return x.map(deep);
    const w = DEEP[x.type];
    if (w === undefined) {
      throw new Error("[fuse ${first.from.id}] rec() 遇到不认识的产生式 " + x.type + "（" + whereOf(x) + "）");
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

/** 深做时的 identity：子节点走 deep。 */
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

function emitFusedGroupTrampSrc(specs: readonly WalkerSpec[]): string {
  if (specs.length === 0) throw new CodegenError("[fuse] 空格子");
  const first = specs[0]!;
  // 融合的连线是按**非终结符名字**走的，所以卡的是名字集合，不是语言 id。
  const ntNames = (sp: WalkerSpec): string => Object.keys(sp.from.rules).sort().join(",");
  for (const sp of specs) {
    if (ntNames(sp) !== ntNames(first)) {
      throw new CodegenError(
        `[fuse] 组里的非终结符名字对不上：${sp.from.id} 是 ${ntNames(sp)}，${first.from.id} 是 ${ntNames(first)}`,
      );
    }
    if (sp.arity !== first.arity) {
      throw new CodegenError(
        `[fuse] 组里的 arity 不一致：${sp.from.id} 是 ${sp.arity}，${first.from.id} 是 ${first.arity}`,
      );
    }
    if (specs.length > 1 && sp.arity !== 0) {
      throw new CodegenError(
        `[fuse] ${sp.from.id}: arity ${sp.arity} 的 pass 不能和多门融（浅做表达不了线程）`,
      );
    }
    checkTagUniqueness(sp);
  }

  const lang = first.from.rules;
  const nts = Object.keys(lang);

  // ── 生成的表

  // tag → 非终结符（tag 在一个语言里唯一，这是 checkTagUniqueness 保证的）
  const tagNt: Record<string, string> = {};
  for (const nt of nts) for (const tag of Object.keys(lang[nt]!)) tagNt[tag] = nt;

  // tag → 子节点字段表，按声明顺序。驱动器靠它决定下降顺序。
  // kind：n = 单个节点，l = 节点列表，m = 可选节点
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

  // 帧里放结果的槽位个数 = 所有 tag 里子节点字段最多的那个。
  // 用编号槽位而不是一个数组：省掉每节点一次数组分配（那是热路径）。
  const maxSlots = Math.max(1, ...Object.values(tagFields).map((f) => f.length));
  const slotNames = Array.from({ length: maxSlots }, (_, i) => `r${i}`);
  const slotInit = slotNames.map((n) => `${n}: undefined`).join(", ");
  // 按 i 写槽位 —— 用 switch 而不是 fr["r" + i]：动态键会退化成字典查找
  const slotCases = slotNames.map((n, i) => `      case ${i}: fr.${n} = v; return;`).join("\n");

  // identity 的构造：把收集到的子节点结果 rs 装进字面量。
  // 每个 tag 一个 case —— 这里**没有递归**，子节点在 rs 里躺着。
  // 单门、且同语言 → 允许"子节点一个都没变就返回原节点"。
  // 和 emitWalkerSrc 的 identity 路径同一个理由：不动点判定要能一次 `===` 判定（t13），
  // 顺带省掉没动过的子树的重分配。多门融的时候不行 —— 那是链式的，节点归属于不同阶段。
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
      // 同上：叶子永远"没变"，直接返回 n（不然引用永远不等）
      const built = !canReuse ? obj : checks.length === 0 ? "n" : `(${checks.join(" || ")}) ? ${obj} : n`;
      buildCases.push(`    case ${s(tag)}:\n      return ${built};`);
    }
  }

  return `// 由 codegen 生成（融合 + 蹦床）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   ${specs.map((x) => x.from.id).join(" → ")} → ${specs[specs.length - 1]!.to.id}   （${specs.length} 门融成 1 个遍历）
//
// 这里是**显式帧栈 + dispatch 循环**，不是递归下树：identity 那条路上一个 JS 栈帧都不占。
// handler 里的 rec 也接到同一个蹦床上（会开一层嵌套的 drive），所以子树遍历也是迭代的。
// 唯一还会占原生栈的是「handler 里调 rec、子节点又有 handler」这种嵌套 —— 层数等于
// 路径上带 handler 的节点数（见 t18 的注释）。
function build(handlersList, init) {
  // 一个组的结果属于**最后一门** pass 的输出语言 —— 不是第一门的
  const LANG = ${s(specs[specs.length - 1]!.to.id)};
  /** 列表逐元素比引用 —— "没改就复用"用。 */
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

  // tag → 子节点字段表（按声明顺序）。kind: n 单节点 / l 列表 / m 可选
  const FIELDS = {
${Object.entries(tagFields)
  .map(([tag, fields]) => `    ${s(tag)}: ${JSON.stringify(fields)},`)
  .join("\n")}
  };

  // 每个 pass 一张 tag → handler 的平表。省掉每次按非终结符再查一层。
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

  // __lang__ / __meta__ 的补丁处。
  //
  // 只有顶层不够 —— handler 会在返回值里**新造**节点（比如 desugar 出的 Lam），那些也得带上
  // __lang__ 和源位置。所以往下走，但**只走新造的**：已经有 __lang__ 的是上一轮的产物。
  // 代价是 O(本次新造的节点数)，不是 O(子树大小)。
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
      throw new Error("[fuse ${first.from.id}] 没有产生式 " + tag + " 的构造子");
    }
  }

  // ── 蹦床 ──
  //
  // 帧的形状（只有一个对象类型，字段固定，所以隐藏类是稳定的）：
  //   { node, fs, rs, i, li, lacc }
  //   fs   这个 tag 的子节点字段表
  //   rs   每个子节点字段收到的结果（按 fs 的顺序）
  //   i    正在处理第几个字段
  //   li   列表字段走到第几个元素；lacc 是攒到一半的数组（null = 还没开始）

  /** 找出这一帧下一个要下降的**节点**；没有就返回 undefined（这一帧可以收尾了）。 */
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
      // 列表
      if (fr.lacc === null) { fr.lacc = []; fr.li = 0; }
      if (fr.li < v.length) { const x = v[fr.li]; fr.li += 1; return x; }
      setSlot(fr, fr.i, fr.lacc);
      fr.lacc = null;
      fr.i += 1;
    }
  }

  /** 收下一个子节点的结果。K > 0 时 value 是 [节点, ...extra]，extra 串给下一个兄弟。 */
  /** 按槽位号写结果。用 switch 而不是动态键：动态键会退化成字典查找。 */
  function setSlot(fr, i, v) {
    switch (i) {
${slotCases}
      default:
        throw new Error("[fuse ${first.from.id}] 槽位越界 " + i);
    }
  }

  function accept(fr, value) {
    if (K > 0) fr.ctx = value.slice(1);
    const node0 = K > 0 ? value[0] : value;
    if (fr.fs[fr.i][1] === "l") { fr.lacc.push(node0); return; }
    setSlot(fr, fr.i, node0);
    fr.i += 1;
  }

  /** 这一帧收尾：先跑第一门 pass（handler 或 identity），再依次浅做后面几门。 */
  function buildOne(fr) {
    const tag = fr.node.type;
    const h = H0[tag];
    let v;
    if (h !== undefined) {
      // handler 是黑的（叶子）：它的 rec 拿到的是**这个蹦床**，所以子树还是迭代的。
      // K > 0 时它返回的是元组 [节点, ...extra]，finish 只能作用在节点上 ——
      // 直接把元组喂给 finish 会被当成"数组，原样返回"，然后整个元组被塞进字段里。
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
      const s = SHALLOW[i][tag];
      if (s !== undefined) v = finish(fr.node, s(v, idRec));
    }
    return K > 0 ? [v, ...fr.ctx] : v;
  }

  let lastNode = null;

  function whereOf(node) {
    const m = node && node.__meta__;
    if (!m) return "（没有位置信息）";
    return (m.file ?? "?") + ":" + (m.line ?? "?") + (m.col !== undefined ? ":" + m.col : "");
  }

  // 有 handler 的 tag 当成叶子：**驱动器不下降**，handler 自己会调 rec。
  // 不这么写就会下降一遍、handler 里又 rec 一遍 —— 子节点被处理两次
  // （不幂等的 pass 立刻出问题：临时名会多走一格）。
  const NO_CHILDREN = [];

  function drive(root, ...ctx0) {
    // 列表：跟单 pass 的 rec 一样 —— 一个元素的 extra 吐给下一个（顺序保持）。
    // **漏了这个分支会炸在"不认识的产生式 undefined"上**，因为数组没有 .type。
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
    let mode = 0; // 0 = 有个节点要处理，1 = 有个结果要交给栈顶
    lastNode = root;

    for (;;) {
      if (mode === 0) {
        lastNode = node;
        const fs = H0[node.type] !== undefined ? NO_CHILDREN : FIELDS[node.type];
        if (fs === undefined) {
          throw new Error(
            "[fuse ${first.from.id}] 不认识的产生式 " + node.type +
              "（__lang__=" + (node && node.__lang__) + "，" + whereOf(node) + "）",
          );
        }
        // 帧的 ctx 从上（父帧或本次调用的入参）继承 —— 这就是线程
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
          "[fuse ${first.from.id}] 输入嵌套太深：" + whereOf(lastNode) +
            "。\\n  融合遍历器的 identity 那条路不占原生栈，但 handler 里调 rec、子节点又有 handler 时会嵌套 —— 层数等于路径上带 handler 的节点数（t18 / t27）。",
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
