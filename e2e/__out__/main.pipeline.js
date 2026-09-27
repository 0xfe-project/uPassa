// 由 e2e/gen.ts 生成，不要手改 —— 改 pass / 语言 / 融合逻辑，然后重跑 pnpm gen。
//
// 管线 "main"：Lnum → L7，16 步 → 12 组。
//
// 这份文件**就是**在跑的那份代码（不是拿字符串再 new Function 编一遍）。
// handler 从 e2e/pipeline.ts 的 steps 上取 —— 这里不复制 pass 的逻辑。

import { MAIN } from "../pipeline.ts";
import { fixpointLoop, rewriteLoop } from "../loops.ts";

export const steps = MAIN.describe().steps;

const PW0 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   Lnum -> Lsrc   （extra 1 个值，线程）
function build(handlers, init) {
  const LANG = "Lsrc";

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
          "[Lnum] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x, ...c) {
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
        "[Lnum] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x, ...c);
  }

  function walk_Program(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.defs) {
        const t1 = walk_Def(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const o3 = [];
      for (const y5 of n.body) {
        const t4 = walk_Expr(y5, c0);
        c0 = t4[1];
        if (t4[0] !== y5) changed = true;
        o3.push(t4[0]);
      }
      out = [finish(n, { type: "Prog", "defs": o0, "body": o3 }), c0];
      }
      break;
    }
    default:
      throw new Error("[Lnum] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefFun": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.params) {
        const t1 = walk_Param(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const t3 = walk_Expr(n.body, c0);
      c0 = t3[1];
      if (t3[0] !== n.body) changed = true;
      out = [finish(n, { type: "DefFun", "name": n.name, "params": o0, "body": t3[0] }), c0];
      }
      break;
    }
    case "DefVal": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [finish(n, { type: "DefVal", "name": n.name, "value": t0[0] }), c0];
      }
      break;
    }
    default:
      throw new Error("[Lnum] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      {
      let changed = false;
      out = [finish(n, { type: "Param", "name": n.name }), c0];
      }
      break;
    }
    default:
      throw new Error("[Lnum] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
      let changed = false;
      const t0 = walk_Expr(n.test, c0);
      c0 = t0[1];
      if (t0[0] !== n.test) changed = true;
      const t1 = walk_Expr(n.body, c0);
      c0 = t1[1];
      if (t1[0] !== n.body) changed = true;
      out = [finish(n, { type: "Clause", "test": t0[0], "body": t1[0] }), c0];
      }
      break;
    }
    default:
      throw new Error("[Lnum] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [finish(n, { type: "Bind", "name": n.name, "value": t0[0] }), c0];
      }
      break;
    }
    default:
      throw new Error("[Lnum] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      {
      let changed = false;
      out = [finish(n, { type: "Void" }), c0];
      }
      break;
    }
    case "Bool": {
      {
      let changed = false;
      out = [finish(n, { type: "Bool", "value": n.value }), c0];
      }
      break;
    }
    case "Str": {
      {
      let changed = false;
      out = [finish(n, { type: "Str", "value": n.value }), c0];
      }
      break;
    }
    case "Var": {
      {
        const t = handlers["Expr"]["Var"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "If": {
      {
      let changed = false;
      const t0 = walk_Expr(n.cond, c0);
      c0 = t0[1];
      if (t0[0] !== n.cond) changed = true;
      const t1 = walk_Expr(n.then, c0);
      c0 = t1[1];
      if (t1[0] !== n.then) changed = true;
      const t2 = walk_Expr(n.alt, c0);
      c0 = t2[1];
      if (t2[0] !== n.alt) changed = true;
      out = [finish(n, { type: "If", "cond": t0[0], "then": t1[0], "alt": t2[0] }), c0];
      }
      break;
    }
    case "IfAlt": {
      {
      let changed = false;
      const t0 = walk_Expr(n.cond, c0);
      c0 = t0[1];
      if (t0[0] !== n.cond) changed = true;
      const t1 = walk_Expr(n.then, c0);
      c0 = t1[1];
      if (t1[0] !== n.then) changed = true;
      out = [finish(n, { type: "IfAlt", "cond": t0[0], "then": t1[0] }), c0];
      }
      break;
    }
    case "When": {
      {
      let changed = false;
      const t0 = walk_Expr(n.cond, c0);
      c0 = t0[1];
      if (t0[0] !== n.cond) changed = true;
      const t1 = walk_Expr(n.body, c0);
      c0 = t1[1];
      if (t1[0] !== n.body) changed = true;
      out = [finish(n, { type: "When", "cond": t0[0], "body": t1[0] }), c0];
      }
      break;
    }
    case "Unless": {
      {
      let changed = false;
      const t0 = walk_Expr(n.cond, c0);
      c0 = t0[1];
      if (t0[0] !== n.cond) changed = true;
      const t1 = walk_Expr(n.body, c0);
      c0 = t1[1];
      if (t1[0] !== n.body) changed = true;
      out = [finish(n, { type: "Unless", "cond": t0[0], "body": t1[0] }), c0];
      }
      break;
    }
    case "Cond": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.clauses) {
        const t1 = walk_Clause(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      let o3;
      if (n.else !== undefined) {
        const t4 = walk_Expr(n.else, c0);
        c0 = t4[1];
        if (t4[0] !== n.else) changed = true;
        o3 = t4[0];
      }
      out = [finish(n, { type: "Cond", "clauses": o0, "else": o3 }), c0];
      }
      break;
    }
    case "And": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.exprs) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [finish(n, { type: "And", "exprs": o0 }), c0];
      }
      break;
    }
    case "Or": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.exprs) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [finish(n, { type: "Or", "exprs": o0 }), c0];
      }
      break;
    }
    case "Not": {
      {
      let changed = false;
      const t0 = walk_Expr(n.expr, c0);
      c0 = t0[1];
      if (t0[0] !== n.expr) changed = true;
      out = [finish(n, { type: "Not", "expr": t0[0] }), c0];
      }
      break;
    }
    case "Begin": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.exprs) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [finish(n, { type: "Begin", "exprs": o0 }), c0];
      }
      break;
    }
    case "Let": {
      {
        const t = handlers["Expr"]["Let"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "LetStar": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.bindings) {
        const t1 = walk_Bind(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const t3 = walk_Expr(n.body, c0);
      c0 = t3[1];
      if (t3[0] !== n.body) changed = true;
      out = [finish(n, { type: "LetStar", "bindings": o0, "body": t3[0] }), c0];
      }
      break;
    }
    case "Letrec": {
      {
        const t = handlers["Expr"]["Letrec"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Lam": {
      {
        const t = handlers["Expr"]["Lam"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Call": {
      {
      let changed = false;
      const t0 = walk_Expr(n.fn, c0);
      c0 = t0[1];
      if (t0[0] !== n.fn) changed = true;
      const o1 = [];
      for (const y3 of n.args) {
        const t2 = walk_Expr(y3, c0);
        c0 = t2[1];
        if (t2[0] !== y3) changed = true;
        o1.push(t2[0]);
      }
      out = [finish(n, { type: "Call", "fn": t0[0], "args": o1 }), c0];
      }
      break;
    }
    case "Prim": {
      {
        const t = handlers["Expr"]["Prim"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Num": {
      {
        const t = handlers["Expr"]["Num"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    default:
      throw new Error("[Lnum] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefFun": walk_Def,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "IfAlt": walk_Expr,
    "When": walk_Expr,
    "Unless": walk_Expr,
    "Cond": walk_Expr,
    "And": walk_Expr,
    "Or": walk_Expr,
    "Not": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "LetStar": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
    "Num": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x, ...init());
      return r[0];
    });
  }

  return { run, rec, arity: 1 };
}

return build;
})();

const PW1 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   Lsrc -> L1
function build(handlers, init) {
  const LANG = "L1";

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
          "[Lsrc] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x) {
    if (Array.isArray(x)) return x.map(rec);
    if (x === null || x === undefined) return x;
    const w = BY_TAG[x.type];
    if (w === undefined) {
      throw new Error(
        "[Lsrc] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x);
  }

  function walk_Program(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
        const v0 = n.defs.map(walk_Def);
        const v1 = n.body.map(walk_Expr);
        out = finish(n, { type: "Prog", "defs": v0, "body": v1 });
      }
      break;
    }
    default:
      throw new Error("[Lsrc] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefFun": {
      out = finish(n, handlers["Def"]["DefFun"](n, rec));
      break;
    }
    case "DefVal": {
      {
        const v0 = walk_Expr(n.value);
        out = finish(n, { type: "DefVal", "name": n.name, "value": v0 });
      }
      break;
    }
    default:
      throw new Error("[Lsrc] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      out = finish(n, { type: "Param", "name": n.name });
      break;
    }
    default:
      throw new Error("[Lsrc] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
        const v0 = walk_Expr(n.test);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Clause", "test": v0, "body": v1 });
      }
      break;
    }
    default:
      throw new Error("[Lsrc] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
        const v0 = walk_Expr(n.value);
        out = finish(n, { type: "Bind", "name": n.name, "value": v0 });
      }
      break;
    }
    default:
      throw new Error("[Lsrc] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      out = finish(n, { type: "Void" });
      break;
    }
    case "Int": {
      out = finish(n, { type: "Int", "value": n.value });
      break;
    }
    case "Float": {
      out = finish(n, { type: "Float", "value": n.value });
      break;
    }
    case "Bool": {
      out = finish(n, { type: "Bool", "value": n.value });
      break;
    }
    case "Str": {
      out = finish(n, { type: "Str", "value": n.value });
      break;
    }
    case "Var": {
      out = finish(n, { type: "Var", "name": n.name });
      break;
    }
    case "If": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.then);
        const v2 = walk_Expr(n.alt);
        out = finish(n, { type: "If", "cond": v0, "then": v1, "alt": v2 });
      }
      break;
    }
    case "IfAlt": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.then);
        out = finish(n, { type: "IfAlt", "cond": v0, "then": v1 });
      }
      break;
    }
    case "When": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "When", "cond": v0, "body": v1 });
      }
      break;
    }
    case "Unless": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Unless", "cond": v0, "body": v1 });
      }
      break;
    }
    case "Cond": {
      {
        const v0 = n.clauses.map(walk_Clause);
        const v1 = n.else === undefined ? undefined : walk_Expr(n.else);
        out = finish(n, { type: "Cond", "clauses": v0, "else": v1 });
      }
      break;
    }
    case "And": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = finish(n, { type: "And", "exprs": v0 });
      }
      break;
    }
    case "Or": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = finish(n, { type: "Or", "exprs": v0 });
      }
      break;
    }
    case "Not": {
      {
        const v0 = walk_Expr(n.expr);
        out = finish(n, { type: "Not", "expr": v0 });
      }
      break;
    }
    case "Begin": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = finish(n, { type: "Begin", "exprs": v0 });
      }
      break;
    }
    case "Let": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Let", "bindings": v0, "body": v1 });
      }
      break;
    }
    case "LetStar": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "LetStar", "bindings": v0, "body": v1 });
      }
      break;
    }
    case "Letrec": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Letrec", "bindings": v0, "body": v1 });
      }
      break;
    }
    case "Lam": {
      {
        const v0 = n.params.map(walk_Param);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Lam", "params": v0, "body": v1 });
      }
      break;
    }
    case "Call": {
      {
        const v0 = walk_Expr(n.fn);
        const v1 = n.args.map(walk_Expr);
        out = finish(n, { type: "Call", "fn": v0, "args": v1 });
      }
      break;
    }
    case "Prim": {
      {
        const v0 = n.args.map(walk_Expr);
        out = finish(n, { type: "Prim", "op": n.op, "args": v0 });
      }
      break;
    }
    default:
      throw new Error("[Lsrc] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefFun": walk_Def,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "IfAlt": walk_Expr,
    "When": walk_Expr,
    "Unless": walk_Expr,
    "Cond": walk_Expr,
    "And": walk_Expr,
    "Or": walk_Expr,
    "Not": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "LetStar": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x);
      return r;
    });
  }

  return { run, rec, arity: 0 };
}

return build;
})();

const PW2 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L1 -> L2
function build(handlers, init) {
  const LANG = "L2";

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
          "[L1] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x) {
    if (Array.isArray(x)) return x.map(rec);
    if (x === null || x === undefined) return x;
    const w = BY_TAG[x.type];
    if (w === undefined) {
      throw new Error(
        "[L1] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x);
  }

  function walk_Program(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
        const v0 = n.defs.map(walk_Def);
        const v1 = n.body.map(walk_Expr);
        out = finish(n, { type: "Prog", "defs": v0, "body": v1 });
      }
      break;
    }
    default:
      throw new Error("[L1] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
        const v0 = walk_Expr(n.value);
        out = finish(n, { type: "DefVal", "name": n.name, "value": v0 });
      }
      break;
    }
    default:
      throw new Error("[L1] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      out = finish(n, { type: "Param", "name": n.name });
      break;
    }
    default:
      throw new Error("[L1] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
        const v0 = walk_Expr(n.test);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Clause", "test": v0, "body": v1 });
      }
      break;
    }
    default:
      throw new Error("[L1] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
        const v0 = walk_Expr(n.value);
        out = finish(n, { type: "Bind", "name": n.name, "value": v0 });
      }
      break;
    }
    default:
      throw new Error("[L1] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      out = finish(n, { type: "Void" });
      break;
    }
    case "Int": {
      out = finish(n, { type: "Int", "value": n.value });
      break;
    }
    case "Float": {
      out = finish(n, { type: "Float", "value": n.value });
      break;
    }
    case "Bool": {
      out = finish(n, { type: "Bool", "value": n.value });
      break;
    }
    case "Str": {
      out = finish(n, { type: "Str", "value": n.value });
      break;
    }
    case "Var": {
      out = finish(n, { type: "Var", "name": n.name });
      break;
    }
    case "If": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.then);
        const v2 = walk_Expr(n.alt);
        out = finish(n, { type: "If", "cond": v0, "then": v1, "alt": v2 });
      }
      break;
    }
    case "IfAlt": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.then);
        out = finish(n, { type: "IfAlt", "cond": v0, "then": v1 });
      }
      break;
    }
    case "When": {
      out = finish(n, handlers["Expr"]["When"](n, rec));
      break;
    }
    case "Unless": {
      out = finish(n, handlers["Expr"]["Unless"](n, rec));
      break;
    }
    case "Cond": {
      {
        const v0 = n.clauses.map(walk_Clause);
        const v1 = n.else === undefined ? undefined : walk_Expr(n.else);
        out = finish(n, { type: "Cond", "clauses": v0, "else": v1 });
      }
      break;
    }
    case "And": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = finish(n, { type: "And", "exprs": v0 });
      }
      break;
    }
    case "Or": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = finish(n, { type: "Or", "exprs": v0 });
      }
      break;
    }
    case "Not": {
      {
        const v0 = walk_Expr(n.expr);
        out = finish(n, { type: "Not", "expr": v0 });
      }
      break;
    }
    case "Begin": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = finish(n, { type: "Begin", "exprs": v0 });
      }
      break;
    }
    case "Let": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Let", "bindings": v0, "body": v1 });
      }
      break;
    }
    case "LetStar": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "LetStar", "bindings": v0, "body": v1 });
      }
      break;
    }
    case "Letrec": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Letrec", "bindings": v0, "body": v1 });
      }
      break;
    }
    case "Lam": {
      {
        const v0 = n.params.map(walk_Param);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Lam", "params": v0, "body": v1 });
      }
      break;
    }
    case "Call": {
      {
        const v0 = walk_Expr(n.fn);
        const v1 = n.args.map(walk_Expr);
        out = finish(n, { type: "Call", "fn": v0, "args": v1 });
      }
      break;
    }
    case "Prim": {
      {
        const v0 = n.args.map(walk_Expr);
        out = finish(n, { type: "Prim", "op": n.op, "args": v0 });
      }
      break;
    }
    default:
      throw new Error("[L1] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "IfAlt": walk_Expr,
    "When": walk_Expr,
    "Unless": walk_Expr,
    "Cond": walk_Expr,
    "And": walk_Expr,
    "Or": walk_Expr,
    "Not": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "LetStar": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x);
      return r;
    });
  }

  return { run, rec, arity: 0 };
}

return build;
})();

const PW3 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L2 -> L3
function build(handlers, init) {
  const LANG = "L3";

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
          "[L2] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x) {
    if (Array.isArray(x)) return x.map(rec);
    if (x === null || x === undefined) return x;
    const w = BY_TAG[x.type];
    if (w === undefined) {
      throw new Error(
        "[L2] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x);
  }

  function walk_Program(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
        const v0 = n.defs.map(walk_Def);
        const v1 = n.body.map(walk_Expr);
        out = finish(n, { type: "Prog", "defs": v0, "body": v1 });
      }
      break;
    }
    default:
      throw new Error("[L2] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
        const v0 = walk_Expr(n.value);
        out = finish(n, { type: "DefVal", "name": n.name, "value": v0 });
      }
      break;
    }
    default:
      throw new Error("[L2] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      out = finish(n, { type: "Param", "name": n.name });
      break;
    }
    default:
      throw new Error("[L2] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
        const v0 = walk_Expr(n.test);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Clause", "test": v0, "body": v1 });
      }
      break;
    }
    default:
      throw new Error("[L2] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
        const v0 = walk_Expr(n.value);
        out = finish(n, { type: "Bind", "name": n.name, "value": v0 });
      }
      break;
    }
    default:
      throw new Error("[L2] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      out = finish(n, { type: "Void" });
      break;
    }
    case "Int": {
      out = finish(n, { type: "Int", "value": n.value });
      break;
    }
    case "Float": {
      out = finish(n, { type: "Float", "value": n.value });
      break;
    }
    case "Bool": {
      out = finish(n, { type: "Bool", "value": n.value });
      break;
    }
    case "Str": {
      out = finish(n, { type: "Str", "value": n.value });
      break;
    }
    case "Var": {
      out = finish(n, { type: "Var", "name": n.name });
      break;
    }
    case "If": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.then);
        const v2 = walk_Expr(n.alt);
        out = finish(n, { type: "If", "cond": v0, "then": v1, "alt": v2 });
      }
      break;
    }
    case "IfAlt": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.then);
        out = finish(n, { type: "IfAlt", "cond": v0, "then": v1 });
      }
      break;
    }
    case "Cond": {
      out = finish(n, handlers["Expr"]["Cond"](n, rec));
      break;
    }
    case "And": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = finish(n, { type: "And", "exprs": v0 });
      }
      break;
    }
    case "Or": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = finish(n, { type: "Or", "exprs": v0 });
      }
      break;
    }
    case "Not": {
      {
        const v0 = walk_Expr(n.expr);
        out = finish(n, { type: "Not", "expr": v0 });
      }
      break;
    }
    case "Begin": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = finish(n, { type: "Begin", "exprs": v0 });
      }
      break;
    }
    case "Let": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Let", "bindings": v0, "body": v1 });
      }
      break;
    }
    case "LetStar": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "LetStar", "bindings": v0, "body": v1 });
      }
      break;
    }
    case "Letrec": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Letrec", "bindings": v0, "body": v1 });
      }
      break;
    }
    case "Lam": {
      {
        const v0 = n.params.map(walk_Param);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Lam", "params": v0, "body": v1 });
      }
      break;
    }
    case "Call": {
      {
        const v0 = walk_Expr(n.fn);
        const v1 = n.args.map(walk_Expr);
        out = finish(n, { type: "Call", "fn": v0, "args": v1 });
      }
      break;
    }
    case "Prim": {
      {
        const v0 = n.args.map(walk_Expr);
        out = finish(n, { type: "Prim", "op": n.op, "args": v0 });
      }
      break;
    }
    default:
      throw new Error("[L2] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "IfAlt": walk_Expr,
    "Cond": walk_Expr,
    "And": walk_Expr,
    "Or": walk_Expr,
    "Not": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "LetStar": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x);
      return r;
    });
  }

  return { run, rec, arity: 0 };
}

return build;
})();

const PW4 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L3 -> L4   （extra 1 个值，线程）
function build(handlers, init) {
  const LANG = "L4";

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
          "[L3] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x, ...c) {
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
        "[L3] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x, ...c);
  }

  function walk_Program(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.defs) {
        const t1 = walk_Def(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const o3 = [];
      for (const y5 of n.body) {
        const t4 = walk_Expr(y5, c0);
        c0 = t4[1];
        if (t4[0] !== y5) changed = true;
        o3.push(t4[0]);
      }
      out = [finish(n, { type: "Prog", "defs": o0, "body": o3 }), c0];
      }
      break;
    }
    default:
      throw new Error("[L3] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [finish(n, { type: "DefVal", "name": n.name, "value": t0[0] }), c0];
      }
      break;
    }
    default:
      throw new Error("[L3] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      {
      let changed = false;
      out = [finish(n, { type: "Param", "name": n.name }), c0];
      }
      break;
    }
    default:
      throw new Error("[L3] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
      let changed = false;
      const t0 = walk_Expr(n.test, c0);
      c0 = t0[1];
      if (t0[0] !== n.test) changed = true;
      const t1 = walk_Expr(n.body, c0);
      c0 = t1[1];
      if (t1[0] !== n.body) changed = true;
      out = [finish(n, { type: "Clause", "test": t0[0], "body": t1[0] }), c0];
      }
      break;
    }
    default:
      throw new Error("[L3] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [finish(n, { type: "Bind", "name": n.name, "value": t0[0] }), c0];
      }
      break;
    }
    default:
      throw new Error("[L3] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      {
      let changed = false;
      out = [finish(n, { type: "Void" }), c0];
      }
      break;
    }
    case "Int": {
      {
      let changed = false;
      out = [finish(n, { type: "Int", "value": n.value }), c0];
      }
      break;
    }
    case "Float": {
      {
      let changed = false;
      out = [finish(n, { type: "Float", "value": n.value }), c0];
      }
      break;
    }
    case "Bool": {
      {
      let changed = false;
      out = [finish(n, { type: "Bool", "value": n.value }), c0];
      }
      break;
    }
    case "Str": {
      {
      let changed = false;
      out = [finish(n, { type: "Str", "value": n.value }), c0];
      }
      break;
    }
    case "Var": {
      {
      let changed = false;
      out = [finish(n, { type: "Var", "name": n.name }), c0];
      }
      break;
    }
    case "If": {
      {
      let changed = false;
      const t0 = walk_Expr(n.cond, c0);
      c0 = t0[1];
      if (t0[0] !== n.cond) changed = true;
      const t1 = walk_Expr(n.then, c0);
      c0 = t1[1];
      if (t1[0] !== n.then) changed = true;
      const t2 = walk_Expr(n.alt, c0);
      c0 = t2[1];
      if (t2[0] !== n.alt) changed = true;
      out = [finish(n, { type: "If", "cond": t0[0], "then": t1[0], "alt": t2[0] }), c0];
      }
      break;
    }
    case "IfAlt": {
      {
      let changed = false;
      const t0 = walk_Expr(n.cond, c0);
      c0 = t0[1];
      if (t0[0] !== n.cond) changed = true;
      const t1 = walk_Expr(n.then, c0);
      c0 = t1[1];
      if (t1[0] !== n.then) changed = true;
      out = [finish(n, { type: "IfAlt", "cond": t0[0], "then": t1[0] }), c0];
      }
      break;
    }
    case "And": {
      {
        const t = handlers["Expr"]["And"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Or": {
      {
        const t = handlers["Expr"]["Or"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Not": {
      {
        const t = handlers["Expr"]["Not"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Begin": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.exprs) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [finish(n, { type: "Begin", "exprs": o0 }), c0];
      }
      break;
    }
    case "Let": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.bindings) {
        const t1 = walk_Bind(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const t3 = walk_Expr(n.body, c0);
      c0 = t3[1];
      if (t3[0] !== n.body) changed = true;
      out = [finish(n, { type: "Let", "bindings": o0, "body": t3[0] }), c0];
      }
      break;
    }
    case "LetStar": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.bindings) {
        const t1 = walk_Bind(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const t3 = walk_Expr(n.body, c0);
      c0 = t3[1];
      if (t3[0] !== n.body) changed = true;
      out = [finish(n, { type: "LetStar", "bindings": o0, "body": t3[0] }), c0];
      }
      break;
    }
    case "Letrec": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.bindings) {
        const t1 = walk_Bind(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const t3 = walk_Expr(n.body, c0);
      c0 = t3[1];
      if (t3[0] !== n.body) changed = true;
      out = [finish(n, { type: "Letrec", "bindings": o0, "body": t3[0] }), c0];
      }
      break;
    }
    case "Lam": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.params) {
        const t1 = walk_Param(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const t3 = walk_Expr(n.body, c0);
      c0 = t3[1];
      if (t3[0] !== n.body) changed = true;
      out = [finish(n, { type: "Lam", "params": o0, "body": t3[0] }), c0];
      }
      break;
    }
    case "Call": {
      {
      let changed = false;
      const t0 = walk_Expr(n.fn, c0);
      c0 = t0[1];
      if (t0[0] !== n.fn) changed = true;
      const o1 = [];
      for (const y3 of n.args) {
        const t2 = walk_Expr(y3, c0);
        c0 = t2[1];
        if (t2[0] !== y3) changed = true;
        o1.push(t2[0]);
      }
      out = [finish(n, { type: "Call", "fn": t0[0], "args": o1 }), c0];
      }
      break;
    }
    case "Prim": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.args) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [finish(n, { type: "Prim", "op": n.op, "args": o0 }), c0];
      }
      break;
    }
    default:
      throw new Error("[L3] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "IfAlt": walk_Expr,
    "And": walk_Expr,
    "Or": walk_Expr,
    "Not": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "LetStar": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x, ...init());
      return r[0];
    });
  }

  return { run, rec, arity: 1 };
}

return build;
})();

const PW5 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L4 -> L5
function build(handlers, init) {
  const LANG = "L5";

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
          "[L4] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x) {
    if (Array.isArray(x)) return x.map(rec);
    if (x === null || x === undefined) return x;
    const w = BY_TAG[x.type];
    if (w === undefined) {
      throw new Error(
        "[L4] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x);
  }

  function walk_Program(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
        const v0 = n.defs.map(walk_Def);
        const v1 = n.body.map(walk_Expr);
        out = finish(n, { type: "Prog", "defs": v0, "body": v1 });
      }
      break;
    }
    default:
      throw new Error("[L4] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
        const v0 = walk_Expr(n.value);
        out = finish(n, { type: "DefVal", "name": n.name, "value": v0 });
      }
      break;
    }
    default:
      throw new Error("[L4] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      out = finish(n, { type: "Param", "name": n.name });
      break;
    }
    default:
      throw new Error("[L4] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
        const v0 = walk_Expr(n.test);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Clause", "test": v0, "body": v1 });
      }
      break;
    }
    default:
      throw new Error("[L4] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
        const v0 = walk_Expr(n.value);
        out = finish(n, { type: "Bind", "name": n.name, "value": v0 });
      }
      break;
    }
    default:
      throw new Error("[L4] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      out = finish(n, { type: "Void" });
      break;
    }
    case "Int": {
      out = finish(n, { type: "Int", "value": n.value });
      break;
    }
    case "Float": {
      out = finish(n, { type: "Float", "value": n.value });
      break;
    }
    case "Bool": {
      out = finish(n, { type: "Bool", "value": n.value });
      break;
    }
    case "Str": {
      out = finish(n, { type: "Str", "value": n.value });
      break;
    }
    case "Var": {
      out = finish(n, { type: "Var", "name": n.name });
      break;
    }
    case "If": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.then);
        const v2 = walk_Expr(n.alt);
        out = finish(n, { type: "If", "cond": v0, "then": v1, "alt": v2 });
      }
      break;
    }
    case "IfAlt": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.then);
        out = finish(n, { type: "IfAlt", "cond": v0, "then": v1 });
      }
      break;
    }
    case "Begin": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = finish(n, { type: "Begin", "exprs": v0 });
      }
      break;
    }
    case "Let": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Let", "bindings": v0, "body": v1 });
      }
      break;
    }
    case "LetStar": {
      out = finish(n, handlers["Expr"]["LetStar"](n, rec));
      break;
    }
    case "Letrec": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Letrec", "bindings": v0, "body": v1 });
      }
      break;
    }
    case "Lam": {
      {
        const v0 = n.params.map(walk_Param);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Lam", "params": v0, "body": v1 });
      }
      break;
    }
    case "Call": {
      {
        const v0 = walk_Expr(n.fn);
        const v1 = n.args.map(walk_Expr);
        out = finish(n, { type: "Call", "fn": v0, "args": v1 });
      }
      break;
    }
    case "Prim": {
      {
        const v0 = n.args.map(walk_Expr);
        out = finish(n, { type: "Prim", "op": n.op, "args": v0 });
      }
      break;
    }
    default:
      throw new Error("[L4] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "IfAlt": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "LetStar": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x);
      return r;
    });
  }

  return { run, rec, arity: 0 };
}

return build;
})();

const PW6 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L5 -> L6
function build(handlers, init) {
  const LANG = "L6";

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
          "[L5] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x) {
    if (Array.isArray(x)) return x.map(rec);
    if (x === null || x === undefined) return x;
    const w = BY_TAG[x.type];
    if (w === undefined) {
      throw new Error(
        "[L5] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x);
  }

  function walk_Program(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
        const v0 = n.defs.map(walk_Def);
        const v1 = n.body.map(walk_Expr);
        out = finish(n, { type: "Prog", "defs": v0, "body": v1 });
      }
      break;
    }
    default:
      throw new Error("[L5] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
        const v0 = walk_Expr(n.value);
        out = finish(n, { type: "DefVal", "name": n.name, "value": v0 });
      }
      break;
    }
    default:
      throw new Error("[L5] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      out = finish(n, { type: "Param", "name": n.name });
      break;
    }
    default:
      throw new Error("[L5] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
        const v0 = walk_Expr(n.test);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Clause", "test": v0, "body": v1 });
      }
      break;
    }
    default:
      throw new Error("[L5] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
        const v0 = walk_Expr(n.value);
        out = finish(n, { type: "Bind", "name": n.name, "value": v0 });
      }
      break;
    }
    default:
      throw new Error("[L5] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      out = finish(n, { type: "Void" });
      break;
    }
    case "Int": {
      out = finish(n, { type: "Int", "value": n.value });
      break;
    }
    case "Float": {
      out = finish(n, { type: "Float", "value": n.value });
      break;
    }
    case "Bool": {
      out = finish(n, { type: "Bool", "value": n.value });
      break;
    }
    case "Str": {
      out = finish(n, { type: "Str", "value": n.value });
      break;
    }
    case "Var": {
      out = finish(n, { type: "Var", "name": n.name });
      break;
    }
    case "If": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.then);
        const v2 = walk_Expr(n.alt);
        out = finish(n, { type: "If", "cond": v0, "then": v1, "alt": v2 });
      }
      break;
    }
    case "IfAlt": {
      out = finish(n, handlers["Expr"]["IfAlt"](n, rec));
      break;
    }
    case "Begin": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = finish(n, { type: "Begin", "exprs": v0 });
      }
      break;
    }
    case "Let": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Let", "bindings": v0, "body": v1 });
      }
      break;
    }
    case "Letrec": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Letrec", "bindings": v0, "body": v1 });
      }
      break;
    }
    case "Lam": {
      {
        const v0 = n.params.map(walk_Param);
        const v1 = walk_Expr(n.body);
        out = finish(n, { type: "Lam", "params": v0, "body": v1 });
      }
      break;
    }
    case "Call": {
      {
        const v0 = walk_Expr(n.fn);
        const v1 = n.args.map(walk_Expr);
        out = finish(n, { type: "Call", "fn": v0, "args": v1 });
      }
      break;
    }
    case "Prim": {
      {
        const v0 = n.args.map(walk_Expr);
        out = finish(n, { type: "Prim", "op": n.op, "args": v0 });
      }
      break;
    }
    default:
      throw new Error("[L5] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "IfAlt": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x);
      return r;
    });
  }

  return { run, rec, arity: 0 };
}

return build;
})();

const PW7 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L6 -> L6
function build(handlers, init) {
  const LANG = "L6";

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
          "[L6] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x) {
    if (Array.isArray(x)) return x.map(rec);
    if (x === null || x === undefined) return x;
    const w = BY_TAG[x.type];
    if (w === undefined) {
      throw new Error(
        "[L6] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x);
  }

  function walk_Program(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
        const v0 = n.defs.map(walk_Def);
        const v1 = n.body.map(walk_Expr);
        out = (!sameList(v0, n.defs) || !sameList(v1, n.body)) ? finish(n, { type: "Prog", "defs": v0, "body": v1 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
        const v0 = walk_Expr(n.value);
        out = (v0 !== n.value) ? finish(n, { type: "DefVal", "name": n.name, "value": v0 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      out = n;
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
        const v0 = walk_Expr(n.test);
        const v1 = walk_Expr(n.body);
        out = (v0 !== n.test || v1 !== n.body) ? finish(n, { type: "Clause", "test": v0, "body": v1 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
        const v0 = walk_Expr(n.value);
        out = (v0 !== n.value) ? finish(n, { type: "Bind", "name": n.name, "value": v0 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      out = n;
      break;
    }
    case "Int": {
      out = n;
      break;
    }
    case "Float": {
      out = n;
      break;
    }
    case "Bool": {
      out = n;
      break;
    }
    case "Str": {
      out = n;
      break;
    }
    case "Var": {
      out = n;
      break;
    }
    case "If": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.then);
        const v2 = walk_Expr(n.alt);
        out = (v0 !== n.cond || v1 !== n.then || v2 !== n.alt) ? finish(n, { type: "If", "cond": v0, "then": v1, "alt": v2 }) : n;
      }
      break;
    }
    case "Begin": {
      out = finish(n, handlers["Expr"]["Begin"](n, rec));
      break;
    }
    case "Let": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = (!sameList(v0, n.bindings) || v1 !== n.body) ? finish(n, { type: "Let", "bindings": v0, "body": v1 }) : n;
      }
      break;
    }
    case "Letrec": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = (!sameList(v0, n.bindings) || v1 !== n.body) ? finish(n, { type: "Letrec", "bindings": v0, "body": v1 }) : n;
      }
      break;
    }
    case "Lam": {
      {
        const v0 = n.params.map(walk_Param);
        const v1 = walk_Expr(n.body);
        out = (!sameList(v0, n.params) || v1 !== n.body) ? finish(n, { type: "Lam", "params": v0, "body": v1 }) : n;
      }
      break;
    }
    case "Call": {
      {
        const v0 = walk_Expr(n.fn);
        const v1 = n.args.map(walk_Expr);
        out = (v0 !== n.fn || !sameList(v1, n.args)) ? finish(n, { type: "Call", "fn": v0, "args": v1 }) : n;
      }
      break;
    }
    case "Prim": {
      {
        const v0 = n.args.map(walk_Expr);
        out = (!sameList(v0, n.args)) ? finish(n, { type: "Prim", "op": n.op, "args": v0 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x);
      return r;
    });
  }

  return { run, rec, arity: 0 };
}

return build;
})();

const PW8 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L6 -> L6   （extra 1 个值，线程）
function build(handlers, init) {
  const LANG = "L6";

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
          "[L6] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x, ...c) {
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
        "[L6] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x, ...c);
  }

  function walk_Program(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.defs) {
        const t1 = walk_Def(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const o3 = [];
      for (const y5 of n.body) {
        const t4 = walk_Expr(y5, c0);
        c0 = t4[1];
        if (t4[0] !== y5) changed = true;
        o3.push(t4[0]);
      }
      out = [changed ? finish(n, { type: "Prog", "defs": o0, "body": o3 }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [changed ? finish(n, { type: "DefVal", "name": n.name, "value": t0[0] }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Param", "name": n.name }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
      let changed = false;
      const t0 = walk_Expr(n.test, c0);
      c0 = t0[1];
      if (t0[0] !== n.test) changed = true;
      const t1 = walk_Expr(n.body, c0);
      c0 = t1[1];
      if (t1[0] !== n.body) changed = true;
      out = [changed ? finish(n, { type: "Clause", "test": t0[0], "body": t1[0] }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [changed ? finish(n, { type: "Bind", "name": n.name, "value": t0[0] }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Void" }) : n, c0];
      }
      break;
    }
    case "Int": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Int", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Float": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Float", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Bool": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Bool", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Str": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Str", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Var": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Var", "name": n.name }) : n, c0];
      }
      break;
    }
    case "If": {
      {
      let changed = false;
      const t0 = walk_Expr(n.cond, c0);
      c0 = t0[1];
      if (t0[0] !== n.cond) changed = true;
      const t1 = walk_Expr(n.then, c0);
      c0 = t1[1];
      if (t1[0] !== n.then) changed = true;
      const t2 = walk_Expr(n.alt, c0);
      c0 = t2[1];
      if (t2[0] !== n.alt) changed = true;
      out = [changed ? finish(n, { type: "If", "cond": t0[0], "then": t1[0], "alt": t2[0] }) : n, c0];
      }
      break;
    }
    case "Begin": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.exprs) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [changed ? finish(n, { type: "Begin", "exprs": o0 }) : n, c0];
      }
      break;
    }
    case "Let": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.bindings) {
        const t1 = walk_Bind(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const t3 = walk_Expr(n.body, c0);
      c0 = t3[1];
      if (t3[0] !== n.body) changed = true;
      out = [changed ? finish(n, { type: "Let", "bindings": o0, "body": t3[0] }) : n, c0];
      }
      break;
    }
    case "Letrec": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.bindings) {
        const t1 = walk_Bind(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const t3 = walk_Expr(n.body, c0);
      c0 = t3[1];
      if (t3[0] !== n.body) changed = true;
      out = [changed ? finish(n, { type: "Letrec", "bindings": o0, "body": t3[0] }) : n, c0];
      }
      break;
    }
    case "Lam": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.params) {
        const t1 = walk_Param(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const t3 = walk_Expr(n.body, c0);
      c0 = t3[1];
      if (t3[0] !== n.body) changed = true;
      out = [changed ? finish(n, { type: "Lam", "params": o0, "body": t3[0] }) : n, c0];
      }
      break;
    }
    case "Call": {
      {
      let changed = false;
      const t0 = walk_Expr(n.fn, c0);
      c0 = t0[1];
      if (t0[0] !== n.fn) changed = true;
      const o1 = [];
      for (const y3 of n.args) {
        const t2 = walk_Expr(y3, c0);
        c0 = t2[1];
        if (t2[0] !== y3) changed = true;
        o1.push(t2[0]);
      }
      out = [changed ? finish(n, { type: "Call", "fn": t0[0], "args": o1 }) : n, c0];
      }
      break;
    }
    case "Prim": {
      {
        const t = handlers["Expr"]["Prim"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x, ...init());
      return r[0];
    });
  }

  return { run, rec, arity: 1 };
}

return build;
})();

const PW9 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L6 -> L6
function build(handlers, init) {
  const LANG = "L6";

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
          "[L6] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x) {
    if (Array.isArray(x)) return x.map(rec);
    if (x === null || x === undefined) return x;
    const w = BY_TAG[x.type];
    if (w === undefined) {
      throw new Error(
        "[L6] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x);
  }

  function walk_Program(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
        const v0 = n.defs.map(walk_Def);
        const v1 = n.body.map(walk_Expr);
        out = (!sameList(v0, n.defs) || !sameList(v1, n.body)) ? finish(n, { type: "Prog", "defs": v0, "body": v1 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
        const v0 = walk_Expr(n.value);
        out = (v0 !== n.value) ? finish(n, { type: "DefVal", "name": n.name, "value": v0 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      out = n;
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
        const v0 = walk_Expr(n.test);
        const v1 = walk_Expr(n.body);
        out = (v0 !== n.test || v1 !== n.body) ? finish(n, { type: "Clause", "test": v0, "body": v1 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
        const v0 = walk_Expr(n.value);
        out = (v0 !== n.value) ? finish(n, { type: "Bind", "name": n.name, "value": v0 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      out = n;
      break;
    }
    case "Int": {
      out = n;
      break;
    }
    case "Float": {
      out = n;
      break;
    }
    case "Bool": {
      out = n;
      break;
    }
    case "Str": {
      out = n;
      break;
    }
    case "Var": {
      out = n;
      break;
    }
    case "If": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.then);
        const v2 = walk_Expr(n.alt);
        out = (v0 !== n.cond || v1 !== n.then || v2 !== n.alt) ? finish(n, { type: "If", "cond": v0, "then": v1, "alt": v2 }) : n;
      }
      break;
    }
    case "Begin": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = (!sameList(v0, n.exprs)) ? finish(n, { type: "Begin", "exprs": v0 }) : n;
      }
      break;
    }
    case "Let": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = (!sameList(v0, n.bindings) || v1 !== n.body) ? finish(n, { type: "Let", "bindings": v0, "body": v1 }) : n;
      }
      break;
    }
    case "Letrec": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = (!sameList(v0, n.bindings) || v1 !== n.body) ? finish(n, { type: "Letrec", "bindings": v0, "body": v1 }) : n;
      }
      break;
    }
    case "Lam": {
      {
        const v0 = n.params.map(walk_Param);
        const v1 = walk_Expr(n.body);
        out = (!sameList(v0, n.params) || v1 !== n.body) ? finish(n, { type: "Lam", "params": v0, "body": v1 }) : n;
      }
      break;
    }
    case "Call": {
      {
        const v0 = walk_Expr(n.fn);
        const v1 = n.args.map(walk_Expr);
        out = (v0 !== n.fn || !sameList(v1, n.args)) ? finish(n, { type: "Call", "fn": v0, "args": v1 }) : n;
      }
      break;
    }
    case "Prim": {
      out = finish(n, handlers["Expr"]["Prim"](n, rec));
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x);
      return r;
    });
  }

  return { run, rec, arity: 0 };
}

return build;
})();

const PW10 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L6 -> L6   （extra 1 个值，线程）
function build(handlers, init) {
  const LANG = "L6";

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
          "[L6] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x, ...c) {
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
        "[L6] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x, ...c);
  }

  function walk_Program(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
        const t = handlers["Program"]["Prog"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [changed ? finish(n, { type: "DefVal", "name": n.name, "value": t0[0] }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Param", "name": n.name }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
      let changed = false;
      const t0 = walk_Expr(n.test, c0);
      c0 = t0[1];
      if (t0[0] !== n.test) changed = true;
      const t1 = walk_Expr(n.body, c0);
      c0 = t1[1];
      if (t1[0] !== n.body) changed = true;
      out = [changed ? finish(n, { type: "Clause", "test": t0[0], "body": t1[0] }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [changed ? finish(n, { type: "Bind", "name": n.name, "value": t0[0] }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Void" }) : n, c0];
      }
      break;
    }
    case "Int": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Int", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Float": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Float", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Bool": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Bool", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Str": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Str", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Var": {
      {
        const t = handlers["Expr"]["Var"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "If": {
      {
      let changed = false;
      const t0 = walk_Expr(n.cond, c0);
      c0 = t0[1];
      if (t0[0] !== n.cond) changed = true;
      const t1 = walk_Expr(n.then, c0);
      c0 = t1[1];
      if (t1[0] !== n.then) changed = true;
      const t2 = walk_Expr(n.alt, c0);
      c0 = t2[1];
      if (t2[0] !== n.alt) changed = true;
      out = [changed ? finish(n, { type: "If", "cond": t0[0], "then": t1[0], "alt": t2[0] }) : n, c0];
      }
      break;
    }
    case "Begin": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.exprs) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [changed ? finish(n, { type: "Begin", "exprs": o0 }) : n, c0];
      }
      break;
    }
    case "Let": {
      {
        const t = handlers["Expr"]["Let"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Letrec": {
      {
        const t = handlers["Expr"]["Letrec"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Lam": {
      {
        const t = handlers["Expr"]["Lam"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Call": {
      {
      let changed = false;
      const t0 = walk_Expr(n.fn, c0);
      c0 = t0[1];
      if (t0[0] !== n.fn) changed = true;
      const o1 = [];
      for (const y3 of n.args) {
        const t2 = walk_Expr(y3, c0);
        c0 = t2[1];
        if (t2[0] !== y3) changed = true;
        o1.push(t2[0]);
      }
      out = [changed ? finish(n, { type: "Call", "fn": t0[0], "args": o1 }) : n, c0];
      }
      break;
    }
    case "Prim": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.args) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [changed ? finish(n, { type: "Prim", "op": n.op, "args": o0 }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x, ...init());
      return r[0];
    });
  }

  return { run, rec, arity: 1 };
}

return build;
})();

const PW11 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L6 -> L6   （extra 1 个值，线程）
function build(handlers, init) {
  const LANG = "L6";

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
          "[L6] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x, ...c) {
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
        "[L6] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x, ...c);
  }

  function walk_Program(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
        const t = handlers["Program"]["Prog"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [changed ? finish(n, { type: "DefVal", "name": n.name, "value": t0[0] }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Param", "name": n.name }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
      let changed = false;
      const t0 = walk_Expr(n.test, c0);
      c0 = t0[1];
      if (t0[0] !== n.test) changed = true;
      const t1 = walk_Expr(n.body, c0);
      c0 = t1[1];
      if (t1[0] !== n.body) changed = true;
      out = [changed ? finish(n, { type: "Clause", "test": t0[0], "body": t1[0] }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [changed ? finish(n, { type: "Bind", "name": n.name, "value": t0[0] }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Void" }) : n, c0];
      }
      break;
    }
    case "Int": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Int", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Float": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Float", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Bool": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Bool", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Str": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Str", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Var": {
      {
        const t = handlers["Expr"]["Var"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "If": {
      {
      let changed = false;
      const t0 = walk_Expr(n.cond, c0);
      c0 = t0[1];
      if (t0[0] !== n.cond) changed = true;
      const t1 = walk_Expr(n.then, c0);
      c0 = t1[1];
      if (t1[0] !== n.then) changed = true;
      const t2 = walk_Expr(n.alt, c0);
      c0 = t2[1];
      if (t2[0] !== n.alt) changed = true;
      out = [changed ? finish(n, { type: "If", "cond": t0[0], "then": t1[0], "alt": t2[0] }) : n, c0];
      }
      break;
    }
    case "Begin": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.exprs) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [changed ? finish(n, { type: "Begin", "exprs": o0 }) : n, c0];
      }
      break;
    }
    case "Let": {
      {
        const t = handlers["Expr"]["Let"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Letrec": {
      {
        const t = handlers["Expr"]["Letrec"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Lam": {
      {
        const t = handlers["Expr"]["Lam"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Call": {
      {
      let changed = false;
      const t0 = walk_Expr(n.fn, c0);
      c0 = t0[1];
      if (t0[0] !== n.fn) changed = true;
      const o1 = [];
      for (const y3 of n.args) {
        const t2 = walk_Expr(y3, c0);
        c0 = t2[1];
        if (t2[0] !== y3) changed = true;
        o1.push(t2[0]);
      }
      out = [changed ? finish(n, { type: "Call", "fn": t0[0], "args": o1 }) : n, c0];
      }
      break;
    }
    case "Prim": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.args) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [changed ? finish(n, { type: "Prim", "op": n.op, "args": o0 }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x, ...init());
      return r[0];
    });
  }

  return { run, rec, arity: 1 };
}

return build;
})();

const PW12 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L6 -> L6
function build(handlers, init) {
  const LANG = "L6";

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
          "[L6] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x) {
    if (Array.isArray(x)) return x.map(rec);
    if (x === null || x === undefined) return x;
    const w = BY_TAG[x.type];
    if (w === undefined) {
      throw new Error(
        "[L6] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x);
  }

  function walk_Program(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
        const v0 = n.defs.map(walk_Def);
        const v1 = n.body.map(walk_Expr);
        out = (!sameList(v0, n.defs) || !sameList(v1, n.body)) ? finish(n, { type: "Prog", "defs": v0, "body": v1 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
        const v0 = walk_Expr(n.value);
        out = (v0 !== n.value) ? finish(n, { type: "DefVal", "name": n.name, "value": v0 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      out = n;
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
        const v0 = walk_Expr(n.test);
        const v1 = walk_Expr(n.body);
        out = (v0 !== n.test || v1 !== n.body) ? finish(n, { type: "Clause", "test": v0, "body": v1 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
        const v0 = walk_Expr(n.value);
        out = (v0 !== n.value) ? finish(n, { type: "Bind", "name": n.name, "value": v0 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      out = n;
      break;
    }
    case "Int": {
      out = n;
      break;
    }
    case "Float": {
      out = n;
      break;
    }
    case "Bool": {
      out = n;
      break;
    }
    case "Str": {
      out = n;
      break;
    }
    case "Var": {
      out = n;
      break;
    }
    case "If": {
      out = finish(n, handlers["Expr"]["If"](n, rec));
      break;
    }
    case "Begin": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = (!sameList(v0, n.exprs)) ? finish(n, { type: "Begin", "exprs": v0 }) : n;
      }
      break;
    }
    case "Let": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = (!sameList(v0, n.bindings) || v1 !== n.body) ? finish(n, { type: "Let", "bindings": v0, "body": v1 }) : n;
      }
      break;
    }
    case "Letrec": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = (!sameList(v0, n.bindings) || v1 !== n.body) ? finish(n, { type: "Letrec", "bindings": v0, "body": v1 }) : n;
      }
      break;
    }
    case "Lam": {
      {
        const v0 = n.params.map(walk_Param);
        const v1 = walk_Expr(n.body);
        out = (!sameList(v0, n.params) || v1 !== n.body) ? finish(n, { type: "Lam", "params": v0, "body": v1 }) : n;
      }
      break;
    }
    case "Call": {
      {
        const v0 = walk_Expr(n.fn);
        const v1 = n.args.map(walk_Expr);
        out = (v0 !== n.fn || !sameList(v1, n.args)) ? finish(n, { type: "Call", "fn": v0, "args": v1 }) : n;
      }
      break;
    }
    case "Prim": {
      out = finish(n, handlers["Expr"]["Prim"](n, rec));
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x);
      return r;
    });
  }

  return { run, rec, arity: 0 };
}

return build;
})();

const PW13 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L6 -> L7   （extra 1 个值，线程）
function build(handlers, init) {
  const LANG = "L7";

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
          "[L6] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x, ...c) {
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
        "[L6] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x, ...c);
  }

  function walk_Program(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.defs) {
        const t1 = walk_Def(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const o3 = [];
      for (const y5 of n.body) {
        const t4 = walk_Expr(y5, c0);
        c0 = t4[1];
        if (t4[0] !== y5) changed = true;
        o3.push(t4[0]);
      }
      out = [finish(n, { type: "Prog", "defs": o0, "body": o3 }), c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [finish(n, { type: "DefVal", "name": n.name, "value": t0[0] }), c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      {
      let changed = false;
      out = [finish(n, { type: "Param", "name": n.name }), c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
      let changed = false;
      const t0 = walk_Expr(n.test, c0);
      c0 = t0[1];
      if (t0[0] !== n.test) changed = true;
      const t1 = walk_Expr(n.body, c0);
      c0 = t1[1];
      if (t1[0] !== n.body) changed = true;
      out = [finish(n, { type: "Clause", "test": t0[0], "body": t1[0] }), c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [finish(n, { type: "Bind", "name": n.name, "value": t0[0] }), c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      {
      let changed = false;
      out = [finish(n, { type: "Void" }), c0];
      }
      break;
    }
    case "Int": {
      {
      let changed = false;
      out = [finish(n, { type: "Int", "value": n.value }), c0];
      }
      break;
    }
    case "Float": {
      {
      let changed = false;
      out = [finish(n, { type: "Float", "value": n.value }), c0];
      }
      break;
    }
    case "Bool": {
      {
      let changed = false;
      out = [finish(n, { type: "Bool", "value": n.value }), c0];
      }
      break;
    }
    case "Str": {
      {
      let changed = false;
      out = [finish(n, { type: "Str", "value": n.value }), c0];
      }
      break;
    }
    case "Var": {
      {
        const t = handlers["Expr"]["Var"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "If": {
      {
      let changed = false;
      const t0 = walk_Expr(n.cond, c0);
      c0 = t0[1];
      if (t0[0] !== n.cond) changed = true;
      const t1 = walk_Expr(n.then, c0);
      c0 = t1[1];
      if (t1[0] !== n.then) changed = true;
      const t2 = walk_Expr(n.alt, c0);
      c0 = t2[1];
      if (t2[0] !== n.alt) changed = true;
      out = [finish(n, { type: "If", "cond": t0[0], "then": t1[0], "alt": t2[0] }), c0];
      }
      break;
    }
    case "Begin": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.exprs) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [finish(n, { type: "Begin", "exprs": o0 }), c0];
      }
      break;
    }
    case "Let": {
      {
        const t = handlers["Expr"]["Let"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Letrec": {
      {
        const t = handlers["Expr"]["Letrec"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Lam": {
      {
        const t = handlers["Expr"]["Lam"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Call": {
      {
      let changed = false;
      const t0 = walk_Expr(n.fn, c0);
      c0 = t0[1];
      if (t0[0] !== n.fn) changed = true;
      const o1 = [];
      for (const y3 of n.args) {
        const t2 = walk_Expr(y3, c0);
        c0 = t2[1];
        if (t2[0] !== y3) changed = true;
        o1.push(t2[0]);
      }
      out = [finish(n, { type: "Call", "fn": t0[0], "args": o1 }), c0];
      }
      break;
    }
    case "Prim": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.args) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [finish(n, { type: "Prim", "op": n.op, "args": o0 }), c0];
      }
      break;
    }
    default:
      throw new Error("[L6] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x, ...init());
      return r[0];
    });
  }

  return { run, rec, arity: 1 };
}

return build;
})();

const PW14 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L7 -> L7   （extra 1 个值，线程）
function build(handlers, init) {
  const LANG = "L7";

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
          "[L7] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x, ...c) {
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
        "[L7] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x, ...c);
  }

  function walk_Program(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.defs) {
        const t1 = walk_Def(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      const o3 = [];
      for (const y5 of n.body) {
        const t4 = walk_Expr(y5, c0);
        c0 = t4[1];
        if (t4[0] !== y5) changed = true;
        o3.push(t4[0]);
      }
      out = [changed ? finish(n, { type: "Prog", "defs": o0, "body": o3 }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [changed ? finish(n, { type: "DefVal", "name": n.name, "value": t0[0] }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Param", "name": n.name }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
      let changed = false;
      const t0 = walk_Expr(n.test, c0);
      c0 = t0[1];
      if (t0[0] !== n.test) changed = true;
      const t1 = walk_Expr(n.body, c0);
      c0 = t1[1];
      if (t1[0] !== n.body) changed = true;
      out = [changed ? finish(n, { type: "Clause", "test": t0[0], "body": t1[0] }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
      let changed = false;
      const t0 = walk_Expr(n.value, c0);
      c0 = t0[1];
      if (t0[0] !== n.value) changed = true;
      out = [changed ? finish(n, { type: "Bind", "name": n.name, "value": t0[0] }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Void" }) : n, c0];
      }
      break;
    }
    case "Int": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Int", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Float": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Float", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Bool": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Bool", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Str": {
      {
      let changed = false;
      out = [changed ? finish(n, { type: "Str", "value": n.value }) : n, c0];
      }
      break;
    }
    case "Var": {
      {
        const t = handlers["Expr"]["Var"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "If": {
      {
      let changed = false;
      const t0 = walk_Expr(n.cond, c0);
      c0 = t0[1];
      if (t0[0] !== n.cond) changed = true;
      const t1 = walk_Expr(n.then, c0);
      c0 = t1[1];
      if (t1[0] !== n.then) changed = true;
      const t2 = walk_Expr(n.alt, c0);
      c0 = t2[1];
      if (t2[0] !== n.alt) changed = true;
      out = [changed ? finish(n, { type: "If", "cond": t0[0], "then": t1[0], "alt": t2[0] }) : n, c0];
      }
      break;
    }
    case "Begin": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.exprs) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [changed ? finish(n, { type: "Begin", "exprs": o0 }) : n, c0];
      }
      break;
    }
    case "Let": {
      {
        const t = handlers["Expr"]["Let"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Letrec": {
      {
        const t = handlers["Expr"]["Letrec"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Lam": {
      {
        const t = handlers["Expr"]["Lam"](n, rec, c0);
        out = [finish(n, t[0]), t[1]];
      }
      break;
    }
    case "Call": {
      {
      let changed = false;
      const t0 = walk_Expr(n.fn, c0);
      c0 = t0[1];
      if (t0[0] !== n.fn) changed = true;
      const o1 = [];
      for (const y3 of n.args) {
        const t2 = walk_Expr(y3, c0);
        c0 = t2[1];
        if (t2[0] !== y3) changed = true;
        o1.push(t2[0]);
      }
      out = [changed ? finish(n, { type: "Call", "fn": t0[0], "args": o1 }) : n, c0];
      }
      break;
    }
    case "Prim": {
      {
      let changed = false;
      const o0 = [];
      for (const y2 of n.args) {
        const t1 = walk_Expr(y2, c0);
        c0 = t1[1];
        if (t1[0] !== y2) changed = true;
        o0.push(t1[0]);
      }
      out = [changed ? finish(n, { type: "Prim", "op": n.op, "args": o0 }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Body(n, c0) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "BindFree": {
      {
      let changed = false;
      const t0 = walk_Expr(n.body, c0);
      c0 = t0[1];
      if (t0[0] !== n.body) changed = true;
      out = [changed ? finish(n, { type: "BindFree", "names": n.names, "body": t0[0] }) : n, c0];
      }
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Body 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
    "BindFree": walk_Body,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x, ...init());
      return r[0];
    });
  }

  return { run, rec, arity: 1 };
}

return build;
})();

const PW15 = (function () {
// 由 codegen 生成，不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L7 -> L7
function build(handlers, init) {
  const LANG = "L7";

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
          "[L7] 输入嵌套太深：" +
            whereOf(deepest) +
            "（走到 " + maxDepth + " 层就溢出了）。\n" +
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

  function rec(x) {
    if (Array.isArray(x)) return x.map(rec);
    if (x === null || x === undefined) return x;
    const w = BY_TAG[x.type];
    if (w === undefined) {
      throw new Error(
        "[L7] rec() 遇到不认识的产生式 " + x.type + "（__lang__=" + x.__lang__ + "，" + whereOf(x) + "）",
      );
    }
    return w(x);
  }

  function walk_Program(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      out = finish(n, handlers["Program"]["Prog"](n, rec));
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Program 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Def(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      {
        const v0 = walk_Expr(n.value);
        out = (v0 !== n.value) ? finish(n, { type: "DefVal", "name": n.name, "value": v0 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Def 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Param(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      out = n;
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Param 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Clause(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      {
        const v0 = walk_Expr(n.test);
        const v1 = walk_Expr(n.body);
        out = (v0 !== n.test || v1 !== n.body) ? finish(n, { type: "Clause", "test": v0, "body": v1 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Clause 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Bind(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      {
        const v0 = walk_Expr(n.value);
        out = (v0 !== n.value) ? finish(n, { type: "Bind", "name": n.name, "value": v0 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Bind 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Expr(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      out = n;
      break;
    }
    case "Int": {
      out = n;
      break;
    }
    case "Float": {
      out = n;
      break;
    }
    case "Bool": {
      out = n;
      break;
    }
    case "Str": {
      out = n;
      break;
    }
    case "Var": {
      out = n;
      break;
    }
    case "If": {
      {
        const v0 = walk_Expr(n.cond);
        const v1 = walk_Expr(n.then);
        const v2 = walk_Expr(n.alt);
        out = (v0 !== n.cond || v1 !== n.then || v2 !== n.alt) ? finish(n, { type: "If", "cond": v0, "then": v1, "alt": v2 }) : n;
      }
      break;
    }
    case "Begin": {
      {
        const v0 = n.exprs.map(walk_Expr);
        out = (!sameList(v0, n.exprs)) ? finish(n, { type: "Begin", "exprs": v0 }) : n;
      }
      break;
    }
    case "Let": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = (!sameList(v0, n.bindings) || v1 !== n.body) ? finish(n, { type: "Let", "bindings": v0, "body": v1 }) : n;
      }
      break;
    }
    case "Letrec": {
      {
        const v0 = n.bindings.map(walk_Bind);
        const v1 = walk_Expr(n.body);
        out = (!sameList(v0, n.bindings) || v1 !== n.body) ? finish(n, { type: "Letrec", "bindings": v0, "body": v1 }) : n;
      }
      break;
    }
    case "Lam": {
      {
        const v0 = n.params.map(walk_Param);
        const v1 = walk_Body(n.body);
        out = (!sameList(v0, n.params) || v1 !== n.body) ? finish(n, { type: "Lam", "params": v0, "body": v1 }) : n;
      }
      break;
    }
    case "Call": {
      {
        const v0 = walk_Expr(n.fn);
        const v1 = n.args.map(walk_Expr);
        out = (v0 !== n.fn || !sameList(v1, n.args)) ? finish(n, { type: "Call", "fn": v0, "args": v1 }) : n;
      }
      break;
    }
    case "Prim": {
      {
        const v0 = n.args.map(walk_Expr);
        out = (!sameList(v0, n.args)) ? finish(n, { type: "Prim", "op": n.op, "args": v0 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Expr 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  function walk_Body(n) {
    let out;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "BindFree": {
      {
        const v0 = walk_Expr(n.body);
        out = (v0 !== n.body) ? finish(n, { type: "BindFree", "names": n.names, "body": v0 }) : n;
      }
      break;
    }
    default:
      throw new Error("[L7] 非终结符 Body 里没有产生式 " + n.type + "（节点带 __lang__=" + n.__lang__ + "，" + whereOf(n) + "）");
    }
    depth--;
    return out;
  }

  /** 列表逐元素比引用 —— "没改就复用"要用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const BY_TAG = {
    "Prog": walk_Program,
    "DefVal": walk_Def,
    "Param": walk_Param,
    "Clause": walk_Clause,
    "Bind": walk_Bind,
    "Void": walk_Expr,
    "Int": walk_Expr,
    "Float": walk_Expr,
    "Bool": walk_Expr,
    "Str": walk_Expr,
    "Var": walk_Expr,
    "If": walk_Expr,
    "Begin": walk_Expr,
    "Let": walk_Expr,
    "Letrec": walk_Expr,
    "Lam": walk_Expr,
    "Call": walk_Expr,
    "Prim": walk_Expr,
    "BindFree": walk_Body,
  };

  // extra 是这个 pass **内部**的通信（对应 nanopass 里 processor 的额外返回值），
  // 所以 run 只把节点交出去 —— 拿初值开跑，extra 丢掉。
  function run(x) {
    depth = 0;
    maxDepth = 0;
    deepest = null;
    return guard(() => {
      const r = walk_Program(x);
      return r;
    });
  }

  return { run, rec, arity: 0 };
}

return build;
})();

const GT0 = (function () {
// 由 codegen 生成（融合 + 蹦床）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   Lnum → Lsrc   （1 门融成 1 个遍历）
//
// 这里是**显式帧栈 + dispatch 循环**，不是递归下树：identity 那条路上一个 JS 栈帧都不占。
// handler 里的 rec 也接到同一个蹦床上（会开一层嵌套的 drive），所以子树遍历也是迭代的。
// 唯一还会占原生栈的是「handler 里调 rec、子节点又有 handler」这种嵌套 —— 层数等于
// 路径上带 handler 的节点数（见 t18 的注释）。
function build(handlersList, init) {
  // 一个组的结果属于**最后一门** pass 的输出语言 —— 不是第一门的
  const LANG = "Lsrc";
  /** 列表逐元素比引用 —— "没改就复用"用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = 1;
  const idRec = (x) => x;

  const TAG_NT = {
    "Prog": "Program",
    "DefFun": "Def",
    "DefVal": "Def",
    "Param": "Param",
    "Clause": "Clause",
    "Bind": "Bind",
    "Void": "Expr",
    "Bool": "Expr",
    "Str": "Expr",
    "Var": "Expr",
    "If": "Expr",
    "IfAlt": "Expr",
    "When": "Expr",
    "Unless": "Expr",
    "Cond": "Expr",
    "And": "Expr",
    "Or": "Expr",
    "Not": "Expr",
    "Begin": "Expr",
    "Let": "Expr",
    "LetStar": "Expr",
    "Letrec": "Expr",
    "Lam": "Expr",
    "Call": "Expr",
    "Prim": "Expr",
    "Num": "Expr",
  };

  // tag → 子节点字段表（按声明顺序）。kind: n 单节点 / l 列表 / m 可选
  const FIELDS = {
    "Prog": [["defs","l"],["body","l"]],
    "DefFun": [["params","l"],["body","n"]],
    "DefVal": [["value","n"]],
    "Param": [],
    "Clause": [["test","n"],["body","n"]],
    "Bind": [["value","n"]],
    "Void": [],
    "Bool": [],
    "Str": [],
    "Var": [],
    "If": [["cond","n"],["then","n"],["alt","n"]],
    "IfAlt": [["cond","n"],["then","n"]],
    "When": [["cond","n"],["body","n"]],
    "Unless": [["cond","n"],["body","n"]],
    "Cond": [["clauses","l"],["else","m"]],
    "And": [["exprs","l"]],
    "Or": [["exprs","l"]],
    "Not": [["expr","n"]],
    "Begin": [["exprs","l"]],
    "Let": [["bindings","l"],["body","n"]],
    "LetStar": [["bindings","l"],["body","n"]],
    "Letrec": [["bindings","l"],["body","n"]],
    "Lam": [["params","l"],["body","n"]],
    "Call": [["fn","n"],["args","l"]],
    "Prim": [["args","l"]],
    "Num": [],
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
    case "Prog":
      return { type: "Prog", "defs": fr.r0, "body": fr.r1 };
    case "DefFun":
      return { type: "DefFun", "name": n.name, "params": fr.r0, "body": fr.r1 };
    case "DefVal":
      return { type: "DefVal", "name": n.name, "value": fr.r0 };
    case "Param":
      return { type: "Param", "name": n.name };
    case "Clause":
      return { type: "Clause", "test": fr.r0, "body": fr.r1 };
    case "Bind":
      return { type: "Bind", "name": n.name, "value": fr.r0 };
    case "Void":
      return { type: "Void" };
    case "Bool":
      return { type: "Bool", "value": n.value };
    case "Str":
      return { type: "Str", "value": n.value };
    case "Var":
      return { type: "Var", "name": n.name };
    case "If":
      return { type: "If", "cond": fr.r0, "then": fr.r1, "alt": fr.r2 };
    case "IfAlt":
      return { type: "IfAlt", "cond": fr.r0, "then": fr.r1 };
    case "When":
      return { type: "When", "cond": fr.r0, "body": fr.r1 };
    case "Unless":
      return { type: "Unless", "cond": fr.r0, "body": fr.r1 };
    case "Cond":
      return { type: "Cond", "clauses": fr.r0, "else": fr.r1 };
    case "And":
      return { type: "And", "exprs": fr.r0 };
    case "Or":
      return { type: "Or", "exprs": fr.r0 };
    case "Not":
      return { type: "Not", "expr": fr.r0 };
    case "Begin":
      return { type: "Begin", "exprs": fr.r0 };
    case "Let":
      return { type: "Let", "bindings": fr.r0, "body": fr.r1 };
    case "LetStar":
      return { type: "LetStar", "bindings": fr.r0, "body": fr.r1 };
    case "Letrec":
      return { type: "Letrec", "bindings": fr.r0, "body": fr.r1 };
    case "Lam":
      return { type: "Lam", "params": fr.r0, "body": fr.r1 };
    case "Call":
      return { type: "Call", "fn": fr.r0, "args": fr.r1 };
    case "Prim":
      return { type: "Prim", "op": n.op, "args": fr.r0 };
    case "Num":
      return { type: "Num", "value": n.value, "repr": n.repr };
    default:
      throw new Error("[fuse Lnum] 没有产生式 " + tag + " 的构造子");
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
      case 0: fr.r0 = v; return;
      case 1: fr.r1 = v; return;
      case 2: fr.r2 = v; return;
      default:
        throw new Error("[fuse Lnum] 槽位越界 " + i);
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
            "[fuse Lnum] 不认识的产生式 " + node.type +
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
          r0: undefined, r1: undefined, r2: undefined,
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
          "[fuse Lnum] 输入嵌套太深：" + whereOf(lastNode) +
            "。\n  融合遍历器的 identity 那条路不占原生栈，但 handler 里调 rec、子节点又有 handler 时会嵌套 —— 层数等于路径上带 handler 的节点数（t18 / t27）。",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  return { run, arity: K };
}

return build;
})();

const GR1 = (function () {
// 由 codegen 生成（融合）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   Lsrc → L1 → L2   （3 门融成 1 个遍历）
function build(handlersList, init) {
  const LANG = "L1";
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
        const err = new Error("[fuse Lsrc] 输入嵌套太深：" + whereOf(deepest) + "（走到 " + maxDepth + " 层就溢出了）。");
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
      throw new Error("[fuse Lsrc] rec() 遇到不认识的产生式 " + x.type + "（" + whereOf(x) + "）");
    }
    return w(x);
  }

  function sh_1_Program(v) {
    let out;
    switch (v.type) {
    case "Prog": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L1 的非终结符 Program 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_1_Def(v) {
    let out;
    switch (v.type) {
    case "DefVal": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L1 的非终结符 Def 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_1_Param(v) {
    let out;
    switch (v.type) {
    case "Param": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L1 的非终结符 Param 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_1_Clause(v) {
    let out;
    switch (v.type) {
    case "Clause": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L1 的非终结符 Clause 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_1_Bind(v) {
    let out;
    switch (v.type) {
    case "Bind": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L1 的非终结符 Bind 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_1_Expr(v) {
    let out;
    switch (v.type) {
    case "Void": {
      out = v;
      break;
    }
    case "Int": {
      out = v;
      break;
    }
    case "Float": {
      out = v;
      break;
    }
    case "Bool": {
      out = v;
      break;
    }
    case "Str": {
      out = v;
      break;
    }
    case "Var": {
      out = v;
      break;
    }
    case "If": {
      out = v;
      break;
    }
    case "IfAlt": {
      out = v;
      break;
    }
    case "When": {
      out = finish(v, handlersList[1]["Expr"]["When"](v, idRec));
      break;
    }
    case "Unless": {
      out = finish(v, handlersList[1]["Expr"]["Unless"](v, idRec));
      break;
    }
    case "Cond": {
      out = v;
      break;
    }
    case "And": {
      out = v;
      break;
    }
    case "Or": {
      out = v;
      break;
    }
    case "Not": {
      out = v;
      break;
    }
    case "Begin": {
      out = v;
      break;
    }
    case "Let": {
      out = v;
      break;
    }
    case "LetStar": {
      out = v;
      break;
    }
    case "Letrec": {
      out = v;
      break;
    }
    case "Lam": {
      out = v;
      break;
    }
    case "Call": {
      out = v;
      break;
    }
    case "Prim": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L1 的非终结符 Expr 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_2_Program(v) {
    let out;
    switch (v.type) {
    case "Prog": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L2 的非终结符 Program 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_2_Def(v) {
    let out;
    switch (v.type) {
    case "DefVal": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L2 的非终结符 Def 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_2_Param(v) {
    let out;
    switch (v.type) {
    case "Param": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L2 的非终结符 Param 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_2_Clause(v) {
    let out;
    switch (v.type) {
    case "Clause": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L2 的非终结符 Clause 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_2_Bind(v) {
    let out;
    switch (v.type) {
    case "Bind": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L2 的非终结符 Bind 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_2_Expr(v) {
    let out;
    switch (v.type) {
    case "Void": {
      out = v;
      break;
    }
    case "Int": {
      out = v;
      break;
    }
    case "Float": {
      out = v;
      break;
    }
    case "Bool": {
      out = v;
      break;
    }
    case "Str": {
      out = v;
      break;
    }
    case "Var": {
      out = v;
      break;
    }
    case "If": {
      out = v;
      break;
    }
    case "IfAlt": {
      out = v;
      break;
    }
    case "Cond": {
      out = finish(v, handlersList[2]["Expr"]["Cond"](v, idRec));
      break;
    }
    case "And": {
      out = v;
      break;
    }
    case "Or": {
      out = v;
      break;
    }
    case "Not": {
      out = v;
      break;
    }
    case "Begin": {
      out = v;
      break;
    }
    case "Let": {
      out = v;
      break;
    }
    case "LetStar": {
      out = v;
      break;
    }
    case "Letrec": {
      out = v;
      break;
    }
    case "Lam": {
      out = v;
      break;
    }
    case "Call": {
      out = v;
      break;
    }
    case "Prim": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L2 的非终结符 Expr 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function deep_Program(n) {
    let v;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      v = finish(n, { type: "Prog", "defs": n.defs.map(deep_Def), "body": n.body.map(deep_Expr) });
      break;
    }
    default:
      throw new Error("[fuse Lsrc] 非终结符 Program 里没有产生式 " + n.type + "（" + whereOf(n) + "）");
    }
    depth--;
    v = sh_1_Program(v);
    v = sh_2_Program(v);
    return v;
  }

  function deep_Def(n) {
    let v;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefFun": {
      v = finish(n, handlersList[0]["Def"]["DefFun"](n, deep));
      break;
    }
    case "DefVal": {
      v = finish(n, { type: "DefVal", "name": n.name, "value": deep_Expr(n.value) });
      break;
    }
    default:
      throw new Error("[fuse Lsrc] 非终结符 Def 里没有产生式 " + n.type + "（" + whereOf(n) + "）");
    }
    depth--;
    v = sh_1_Def(v);
    v = sh_2_Def(v);
    return v;
  }

  function deep_Param(n) {
    let v;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      v = finish(n, { type: "Param", "name": n.name });
      break;
    }
    default:
      throw new Error("[fuse Lsrc] 非终结符 Param 里没有产生式 " + n.type + "（" + whereOf(n) + "）");
    }
    depth--;
    v = sh_1_Param(v);
    v = sh_2_Param(v);
    return v;
  }

  function deep_Clause(n) {
    let v;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      v = finish(n, { type: "Clause", "test": deep_Expr(n.test), "body": deep_Expr(n.body) });
      break;
    }
    default:
      throw new Error("[fuse Lsrc] 非终结符 Clause 里没有产生式 " + n.type + "（" + whereOf(n) + "）");
    }
    depth--;
    v = sh_1_Clause(v);
    v = sh_2_Clause(v);
    return v;
  }

  function deep_Bind(n) {
    let v;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      v = finish(n, { type: "Bind", "name": n.name, "value": deep_Expr(n.value) });
      break;
    }
    default:
      throw new Error("[fuse Lsrc] 非终结符 Bind 里没有产生式 " + n.type + "（" + whereOf(n) + "）");
    }
    depth--;
    v = sh_1_Bind(v);
    v = sh_2_Bind(v);
    return v;
  }

  function deep_Expr(n) {
    let v;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      v = finish(n, { type: "Void" });
      break;
    }
    case "Int": {
      v = finish(n, { type: "Int", "value": n.value });
      break;
    }
    case "Float": {
      v = finish(n, { type: "Float", "value": n.value });
      break;
    }
    case "Bool": {
      v = finish(n, { type: "Bool", "value": n.value });
      break;
    }
    case "Str": {
      v = finish(n, { type: "Str", "value": n.value });
      break;
    }
    case "Var": {
      v = finish(n, { type: "Var", "name": n.name });
      break;
    }
    case "If": {
      v = finish(n, { type: "If", "cond": deep_Expr(n.cond), "then": deep_Expr(n.then), "alt": deep_Expr(n.alt) });
      break;
    }
    case "IfAlt": {
      v = finish(n, { type: "IfAlt", "cond": deep_Expr(n.cond), "then": deep_Expr(n.then) });
      break;
    }
    case "When": {
      v = finish(n, { type: "When", "cond": deep_Expr(n.cond), "body": deep_Expr(n.body) });
      break;
    }
    case "Unless": {
      v = finish(n, { type: "Unless", "cond": deep_Expr(n.cond), "body": deep_Expr(n.body) });
      break;
    }
    case "Cond": {
      v = finish(n, { type: "Cond", "clauses": n.clauses.map(deep_Clause), "else": n.else === undefined ? undefined : deep_Expr(n.else) });
      break;
    }
    case "And": {
      v = finish(n, { type: "And", "exprs": n.exprs.map(deep_Expr) });
      break;
    }
    case "Or": {
      v = finish(n, { type: "Or", "exprs": n.exprs.map(deep_Expr) });
      break;
    }
    case "Not": {
      v = finish(n, { type: "Not", "expr": deep_Expr(n.expr) });
      break;
    }
    case "Begin": {
      v = finish(n, { type: "Begin", "exprs": n.exprs.map(deep_Expr) });
      break;
    }
    case "Let": {
      v = finish(n, { type: "Let", "bindings": n.bindings.map(deep_Bind), "body": deep_Expr(n.body) });
      break;
    }
    case "LetStar": {
      v = finish(n, { type: "LetStar", "bindings": n.bindings.map(deep_Bind), "body": deep_Expr(n.body) });
      break;
    }
    case "Letrec": {
      v = finish(n, { type: "Letrec", "bindings": n.bindings.map(deep_Bind), "body": deep_Expr(n.body) });
      break;
    }
    case "Lam": {
      v = finish(n, { type: "Lam", "params": n.params.map(deep_Param), "body": deep_Expr(n.body) });
      break;
    }
    case "Call": {
      v = finish(n, { type: "Call", "fn": deep_Expr(n.fn), "args": n.args.map(deep_Expr) });
      break;
    }
    case "Prim": {
      v = finish(n, { type: "Prim", "op": n.op, "args": n.args.map(deep_Expr) });
      break;
    }
    default:
      throw new Error("[fuse Lsrc] 非终结符 Expr 里没有产生式 " + n.type + "（" + whereOf(n) + "）");
    }
    depth--;
    v = sh_1_Expr(v);
    v = sh_2_Expr(v);
    return v;
  }

  const DEEP = {
    "Prog": deep_Program,
    "DefFun": deep_Def,
    "DefVal": deep_Def,
    "Param": deep_Param,
    "Clause": deep_Clause,
    "Bind": deep_Bind,
    "Void": deep_Expr,
    "Int": deep_Expr,
    "Float": deep_Expr,
    "Bool": deep_Expr,
    "Str": deep_Expr,
    "Var": deep_Expr,
    "If": deep_Expr,
    "IfAlt": deep_Expr,
    "When": deep_Expr,
    "Unless": deep_Expr,
    "Cond": deep_Expr,
    "And": deep_Expr,
    "Or": deep_Expr,
    "Not": deep_Expr,
    "Begin": deep_Expr,
    "Let": deep_Expr,
    "LetStar": deep_Expr,
    "Letrec": deep_Expr,
    "Lam": deep_Expr,
    "Call": deep_Expr,
    "Prim": deep_Expr,
  };

  function run(x) {
    depth = 0; maxDepth = 0; deepest = null;
    return guard(() => deep(x));
  }

  return { run, arity: 0 };
}

return build;
})();
const GT1 = (function () {
// 由 codegen 生成（融合 + 蹦床）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   Lsrc → L1 → L2 → L3   （3 门融成 1 个遍历）
//
// 这里是**显式帧栈 + dispatch 循环**，不是递归下树：identity 那条路上一个 JS 栈帧都不占。
// handler 里的 rec 也接到同一个蹦床上（会开一层嵌套的 drive），所以子树遍历也是迭代的。
// 唯一还会占原生栈的是「handler 里调 rec、子节点又有 handler」这种嵌套 —— 层数等于
// 路径上带 handler 的节点数（见 t18 的注释）。
function build(handlersList, init) {
  // 一个组的结果属于**最后一门** pass 的输出语言 —— 不是第一门的
  const LANG = "L3";
  /** 列表逐元素比引用 —— "没改就复用"用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = 0;
  const idRec = (x) => x;

  const TAG_NT = {
    "Prog": "Program",
    "DefFun": "Def",
    "DefVal": "Def",
    "Param": "Param",
    "Clause": "Clause",
    "Bind": "Bind",
    "Void": "Expr",
    "Int": "Expr",
    "Float": "Expr",
    "Bool": "Expr",
    "Str": "Expr",
    "Var": "Expr",
    "If": "Expr",
    "IfAlt": "Expr",
    "When": "Expr",
    "Unless": "Expr",
    "Cond": "Expr",
    "And": "Expr",
    "Or": "Expr",
    "Not": "Expr",
    "Begin": "Expr",
    "Let": "Expr",
    "LetStar": "Expr",
    "Letrec": "Expr",
    "Lam": "Expr",
    "Call": "Expr",
    "Prim": "Expr",
  };

  // tag → 子节点字段表（按声明顺序）。kind: n 单节点 / l 列表 / m 可选
  const FIELDS = {
    "Prog": [["defs","l"],["body","l"]],
    "DefFun": [["params","l"],["body","n"]],
    "DefVal": [["value","n"]],
    "Param": [],
    "Clause": [["test","n"],["body","n"]],
    "Bind": [["value","n"]],
    "Void": [],
    "Int": [],
    "Float": [],
    "Bool": [],
    "Str": [],
    "Var": [],
    "If": [["cond","n"],["then","n"],["alt","n"]],
    "IfAlt": [["cond","n"],["then","n"]],
    "When": [["cond","n"],["body","n"]],
    "Unless": [["cond","n"],["body","n"]],
    "Cond": [["clauses","l"],["else","m"]],
    "And": [["exprs","l"]],
    "Or": [["exprs","l"]],
    "Not": [["expr","n"]],
    "Begin": [["exprs","l"]],
    "Let": [["bindings","l"],["body","n"]],
    "LetStar": [["bindings","l"],["body","n"]],
    "Letrec": [["bindings","l"],["body","n"]],
    "Lam": [["params","l"],["body","n"]],
    "Call": [["fn","n"],["args","l"]],
    "Prim": [["args","l"]],
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
    case "Prog":
      return { type: "Prog", "defs": fr.r0, "body": fr.r1 };
    case "DefFun":
      return { type: "DefFun", "name": n.name, "params": fr.r0, "body": fr.r1 };
    case "DefVal":
      return { type: "DefVal", "name": n.name, "value": fr.r0 };
    case "Param":
      return { type: "Param", "name": n.name };
    case "Clause":
      return { type: "Clause", "test": fr.r0, "body": fr.r1 };
    case "Bind":
      return { type: "Bind", "name": n.name, "value": fr.r0 };
    case "Void":
      return { type: "Void" };
    case "Int":
      return { type: "Int", "value": n.value };
    case "Float":
      return { type: "Float", "value": n.value };
    case "Bool":
      return { type: "Bool", "value": n.value };
    case "Str":
      return { type: "Str", "value": n.value };
    case "Var":
      return { type: "Var", "name": n.name };
    case "If":
      return { type: "If", "cond": fr.r0, "then": fr.r1, "alt": fr.r2 };
    case "IfAlt":
      return { type: "IfAlt", "cond": fr.r0, "then": fr.r1 };
    case "When":
      return { type: "When", "cond": fr.r0, "body": fr.r1 };
    case "Unless":
      return { type: "Unless", "cond": fr.r0, "body": fr.r1 };
    case "Cond":
      return { type: "Cond", "clauses": fr.r0, "else": fr.r1 };
    case "And":
      return { type: "And", "exprs": fr.r0 };
    case "Or":
      return { type: "Or", "exprs": fr.r0 };
    case "Not":
      return { type: "Not", "expr": fr.r0 };
    case "Begin":
      return { type: "Begin", "exprs": fr.r0 };
    case "Let":
      return { type: "Let", "bindings": fr.r0, "body": fr.r1 };
    case "LetStar":
      return { type: "LetStar", "bindings": fr.r0, "body": fr.r1 };
    case "Letrec":
      return { type: "Letrec", "bindings": fr.r0, "body": fr.r1 };
    case "Lam":
      return { type: "Lam", "params": fr.r0, "body": fr.r1 };
    case "Call":
      return { type: "Call", "fn": fr.r0, "args": fr.r1 };
    case "Prim":
      return { type: "Prim", "op": n.op, "args": fr.r0 };
    default:
      throw new Error("[fuse Lsrc] 没有产生式 " + tag + " 的构造子");
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
      case 0: fr.r0 = v; return;
      case 1: fr.r1 = v; return;
      case 2: fr.r2 = v; return;
      default:
        throw new Error("[fuse Lsrc] 槽位越界 " + i);
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
            "[fuse Lsrc] 不认识的产生式 " + node.type +
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
          r0: undefined, r1: undefined, r2: undefined,
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
          "[fuse Lsrc] 输入嵌套太深：" + whereOf(lastNode) +
            "。\n  融合遍历器的 identity 那条路不占原生栈，但 handler 里调 rec、子节点又有 handler 时会嵌套 —— 层数等于路径上带 handler 的节点数（t18 / t27）。",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  return { run, arity: K };
}

return build;
})();

const GT2 = (function () {
// 由 codegen 生成（融合 + 蹦床）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L3 → L4   （1 门融成 1 个遍历）
//
// 这里是**显式帧栈 + dispatch 循环**，不是递归下树：identity 那条路上一个 JS 栈帧都不占。
// handler 里的 rec 也接到同一个蹦床上（会开一层嵌套的 drive），所以子树遍历也是迭代的。
// 唯一还会占原生栈的是「handler 里调 rec、子节点又有 handler」这种嵌套 —— 层数等于
// 路径上带 handler 的节点数（见 t18 的注释）。
function build(handlersList, init) {
  // 一个组的结果属于**最后一门** pass 的输出语言 —— 不是第一门的
  const LANG = "L4";
  /** 列表逐元素比引用 —— "没改就复用"用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = 1;
  const idRec = (x) => x;

  const TAG_NT = {
    "Prog": "Program",
    "DefVal": "Def",
    "Param": "Param",
    "Clause": "Clause",
    "Bind": "Bind",
    "Void": "Expr",
    "Int": "Expr",
    "Float": "Expr",
    "Bool": "Expr",
    "Str": "Expr",
    "Var": "Expr",
    "If": "Expr",
    "IfAlt": "Expr",
    "And": "Expr",
    "Or": "Expr",
    "Not": "Expr",
    "Begin": "Expr",
    "Let": "Expr",
    "LetStar": "Expr",
    "Letrec": "Expr",
    "Lam": "Expr",
    "Call": "Expr",
    "Prim": "Expr",
  };

  // tag → 子节点字段表（按声明顺序）。kind: n 单节点 / l 列表 / m 可选
  const FIELDS = {
    "Prog": [["defs","l"],["body","l"]],
    "DefVal": [["value","n"]],
    "Param": [],
    "Clause": [["test","n"],["body","n"]],
    "Bind": [["value","n"]],
    "Void": [],
    "Int": [],
    "Float": [],
    "Bool": [],
    "Str": [],
    "Var": [],
    "If": [["cond","n"],["then","n"],["alt","n"]],
    "IfAlt": [["cond","n"],["then","n"]],
    "And": [["exprs","l"]],
    "Or": [["exprs","l"]],
    "Not": [["expr","n"]],
    "Begin": [["exprs","l"]],
    "Let": [["bindings","l"],["body","n"]],
    "LetStar": [["bindings","l"],["body","n"]],
    "Letrec": [["bindings","l"],["body","n"]],
    "Lam": [["params","l"],["body","n"]],
    "Call": [["fn","n"],["args","l"]],
    "Prim": [["args","l"]],
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
    case "Prog":
      return { type: "Prog", "defs": fr.r0, "body": fr.r1 };
    case "DefVal":
      return { type: "DefVal", "name": n.name, "value": fr.r0 };
    case "Param":
      return { type: "Param", "name": n.name };
    case "Clause":
      return { type: "Clause", "test": fr.r0, "body": fr.r1 };
    case "Bind":
      return { type: "Bind", "name": n.name, "value": fr.r0 };
    case "Void":
      return { type: "Void" };
    case "Int":
      return { type: "Int", "value": n.value };
    case "Float":
      return { type: "Float", "value": n.value };
    case "Bool":
      return { type: "Bool", "value": n.value };
    case "Str":
      return { type: "Str", "value": n.value };
    case "Var":
      return { type: "Var", "name": n.name };
    case "If":
      return { type: "If", "cond": fr.r0, "then": fr.r1, "alt": fr.r2 };
    case "IfAlt":
      return { type: "IfAlt", "cond": fr.r0, "then": fr.r1 };
    case "And":
      return { type: "And", "exprs": fr.r0 };
    case "Or":
      return { type: "Or", "exprs": fr.r0 };
    case "Not":
      return { type: "Not", "expr": fr.r0 };
    case "Begin":
      return { type: "Begin", "exprs": fr.r0 };
    case "Let":
      return { type: "Let", "bindings": fr.r0, "body": fr.r1 };
    case "LetStar":
      return { type: "LetStar", "bindings": fr.r0, "body": fr.r1 };
    case "Letrec":
      return { type: "Letrec", "bindings": fr.r0, "body": fr.r1 };
    case "Lam":
      return { type: "Lam", "params": fr.r0, "body": fr.r1 };
    case "Call":
      return { type: "Call", "fn": fr.r0, "args": fr.r1 };
    case "Prim":
      return { type: "Prim", "op": n.op, "args": fr.r0 };
    default:
      throw new Error("[fuse L3] 没有产生式 " + tag + " 的构造子");
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
      case 0: fr.r0 = v; return;
      case 1: fr.r1 = v; return;
      case 2: fr.r2 = v; return;
      default:
        throw new Error("[fuse L3] 槽位越界 " + i);
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
            "[fuse L3] 不认识的产生式 " + node.type +
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
          r0: undefined, r1: undefined, r2: undefined,
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
          "[fuse L3] 输入嵌套太深：" + whereOf(lastNode) +
            "。\n  融合遍历器的 identity 那条路不占原生栈，但 handler 里调 rec、子节点又有 handler 时会嵌套 —— 层数等于路径上带 handler 的节点数（t18 / t27）。",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  return { run, arity: K };
}

return build;
})();

const GR3 = (function () {
// 由 codegen 生成（融合）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L4 → L5 → L6   （3 门融成 1 个遍历）
function build(handlersList, init) {
  const LANG = "L5";
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
        const err = new Error("[fuse L4] 输入嵌套太深：" + whereOf(deepest) + "（走到 " + maxDepth + " 层就溢出了）。");
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
      throw new Error("[fuse L4] rec() 遇到不认识的产生式 " + x.type + "（" + whereOf(x) + "）");
    }
    return w(x);
  }

  function sh_1_Program(v) {
    let out;
    switch (v.type) {
    case "Prog": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L5 的非终结符 Program 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_1_Def(v) {
    let out;
    switch (v.type) {
    case "DefVal": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L5 的非终结符 Def 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_1_Param(v) {
    let out;
    switch (v.type) {
    case "Param": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L5 的非终结符 Param 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_1_Clause(v) {
    let out;
    switch (v.type) {
    case "Clause": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L5 的非终结符 Clause 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_1_Bind(v) {
    let out;
    switch (v.type) {
    case "Bind": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L5 的非终结符 Bind 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_1_Expr(v) {
    let out;
    switch (v.type) {
    case "Void": {
      out = v;
      break;
    }
    case "Int": {
      out = v;
      break;
    }
    case "Float": {
      out = v;
      break;
    }
    case "Bool": {
      out = v;
      break;
    }
    case "Str": {
      out = v;
      break;
    }
    case "Var": {
      out = v;
      break;
    }
    case "If": {
      out = v;
      break;
    }
    case "IfAlt": {
      out = finish(v, handlersList[1]["Expr"]["IfAlt"](v, idRec));
      break;
    }
    case "Begin": {
      out = v;
      break;
    }
    case "Let": {
      out = v;
      break;
    }
    case "Letrec": {
      out = v;
      break;
    }
    case "Lam": {
      out = v;
      break;
    }
    case "Call": {
      out = v;
      break;
    }
    case "Prim": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L5 的非终结符 Expr 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_2_Program(v) {
    let out;
    switch (v.type) {
    case "Prog": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L6 的非终结符 Program 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_2_Def(v) {
    let out;
    switch (v.type) {
    case "DefVal": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L6 的非终结符 Def 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_2_Param(v) {
    let out;
    switch (v.type) {
    case "Param": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L6 的非终结符 Param 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_2_Clause(v) {
    let out;
    switch (v.type) {
    case "Clause": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L6 的非终结符 Clause 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_2_Bind(v) {
    let out;
    switch (v.type) {
    case "Bind": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L6 的非终结符 Bind 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function sh_2_Expr(v) {
    let out;
    switch (v.type) {
    case "Void": {
      out = v;
      break;
    }
    case "Int": {
      out = v;
      break;
    }
    case "Float": {
      out = v;
      break;
    }
    case "Bool": {
      out = v;
      break;
    }
    case "Str": {
      out = v;
      break;
    }
    case "Var": {
      out = v;
      break;
    }
    case "If": {
      out = v;
      break;
    }
    case "Begin": {
      out = finish(v, handlersList[2]["Expr"]["Begin"](v, idRec));
      break;
    }
    case "Let": {
      out = v;
      break;
    }
    case "Letrec": {
      out = v;
      break;
    }
    case "Lam": {
      out = v;
      break;
    }
    case "Call": {
      out = v;
      break;
    }
    case "Prim": {
      out = v;
      break;
    }
    default:
      throw new Error("[fuse] L6 的非终结符 Expr 里没有产生式 " + v.type + "（" + whereOf(v) + "）");
    }
    return out;
  }

  function deep_Program(n) {
    let v;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Prog": {
      v = finish(n, { type: "Prog", "defs": n.defs.map(deep_Def), "body": n.body.map(deep_Expr) });
      break;
    }
    default:
      throw new Error("[fuse L4] 非终结符 Program 里没有产生式 " + n.type + "（" + whereOf(n) + "）");
    }
    depth--;
    v = sh_1_Program(v);
    v = sh_2_Program(v);
    return v;
  }

  function deep_Def(n) {
    let v;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "DefVal": {
      v = finish(n, { type: "DefVal", "name": n.name, "value": deep_Expr(n.value) });
      break;
    }
    default:
      throw new Error("[fuse L4] 非终结符 Def 里没有产生式 " + n.type + "（" + whereOf(n) + "）");
    }
    depth--;
    v = sh_1_Def(v);
    v = sh_2_Def(v);
    return v;
  }

  function deep_Param(n) {
    let v;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Param": {
      v = finish(n, { type: "Param", "name": n.name });
      break;
    }
    default:
      throw new Error("[fuse L4] 非终结符 Param 里没有产生式 " + n.type + "（" + whereOf(n) + "）");
    }
    depth--;
    v = sh_1_Param(v);
    v = sh_2_Param(v);
    return v;
  }

  function deep_Clause(n) {
    let v;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Clause": {
      v = finish(n, { type: "Clause", "test": deep_Expr(n.test), "body": deep_Expr(n.body) });
      break;
    }
    default:
      throw new Error("[fuse L4] 非终结符 Clause 里没有产生式 " + n.type + "（" + whereOf(n) + "）");
    }
    depth--;
    v = sh_1_Clause(v);
    v = sh_2_Clause(v);
    return v;
  }

  function deep_Bind(n) {
    let v;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Bind": {
      v = finish(n, { type: "Bind", "name": n.name, "value": deep_Expr(n.value) });
      break;
    }
    default:
      throw new Error("[fuse L4] 非终结符 Bind 里没有产生式 " + n.type + "（" + whereOf(n) + "）");
    }
    depth--;
    v = sh_1_Bind(v);
    v = sh_2_Bind(v);
    return v;
  }

  function deep_Expr(n) {
    let v;
    const d = ++depth;
    if (d > maxDepth) { maxDepth = d; deepest = n; }
    switch (n.type) {
    case "Void": {
      v = finish(n, { type: "Void" });
      break;
    }
    case "Int": {
      v = finish(n, { type: "Int", "value": n.value });
      break;
    }
    case "Float": {
      v = finish(n, { type: "Float", "value": n.value });
      break;
    }
    case "Bool": {
      v = finish(n, { type: "Bool", "value": n.value });
      break;
    }
    case "Str": {
      v = finish(n, { type: "Str", "value": n.value });
      break;
    }
    case "Var": {
      v = finish(n, { type: "Var", "name": n.name });
      break;
    }
    case "If": {
      v = finish(n, { type: "If", "cond": deep_Expr(n.cond), "then": deep_Expr(n.then), "alt": deep_Expr(n.alt) });
      break;
    }
    case "IfAlt": {
      v = finish(n, { type: "IfAlt", "cond": deep_Expr(n.cond), "then": deep_Expr(n.then) });
      break;
    }
    case "Begin": {
      v = finish(n, { type: "Begin", "exprs": n.exprs.map(deep_Expr) });
      break;
    }
    case "Let": {
      v = finish(n, { type: "Let", "bindings": n.bindings.map(deep_Bind), "body": deep_Expr(n.body) });
      break;
    }
    case "LetStar": {
      v = finish(n, handlersList[0]["Expr"]["LetStar"](n, deep));
      break;
    }
    case "Letrec": {
      v = finish(n, { type: "Letrec", "bindings": n.bindings.map(deep_Bind), "body": deep_Expr(n.body) });
      break;
    }
    case "Lam": {
      v = finish(n, { type: "Lam", "params": n.params.map(deep_Param), "body": deep_Expr(n.body) });
      break;
    }
    case "Call": {
      v = finish(n, { type: "Call", "fn": deep_Expr(n.fn), "args": n.args.map(deep_Expr) });
      break;
    }
    case "Prim": {
      v = finish(n, { type: "Prim", "op": n.op, "args": n.args.map(deep_Expr) });
      break;
    }
    default:
      throw new Error("[fuse L4] 非终结符 Expr 里没有产生式 " + n.type + "（" + whereOf(n) + "）");
    }
    depth--;
    v = sh_1_Expr(v);
    v = sh_2_Expr(v);
    return v;
  }

  const DEEP = {
    "Prog": deep_Program,
    "DefVal": deep_Def,
    "Param": deep_Param,
    "Clause": deep_Clause,
    "Bind": deep_Bind,
    "Void": deep_Expr,
    "Int": deep_Expr,
    "Float": deep_Expr,
    "Bool": deep_Expr,
    "Str": deep_Expr,
    "Var": deep_Expr,
    "If": deep_Expr,
    "IfAlt": deep_Expr,
    "Begin": deep_Expr,
    "Let": deep_Expr,
    "LetStar": deep_Expr,
    "Letrec": deep_Expr,
    "Lam": deep_Expr,
    "Call": deep_Expr,
    "Prim": deep_Expr,
  };

  function run(x) {
    depth = 0; maxDepth = 0; deepest = null;
    return guard(() => deep(x));
  }

  return { run, arity: 0 };
}

return build;
})();
const GT3 = (function () {
// 由 codegen 生成（融合 + 蹦床）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L4 → L5 → L6 → L6   （3 门融成 1 个遍历）
//
// 这里是**显式帧栈 + dispatch 循环**，不是递归下树：identity 那条路上一个 JS 栈帧都不占。
// handler 里的 rec 也接到同一个蹦床上（会开一层嵌套的 drive），所以子树遍历也是迭代的。
// 唯一还会占原生栈的是「handler 里调 rec、子节点又有 handler」这种嵌套 —— 层数等于
// 路径上带 handler 的节点数（见 t18 的注释）。
function build(handlersList, init) {
  // 一个组的结果属于**最后一门** pass 的输出语言 —— 不是第一门的
  const LANG = "L6";
  /** 列表逐元素比引用 —— "没改就复用"用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = 0;
  const idRec = (x) => x;

  const TAG_NT = {
    "Prog": "Program",
    "DefVal": "Def",
    "Param": "Param",
    "Clause": "Clause",
    "Bind": "Bind",
    "Void": "Expr",
    "Int": "Expr",
    "Float": "Expr",
    "Bool": "Expr",
    "Str": "Expr",
    "Var": "Expr",
    "If": "Expr",
    "IfAlt": "Expr",
    "Begin": "Expr",
    "Let": "Expr",
    "LetStar": "Expr",
    "Letrec": "Expr",
    "Lam": "Expr",
    "Call": "Expr",
    "Prim": "Expr",
  };

  // tag → 子节点字段表（按声明顺序）。kind: n 单节点 / l 列表 / m 可选
  const FIELDS = {
    "Prog": [["defs","l"],["body","l"]],
    "DefVal": [["value","n"]],
    "Param": [],
    "Clause": [["test","n"],["body","n"]],
    "Bind": [["value","n"]],
    "Void": [],
    "Int": [],
    "Float": [],
    "Bool": [],
    "Str": [],
    "Var": [],
    "If": [["cond","n"],["then","n"],["alt","n"]],
    "IfAlt": [["cond","n"],["then","n"]],
    "Begin": [["exprs","l"]],
    "Let": [["bindings","l"],["body","n"]],
    "LetStar": [["bindings","l"],["body","n"]],
    "Letrec": [["bindings","l"],["body","n"]],
    "Lam": [["params","l"],["body","n"]],
    "Call": [["fn","n"],["args","l"]],
    "Prim": [["args","l"]],
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
    case "Prog":
      return { type: "Prog", "defs": fr.r0, "body": fr.r1 };
    case "DefVal":
      return { type: "DefVal", "name": n.name, "value": fr.r0 };
    case "Param":
      return { type: "Param", "name": n.name };
    case "Clause":
      return { type: "Clause", "test": fr.r0, "body": fr.r1 };
    case "Bind":
      return { type: "Bind", "name": n.name, "value": fr.r0 };
    case "Void":
      return { type: "Void" };
    case "Int":
      return { type: "Int", "value": n.value };
    case "Float":
      return { type: "Float", "value": n.value };
    case "Bool":
      return { type: "Bool", "value": n.value };
    case "Str":
      return { type: "Str", "value": n.value };
    case "Var":
      return { type: "Var", "name": n.name };
    case "If":
      return { type: "If", "cond": fr.r0, "then": fr.r1, "alt": fr.r2 };
    case "IfAlt":
      return { type: "IfAlt", "cond": fr.r0, "then": fr.r1 };
    case "Begin":
      return { type: "Begin", "exprs": fr.r0 };
    case "Let":
      return { type: "Let", "bindings": fr.r0, "body": fr.r1 };
    case "LetStar":
      return { type: "LetStar", "bindings": fr.r0, "body": fr.r1 };
    case "Letrec":
      return { type: "Letrec", "bindings": fr.r0, "body": fr.r1 };
    case "Lam":
      return { type: "Lam", "params": fr.r0, "body": fr.r1 };
    case "Call":
      return { type: "Call", "fn": fr.r0, "args": fr.r1 };
    case "Prim":
      return { type: "Prim", "op": n.op, "args": fr.r0 };
    default:
      throw new Error("[fuse L4] 没有产生式 " + tag + " 的构造子");
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
      case 0: fr.r0 = v; return;
      case 1: fr.r1 = v; return;
      case 2: fr.r2 = v; return;
      default:
        throw new Error("[fuse L4] 槽位越界 " + i);
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
            "[fuse L4] 不认识的产生式 " + node.type +
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
          r0: undefined, r1: undefined, r2: undefined,
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
          "[fuse L4] 输入嵌套太深：" + whereOf(lastNode) +
            "。\n  融合遍历器的 identity 那条路不占原生栈，但 handler 里调 rec、子节点又有 handler 时会嵌套 —— 层数等于路径上带 handler 的节点数（t18 / t27）。",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  return { run, arity: K };
}

return build;
})();

const GT4 = (function () {
// 由 codegen 生成（融合 + 蹦床）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L6 → L6   （1 门融成 1 个遍历）
//
// 这里是**显式帧栈 + dispatch 循环**，不是递归下树：identity 那条路上一个 JS 栈帧都不占。
// handler 里的 rec 也接到同一个蹦床上（会开一层嵌套的 drive），所以子树遍历也是迭代的。
// 唯一还会占原生栈的是「handler 里调 rec、子节点又有 handler」这种嵌套 —— 层数等于
// 路径上带 handler 的节点数（见 t18 的注释）。
function build(handlersList, init) {
  // 一个组的结果属于**最后一门** pass 的输出语言 —— 不是第一门的
  const LANG = "L6";
  /** 列表逐元素比引用 —— "没改就复用"用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = 1;
  const idRec = (x) => x;

  const TAG_NT = {
    "Prog": "Program",
    "DefVal": "Def",
    "Param": "Param",
    "Clause": "Clause",
    "Bind": "Bind",
    "Void": "Expr",
    "Int": "Expr",
    "Float": "Expr",
    "Bool": "Expr",
    "Str": "Expr",
    "Var": "Expr",
    "If": "Expr",
    "Begin": "Expr",
    "Let": "Expr",
    "Letrec": "Expr",
    "Lam": "Expr",
    "Call": "Expr",
    "Prim": "Expr",
  };

  // tag → 子节点字段表（按声明顺序）。kind: n 单节点 / l 列表 / m 可选
  const FIELDS = {
    "Prog": [["defs","l"],["body","l"]],
    "DefVal": [["value","n"]],
    "Param": [],
    "Clause": [["test","n"],["body","n"]],
    "Bind": [["value","n"]],
    "Void": [],
    "Int": [],
    "Float": [],
    "Bool": [],
    "Str": [],
    "Var": [],
    "If": [["cond","n"],["then","n"],["alt","n"]],
    "Begin": [["exprs","l"]],
    "Let": [["bindings","l"],["body","n"]],
    "Letrec": [["bindings","l"],["body","n"]],
    "Lam": [["params","l"],["body","n"]],
    "Call": [["fn","n"],["args","l"]],
    "Prim": [["args","l"]],
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
    case "Prog":
      return (!sameList(fr.r0, n.defs) || !sameList(fr.r1, n.body)) ? { type: "Prog", "defs": fr.r0, "body": fr.r1 } : n;
    case "DefVal":
      return (fr.r0 !== n.value) ? { type: "DefVal", "name": n.name, "value": fr.r0 } : n;
    case "Param":
      return n;
    case "Clause":
      return (fr.r0 !== n.test || fr.r1 !== n.body) ? { type: "Clause", "test": fr.r0, "body": fr.r1 } : n;
    case "Bind":
      return (fr.r0 !== n.value) ? { type: "Bind", "name": n.name, "value": fr.r0 } : n;
    case "Void":
      return n;
    case "Int":
      return n;
    case "Float":
      return n;
    case "Bool":
      return n;
    case "Str":
      return n;
    case "Var":
      return n;
    case "If":
      return (fr.r0 !== n.cond || fr.r1 !== n.then || fr.r2 !== n.alt) ? { type: "If", "cond": fr.r0, "then": fr.r1, "alt": fr.r2 } : n;
    case "Begin":
      return (!sameList(fr.r0, n.exprs)) ? { type: "Begin", "exprs": fr.r0 } : n;
    case "Let":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Let", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Letrec":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Letrec", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Lam":
      return (!sameList(fr.r0, n.params) || fr.r1 !== n.body) ? { type: "Lam", "params": fr.r0, "body": fr.r1 } : n;
    case "Call":
      return (fr.r0 !== n.fn || !sameList(fr.r1, n.args)) ? { type: "Call", "fn": fr.r0, "args": fr.r1 } : n;
    case "Prim":
      return (!sameList(fr.r0, n.args)) ? { type: "Prim", "op": n.op, "args": fr.r0 } : n;
    default:
      throw new Error("[fuse L6] 没有产生式 " + tag + " 的构造子");
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
      case 0: fr.r0 = v; return;
      case 1: fr.r1 = v; return;
      case 2: fr.r2 = v; return;
      default:
        throw new Error("[fuse L6] 槽位越界 " + i);
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
            "[fuse L6] 不认识的产生式 " + node.type +
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
          r0: undefined, r1: undefined, r2: undefined,
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
          "[fuse L6] 输入嵌套太深：" + whereOf(lastNode) +
            "。\n  融合遍历器的 identity 那条路不占原生栈，但 handler 里调 rec、子节点又有 handler 时会嵌套 —— 层数等于路径上带 handler 的节点数（t18 / t27）。",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  return { run, arity: K };
}

return build;
})();

const GT5 = (function () {
// 由 codegen 生成（融合 + 蹦床）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L6 → L6   （1 门融成 1 个遍历）
//
// 这里是**显式帧栈 + dispatch 循环**，不是递归下树：identity 那条路上一个 JS 栈帧都不占。
// handler 里的 rec 也接到同一个蹦床上（会开一层嵌套的 drive），所以子树遍历也是迭代的。
// 唯一还会占原生栈的是「handler 里调 rec、子节点又有 handler」这种嵌套 —— 层数等于
// 路径上带 handler 的节点数（见 t18 的注释）。
function build(handlersList, init) {
  // 一个组的结果属于**最后一门** pass 的输出语言 —— 不是第一门的
  const LANG = "L6";
  /** 列表逐元素比引用 —— "没改就复用"用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = 0;
  const idRec = (x) => x;

  const TAG_NT = {
    "Prog": "Program",
    "DefVal": "Def",
    "Param": "Param",
    "Clause": "Clause",
    "Bind": "Bind",
    "Void": "Expr",
    "Int": "Expr",
    "Float": "Expr",
    "Bool": "Expr",
    "Str": "Expr",
    "Var": "Expr",
    "If": "Expr",
    "Begin": "Expr",
    "Let": "Expr",
    "Letrec": "Expr",
    "Lam": "Expr",
    "Call": "Expr",
    "Prim": "Expr",
  };

  // tag → 子节点字段表（按声明顺序）。kind: n 单节点 / l 列表 / m 可选
  const FIELDS = {
    "Prog": [["defs","l"],["body","l"]],
    "DefVal": [["value","n"]],
    "Param": [],
    "Clause": [["test","n"],["body","n"]],
    "Bind": [["value","n"]],
    "Void": [],
    "Int": [],
    "Float": [],
    "Bool": [],
    "Str": [],
    "Var": [],
    "If": [["cond","n"],["then","n"],["alt","n"]],
    "Begin": [["exprs","l"]],
    "Let": [["bindings","l"],["body","n"]],
    "Letrec": [["bindings","l"],["body","n"]],
    "Lam": [["params","l"],["body","n"]],
    "Call": [["fn","n"],["args","l"]],
    "Prim": [["args","l"]],
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
    case "Prog":
      return (!sameList(fr.r0, n.defs) || !sameList(fr.r1, n.body)) ? { type: "Prog", "defs": fr.r0, "body": fr.r1 } : n;
    case "DefVal":
      return (fr.r0 !== n.value) ? { type: "DefVal", "name": n.name, "value": fr.r0 } : n;
    case "Param":
      return n;
    case "Clause":
      return (fr.r0 !== n.test || fr.r1 !== n.body) ? { type: "Clause", "test": fr.r0, "body": fr.r1 } : n;
    case "Bind":
      return (fr.r0 !== n.value) ? { type: "Bind", "name": n.name, "value": fr.r0 } : n;
    case "Void":
      return n;
    case "Int":
      return n;
    case "Float":
      return n;
    case "Bool":
      return n;
    case "Str":
      return n;
    case "Var":
      return n;
    case "If":
      return (fr.r0 !== n.cond || fr.r1 !== n.then || fr.r2 !== n.alt) ? { type: "If", "cond": fr.r0, "then": fr.r1, "alt": fr.r2 } : n;
    case "Begin":
      return (!sameList(fr.r0, n.exprs)) ? { type: "Begin", "exprs": fr.r0 } : n;
    case "Let":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Let", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Letrec":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Letrec", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Lam":
      return (!sameList(fr.r0, n.params) || fr.r1 !== n.body) ? { type: "Lam", "params": fr.r0, "body": fr.r1 } : n;
    case "Call":
      return (fr.r0 !== n.fn || !sameList(fr.r1, n.args)) ? { type: "Call", "fn": fr.r0, "args": fr.r1 } : n;
    case "Prim":
      return (!sameList(fr.r0, n.args)) ? { type: "Prim", "op": n.op, "args": fr.r0 } : n;
    default:
      throw new Error("[fuse L6] 没有产生式 " + tag + " 的构造子");
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
      case 0: fr.r0 = v; return;
      case 1: fr.r1 = v; return;
      case 2: fr.r2 = v; return;
      default:
        throw new Error("[fuse L6] 槽位越界 " + i);
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
            "[fuse L6] 不认识的产生式 " + node.type +
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
          r0: undefined, r1: undefined, r2: undefined,
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
          "[fuse L6] 输入嵌套太深：" + whereOf(lastNode) +
            "。\n  融合遍历器的 identity 那条路不占原生栈，但 handler 里调 rec、子节点又有 handler 时会嵌套 —— 层数等于路径上带 handler 的节点数（t18 / t27）。",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  return { run, arity: K };
}

return build;
})();

const GT6 = (function () {
// 由 codegen 生成（融合 + 蹦床）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L6 → L6   （1 门融成 1 个遍历）
//
// 这里是**显式帧栈 + dispatch 循环**，不是递归下树：identity 那条路上一个 JS 栈帧都不占。
// handler 里的 rec 也接到同一个蹦床上（会开一层嵌套的 drive），所以子树遍历也是迭代的。
// 唯一还会占原生栈的是「handler 里调 rec、子节点又有 handler」这种嵌套 —— 层数等于
// 路径上带 handler 的节点数（见 t18 的注释）。
function build(handlersList, init) {
  // 一个组的结果属于**最后一门** pass 的输出语言 —— 不是第一门的
  const LANG = "L6";
  /** 列表逐元素比引用 —— "没改就复用"用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = 1;
  const idRec = (x) => x;

  const TAG_NT = {
    "Prog": "Program",
    "DefVal": "Def",
    "Param": "Param",
    "Clause": "Clause",
    "Bind": "Bind",
    "Void": "Expr",
    "Int": "Expr",
    "Float": "Expr",
    "Bool": "Expr",
    "Str": "Expr",
    "Var": "Expr",
    "If": "Expr",
    "Begin": "Expr",
    "Let": "Expr",
    "Letrec": "Expr",
    "Lam": "Expr",
    "Call": "Expr",
    "Prim": "Expr",
  };

  // tag → 子节点字段表（按声明顺序）。kind: n 单节点 / l 列表 / m 可选
  const FIELDS = {
    "Prog": [["defs","l"],["body","l"]],
    "DefVal": [["value","n"]],
    "Param": [],
    "Clause": [["test","n"],["body","n"]],
    "Bind": [["value","n"]],
    "Void": [],
    "Int": [],
    "Float": [],
    "Bool": [],
    "Str": [],
    "Var": [],
    "If": [["cond","n"],["then","n"],["alt","n"]],
    "Begin": [["exprs","l"]],
    "Let": [["bindings","l"],["body","n"]],
    "Letrec": [["bindings","l"],["body","n"]],
    "Lam": [["params","l"],["body","n"]],
    "Call": [["fn","n"],["args","l"]],
    "Prim": [["args","l"]],
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
    case "Prog":
      return (!sameList(fr.r0, n.defs) || !sameList(fr.r1, n.body)) ? { type: "Prog", "defs": fr.r0, "body": fr.r1 } : n;
    case "DefVal":
      return (fr.r0 !== n.value) ? { type: "DefVal", "name": n.name, "value": fr.r0 } : n;
    case "Param":
      return n;
    case "Clause":
      return (fr.r0 !== n.test || fr.r1 !== n.body) ? { type: "Clause", "test": fr.r0, "body": fr.r1 } : n;
    case "Bind":
      return (fr.r0 !== n.value) ? { type: "Bind", "name": n.name, "value": fr.r0 } : n;
    case "Void":
      return n;
    case "Int":
      return n;
    case "Float":
      return n;
    case "Bool":
      return n;
    case "Str":
      return n;
    case "Var":
      return n;
    case "If":
      return (fr.r0 !== n.cond || fr.r1 !== n.then || fr.r2 !== n.alt) ? { type: "If", "cond": fr.r0, "then": fr.r1, "alt": fr.r2 } : n;
    case "Begin":
      return (!sameList(fr.r0, n.exprs)) ? { type: "Begin", "exprs": fr.r0 } : n;
    case "Let":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Let", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Letrec":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Letrec", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Lam":
      return (!sameList(fr.r0, n.params) || fr.r1 !== n.body) ? { type: "Lam", "params": fr.r0, "body": fr.r1 } : n;
    case "Call":
      return (fr.r0 !== n.fn || !sameList(fr.r1, n.args)) ? { type: "Call", "fn": fr.r0, "args": fr.r1 } : n;
    case "Prim":
      return (!sameList(fr.r0, n.args)) ? { type: "Prim", "op": n.op, "args": fr.r0 } : n;
    default:
      throw new Error("[fuse L6] 没有产生式 " + tag + " 的构造子");
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
      case 0: fr.r0 = v; return;
      case 1: fr.r1 = v; return;
      case 2: fr.r2 = v; return;
      default:
        throw new Error("[fuse L6] 槽位越界 " + i);
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
            "[fuse L6] 不认识的产生式 " + node.type +
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
          r0: undefined, r1: undefined, r2: undefined,
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
          "[fuse L6] 输入嵌套太深：" + whereOf(lastNode) +
            "。\n  融合遍历器的 identity 那条路不占原生栈，但 handler 里调 rec、子节点又有 handler 时会嵌套 —— 层数等于路径上带 handler 的节点数（t18 / t27）。",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  return { run, arity: K };
}

return build;
})();

const GT7 = (function () {
// 由 codegen 生成（融合 + 蹦床）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L6 → L6   （1 门融成 1 个遍历）
//
// 这里是**显式帧栈 + dispatch 循环**，不是递归下树：identity 那条路上一个 JS 栈帧都不占。
// handler 里的 rec 也接到同一个蹦床上（会开一层嵌套的 drive），所以子树遍历也是迭代的。
// 唯一还会占原生栈的是「handler 里调 rec、子节点又有 handler」这种嵌套 —— 层数等于
// 路径上带 handler 的节点数（见 t18 的注释）。
function build(handlersList, init) {
  // 一个组的结果属于**最后一门** pass 的输出语言 —— 不是第一门的
  const LANG = "L6";
  /** 列表逐元素比引用 —— "没改就复用"用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = 1;
  const idRec = (x) => x;

  const TAG_NT = {
    "Prog": "Program",
    "DefVal": "Def",
    "Param": "Param",
    "Clause": "Clause",
    "Bind": "Bind",
    "Void": "Expr",
    "Int": "Expr",
    "Float": "Expr",
    "Bool": "Expr",
    "Str": "Expr",
    "Var": "Expr",
    "If": "Expr",
    "Begin": "Expr",
    "Let": "Expr",
    "Letrec": "Expr",
    "Lam": "Expr",
    "Call": "Expr",
    "Prim": "Expr",
  };

  // tag → 子节点字段表（按声明顺序）。kind: n 单节点 / l 列表 / m 可选
  const FIELDS = {
    "Prog": [["defs","l"],["body","l"]],
    "DefVal": [["value","n"]],
    "Param": [],
    "Clause": [["test","n"],["body","n"]],
    "Bind": [["value","n"]],
    "Void": [],
    "Int": [],
    "Float": [],
    "Bool": [],
    "Str": [],
    "Var": [],
    "If": [["cond","n"],["then","n"],["alt","n"]],
    "Begin": [["exprs","l"]],
    "Let": [["bindings","l"],["body","n"]],
    "Letrec": [["bindings","l"],["body","n"]],
    "Lam": [["params","l"],["body","n"]],
    "Call": [["fn","n"],["args","l"]],
    "Prim": [["args","l"]],
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
    case "Prog":
      return (!sameList(fr.r0, n.defs) || !sameList(fr.r1, n.body)) ? { type: "Prog", "defs": fr.r0, "body": fr.r1 } : n;
    case "DefVal":
      return (fr.r0 !== n.value) ? { type: "DefVal", "name": n.name, "value": fr.r0 } : n;
    case "Param":
      return n;
    case "Clause":
      return (fr.r0 !== n.test || fr.r1 !== n.body) ? { type: "Clause", "test": fr.r0, "body": fr.r1 } : n;
    case "Bind":
      return (fr.r0 !== n.value) ? { type: "Bind", "name": n.name, "value": fr.r0 } : n;
    case "Void":
      return n;
    case "Int":
      return n;
    case "Float":
      return n;
    case "Bool":
      return n;
    case "Str":
      return n;
    case "Var":
      return n;
    case "If":
      return (fr.r0 !== n.cond || fr.r1 !== n.then || fr.r2 !== n.alt) ? { type: "If", "cond": fr.r0, "then": fr.r1, "alt": fr.r2 } : n;
    case "Begin":
      return (!sameList(fr.r0, n.exprs)) ? { type: "Begin", "exprs": fr.r0 } : n;
    case "Let":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Let", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Letrec":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Letrec", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Lam":
      return (!sameList(fr.r0, n.params) || fr.r1 !== n.body) ? { type: "Lam", "params": fr.r0, "body": fr.r1 } : n;
    case "Call":
      return (fr.r0 !== n.fn || !sameList(fr.r1, n.args)) ? { type: "Call", "fn": fr.r0, "args": fr.r1 } : n;
    case "Prim":
      return (!sameList(fr.r0, n.args)) ? { type: "Prim", "op": n.op, "args": fr.r0 } : n;
    default:
      throw new Error("[fuse L6] 没有产生式 " + tag + " 的构造子");
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
      case 0: fr.r0 = v; return;
      case 1: fr.r1 = v; return;
      case 2: fr.r2 = v; return;
      default:
        throw new Error("[fuse L6] 槽位越界 " + i);
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
            "[fuse L6] 不认识的产生式 " + node.type +
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
          r0: undefined, r1: undefined, r2: undefined,
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
          "[fuse L6] 输入嵌套太深：" + whereOf(lastNode) +
            "。\n  融合遍历器的 identity 那条路不占原生栈，但 handler 里调 rec、子节点又有 handler 时会嵌套 —— 层数等于路径上带 handler 的节点数（t18 / t27）。",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  return { run, arity: K };
}

return build;
})();

const GT8 = (function () {
// 由 codegen 生成（融合 + 蹦床）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L6 → L6   （1 门融成 1 个遍历）
//
// 这里是**显式帧栈 + dispatch 循环**，不是递归下树：identity 那条路上一个 JS 栈帧都不占。
// handler 里的 rec 也接到同一个蹦床上（会开一层嵌套的 drive），所以子树遍历也是迭代的。
// 唯一还会占原生栈的是「handler 里调 rec、子节点又有 handler」这种嵌套 —— 层数等于
// 路径上带 handler 的节点数（见 t18 的注释）。
function build(handlersList, init) {
  // 一个组的结果属于**最后一门** pass 的输出语言 —— 不是第一门的
  const LANG = "L6";
  /** 列表逐元素比引用 —— "没改就复用"用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = 0;
  const idRec = (x) => x;

  const TAG_NT = {
    "Prog": "Program",
    "DefVal": "Def",
    "Param": "Param",
    "Clause": "Clause",
    "Bind": "Bind",
    "Void": "Expr",
    "Int": "Expr",
    "Float": "Expr",
    "Bool": "Expr",
    "Str": "Expr",
    "Var": "Expr",
    "If": "Expr",
    "Begin": "Expr",
    "Let": "Expr",
    "Letrec": "Expr",
    "Lam": "Expr",
    "Call": "Expr",
    "Prim": "Expr",
  };

  // tag → 子节点字段表（按声明顺序）。kind: n 单节点 / l 列表 / m 可选
  const FIELDS = {
    "Prog": [["defs","l"],["body","l"]],
    "DefVal": [["value","n"]],
    "Param": [],
    "Clause": [["test","n"],["body","n"]],
    "Bind": [["value","n"]],
    "Void": [],
    "Int": [],
    "Float": [],
    "Bool": [],
    "Str": [],
    "Var": [],
    "If": [["cond","n"],["then","n"],["alt","n"]],
    "Begin": [["exprs","l"]],
    "Let": [["bindings","l"],["body","n"]],
    "Letrec": [["bindings","l"],["body","n"]],
    "Lam": [["params","l"],["body","n"]],
    "Call": [["fn","n"],["args","l"]],
    "Prim": [["args","l"]],
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
    case "Prog":
      return (!sameList(fr.r0, n.defs) || !sameList(fr.r1, n.body)) ? { type: "Prog", "defs": fr.r0, "body": fr.r1 } : n;
    case "DefVal":
      return (fr.r0 !== n.value) ? { type: "DefVal", "name": n.name, "value": fr.r0 } : n;
    case "Param":
      return n;
    case "Clause":
      return (fr.r0 !== n.test || fr.r1 !== n.body) ? { type: "Clause", "test": fr.r0, "body": fr.r1 } : n;
    case "Bind":
      return (fr.r0 !== n.value) ? { type: "Bind", "name": n.name, "value": fr.r0 } : n;
    case "Void":
      return n;
    case "Int":
      return n;
    case "Float":
      return n;
    case "Bool":
      return n;
    case "Str":
      return n;
    case "Var":
      return n;
    case "If":
      return (fr.r0 !== n.cond || fr.r1 !== n.then || fr.r2 !== n.alt) ? { type: "If", "cond": fr.r0, "then": fr.r1, "alt": fr.r2 } : n;
    case "Begin":
      return (!sameList(fr.r0, n.exprs)) ? { type: "Begin", "exprs": fr.r0 } : n;
    case "Let":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Let", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Letrec":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Letrec", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Lam":
      return (!sameList(fr.r0, n.params) || fr.r1 !== n.body) ? { type: "Lam", "params": fr.r0, "body": fr.r1 } : n;
    case "Call":
      return (fr.r0 !== n.fn || !sameList(fr.r1, n.args)) ? { type: "Call", "fn": fr.r0, "args": fr.r1 } : n;
    case "Prim":
      return (!sameList(fr.r0, n.args)) ? { type: "Prim", "op": n.op, "args": fr.r0 } : n;
    default:
      throw new Error("[fuse L6] 没有产生式 " + tag + " 的构造子");
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
      case 0: fr.r0 = v; return;
      case 1: fr.r1 = v; return;
      case 2: fr.r2 = v; return;
      default:
        throw new Error("[fuse L6] 槽位越界 " + i);
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
            "[fuse L6] 不认识的产生式 " + node.type +
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
          r0: undefined, r1: undefined, r2: undefined,
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
          "[fuse L6] 输入嵌套太深：" + whereOf(lastNode) +
            "。\n  融合遍历器的 identity 那条路不占原生栈，但 handler 里调 rec、子节点又有 handler 时会嵌套 —— 层数等于路径上带 handler 的节点数（t18 / t27）。",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  return { run, arity: K };
}

return build;
})();

const GT9 = (function () {
// 由 codegen 生成（融合 + 蹦床）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L6 → L7   （1 门融成 1 个遍历）
//
// 这里是**显式帧栈 + dispatch 循环**，不是递归下树：identity 那条路上一个 JS 栈帧都不占。
// handler 里的 rec 也接到同一个蹦床上（会开一层嵌套的 drive），所以子树遍历也是迭代的。
// 唯一还会占原生栈的是「handler 里调 rec、子节点又有 handler」这种嵌套 —— 层数等于
// 路径上带 handler 的节点数（见 t18 的注释）。
function build(handlersList, init) {
  // 一个组的结果属于**最后一门** pass 的输出语言 —— 不是第一门的
  const LANG = "L7";
  /** 列表逐元素比引用 —— "没改就复用"用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = 1;
  const idRec = (x) => x;

  const TAG_NT = {
    "Prog": "Program",
    "DefVal": "Def",
    "Param": "Param",
    "Clause": "Clause",
    "Bind": "Bind",
    "Void": "Expr",
    "Int": "Expr",
    "Float": "Expr",
    "Bool": "Expr",
    "Str": "Expr",
    "Var": "Expr",
    "If": "Expr",
    "Begin": "Expr",
    "Let": "Expr",
    "Letrec": "Expr",
    "Lam": "Expr",
    "Call": "Expr",
    "Prim": "Expr",
  };

  // tag → 子节点字段表（按声明顺序）。kind: n 单节点 / l 列表 / m 可选
  const FIELDS = {
    "Prog": [["defs","l"],["body","l"]],
    "DefVal": [["value","n"]],
    "Param": [],
    "Clause": [["test","n"],["body","n"]],
    "Bind": [["value","n"]],
    "Void": [],
    "Int": [],
    "Float": [],
    "Bool": [],
    "Str": [],
    "Var": [],
    "If": [["cond","n"],["then","n"],["alt","n"]],
    "Begin": [["exprs","l"]],
    "Let": [["bindings","l"],["body","n"]],
    "Letrec": [["bindings","l"],["body","n"]],
    "Lam": [["params","l"],["body","n"]],
    "Call": [["fn","n"],["args","l"]],
    "Prim": [["args","l"]],
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
    case "Prog":
      return { type: "Prog", "defs": fr.r0, "body": fr.r1 };
    case "DefVal":
      return { type: "DefVal", "name": n.name, "value": fr.r0 };
    case "Param":
      return { type: "Param", "name": n.name };
    case "Clause":
      return { type: "Clause", "test": fr.r0, "body": fr.r1 };
    case "Bind":
      return { type: "Bind", "name": n.name, "value": fr.r0 };
    case "Void":
      return { type: "Void" };
    case "Int":
      return { type: "Int", "value": n.value };
    case "Float":
      return { type: "Float", "value": n.value };
    case "Bool":
      return { type: "Bool", "value": n.value };
    case "Str":
      return { type: "Str", "value": n.value };
    case "Var":
      return { type: "Var", "name": n.name };
    case "If":
      return { type: "If", "cond": fr.r0, "then": fr.r1, "alt": fr.r2 };
    case "Begin":
      return { type: "Begin", "exprs": fr.r0 };
    case "Let":
      return { type: "Let", "bindings": fr.r0, "body": fr.r1 };
    case "Letrec":
      return { type: "Letrec", "bindings": fr.r0, "body": fr.r1 };
    case "Lam":
      return { type: "Lam", "params": fr.r0, "body": fr.r1 };
    case "Call":
      return { type: "Call", "fn": fr.r0, "args": fr.r1 };
    case "Prim":
      return { type: "Prim", "op": n.op, "args": fr.r0 };
    default:
      throw new Error("[fuse L6] 没有产生式 " + tag + " 的构造子");
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
      case 0: fr.r0 = v; return;
      case 1: fr.r1 = v; return;
      case 2: fr.r2 = v; return;
      default:
        throw new Error("[fuse L6] 槽位越界 " + i);
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
            "[fuse L6] 不认识的产生式 " + node.type +
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
          r0: undefined, r1: undefined, r2: undefined,
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
          "[fuse L6] 输入嵌套太深：" + whereOf(lastNode) +
            "。\n  融合遍历器的 identity 那条路不占原生栈，但 handler 里调 rec、子节点又有 handler 时会嵌套 —— 层数等于路径上带 handler 的节点数（t18 / t27）。",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  return { run, arity: K };
}

return build;
})();

const GT10 = (function () {
// 由 codegen 生成（融合 + 蹦床）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L7 → L7   （1 门融成 1 个遍历）
//
// 这里是**显式帧栈 + dispatch 循环**，不是递归下树：identity 那条路上一个 JS 栈帧都不占。
// handler 里的 rec 也接到同一个蹦床上（会开一层嵌套的 drive），所以子树遍历也是迭代的。
// 唯一还会占原生栈的是「handler 里调 rec、子节点又有 handler」这种嵌套 —— 层数等于
// 路径上带 handler 的节点数（见 t18 的注释）。
function build(handlersList, init) {
  // 一个组的结果属于**最后一门** pass 的输出语言 —— 不是第一门的
  const LANG = "L7";
  /** 列表逐元素比引用 —— "没改就复用"用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = 1;
  const idRec = (x) => x;

  const TAG_NT = {
    "Prog": "Program",
    "DefVal": "Def",
    "Param": "Param",
    "Clause": "Clause",
    "Bind": "Bind",
    "Void": "Expr",
    "Int": "Expr",
    "Float": "Expr",
    "Bool": "Expr",
    "Str": "Expr",
    "Var": "Expr",
    "If": "Expr",
    "Begin": "Expr",
    "Let": "Expr",
    "Letrec": "Expr",
    "Lam": "Expr",
    "Call": "Expr",
    "Prim": "Expr",
    "BindFree": "Body",
  };

  // tag → 子节点字段表（按声明顺序）。kind: n 单节点 / l 列表 / m 可选
  const FIELDS = {
    "Prog": [["defs","l"],["body","l"]],
    "DefVal": [["value","n"]],
    "Param": [],
    "Clause": [["test","n"],["body","n"]],
    "Bind": [["value","n"]],
    "Void": [],
    "Int": [],
    "Float": [],
    "Bool": [],
    "Str": [],
    "Var": [],
    "If": [["cond","n"],["then","n"],["alt","n"]],
    "Begin": [["exprs","l"]],
    "Let": [["bindings","l"],["body","n"]],
    "Letrec": [["bindings","l"],["body","n"]],
    "Lam": [["params","l"],["body","n"]],
    "Call": [["fn","n"],["args","l"]],
    "Prim": [["args","l"]],
    "BindFree": [["body","n"]],
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
    case "Prog":
      return (!sameList(fr.r0, n.defs) || !sameList(fr.r1, n.body)) ? { type: "Prog", "defs": fr.r0, "body": fr.r1 } : n;
    case "DefVal":
      return (fr.r0 !== n.value) ? { type: "DefVal", "name": n.name, "value": fr.r0 } : n;
    case "Param":
      return n;
    case "Clause":
      return (fr.r0 !== n.test || fr.r1 !== n.body) ? { type: "Clause", "test": fr.r0, "body": fr.r1 } : n;
    case "Bind":
      return (fr.r0 !== n.value) ? { type: "Bind", "name": n.name, "value": fr.r0 } : n;
    case "Void":
      return n;
    case "Int":
      return n;
    case "Float":
      return n;
    case "Bool":
      return n;
    case "Str":
      return n;
    case "Var":
      return n;
    case "If":
      return (fr.r0 !== n.cond || fr.r1 !== n.then || fr.r2 !== n.alt) ? { type: "If", "cond": fr.r0, "then": fr.r1, "alt": fr.r2 } : n;
    case "Begin":
      return (!sameList(fr.r0, n.exprs)) ? { type: "Begin", "exprs": fr.r0 } : n;
    case "Let":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Let", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Letrec":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Letrec", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Lam":
      return (!sameList(fr.r0, n.params) || fr.r1 !== n.body) ? { type: "Lam", "params": fr.r0, "body": fr.r1 } : n;
    case "Call":
      return (fr.r0 !== n.fn || !sameList(fr.r1, n.args)) ? { type: "Call", "fn": fr.r0, "args": fr.r1 } : n;
    case "Prim":
      return (!sameList(fr.r0, n.args)) ? { type: "Prim", "op": n.op, "args": fr.r0 } : n;
    case "BindFree":
      return (fr.r0 !== n.body) ? { type: "BindFree", "names": n.names, "body": fr.r0 } : n;
    default:
      throw new Error("[fuse L7] 没有产生式 " + tag + " 的构造子");
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
      case 0: fr.r0 = v; return;
      case 1: fr.r1 = v; return;
      case 2: fr.r2 = v; return;
      default:
        throw new Error("[fuse L7] 槽位越界 " + i);
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
            "[fuse L7] 不认识的产生式 " + node.type +
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
          r0: undefined, r1: undefined, r2: undefined,
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
          "[fuse L7] 输入嵌套太深：" + whereOf(lastNode) +
            "。\n  融合遍历器的 identity 那条路不占原生栈，但 handler 里调 rec、子节点又有 handler 时会嵌套 —— 层数等于路径上带 handler 的节点数（t18 / t27）。",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  return { run, arity: K };
}

return build;
})();

const GT11 = (function () {
// 由 codegen 生成（融合 + 蹦床）。不要手改。改语言声明或 pass 的规则，然后重新生成。
//   L7 → L7   （1 门融成 1 个遍历）
//
// 这里是**显式帧栈 + dispatch 循环**，不是递归下树：identity 那条路上一个 JS 栈帧都不占。
// handler 里的 rec 也接到同一个蹦床上（会开一层嵌套的 drive），所以子树遍历也是迭代的。
// 唯一还会占原生栈的是「handler 里调 rec、子节点又有 handler」这种嵌套 —— 层数等于
// 路径上带 handler 的节点数（见 t18 的注释）。
function build(handlersList, init) {
  // 一个组的结果属于**最后一门** pass 的输出语言 —— 不是第一门的
  const LANG = "L7";
  /** 列表逐元素比引用 —— "没改就复用"用。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const K = 0;
  const idRec = (x) => x;

  const TAG_NT = {
    "Prog": "Program",
    "DefVal": "Def",
    "Param": "Param",
    "Clause": "Clause",
    "Bind": "Bind",
    "Void": "Expr",
    "Int": "Expr",
    "Float": "Expr",
    "Bool": "Expr",
    "Str": "Expr",
    "Var": "Expr",
    "If": "Expr",
    "Begin": "Expr",
    "Let": "Expr",
    "Letrec": "Expr",
    "Lam": "Expr",
    "Call": "Expr",
    "Prim": "Expr",
    "BindFree": "Body",
  };

  // tag → 子节点字段表（按声明顺序）。kind: n 单节点 / l 列表 / m 可选
  const FIELDS = {
    "Prog": [["defs","l"],["body","l"]],
    "DefVal": [["value","n"]],
    "Param": [],
    "Clause": [["test","n"],["body","n"]],
    "Bind": [["value","n"]],
    "Void": [],
    "Int": [],
    "Float": [],
    "Bool": [],
    "Str": [],
    "Var": [],
    "If": [["cond","n"],["then","n"],["alt","n"]],
    "Begin": [["exprs","l"]],
    "Let": [["bindings","l"],["body","n"]],
    "Letrec": [["bindings","l"],["body","n"]],
    "Lam": [["params","l"],["body","n"]],
    "Call": [["fn","n"],["args","l"]],
    "Prim": [["args","l"]],
    "BindFree": [["body","n"]],
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
    case "Prog":
      return (!sameList(fr.r0, n.defs) || !sameList(fr.r1, n.body)) ? { type: "Prog", "defs": fr.r0, "body": fr.r1 } : n;
    case "DefVal":
      return (fr.r0 !== n.value) ? { type: "DefVal", "name": n.name, "value": fr.r0 } : n;
    case "Param":
      return n;
    case "Clause":
      return (fr.r0 !== n.test || fr.r1 !== n.body) ? { type: "Clause", "test": fr.r0, "body": fr.r1 } : n;
    case "Bind":
      return (fr.r0 !== n.value) ? { type: "Bind", "name": n.name, "value": fr.r0 } : n;
    case "Void":
      return n;
    case "Int":
      return n;
    case "Float":
      return n;
    case "Bool":
      return n;
    case "Str":
      return n;
    case "Var":
      return n;
    case "If":
      return (fr.r0 !== n.cond || fr.r1 !== n.then || fr.r2 !== n.alt) ? { type: "If", "cond": fr.r0, "then": fr.r1, "alt": fr.r2 } : n;
    case "Begin":
      return (!sameList(fr.r0, n.exprs)) ? { type: "Begin", "exprs": fr.r0 } : n;
    case "Let":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Let", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Letrec":
      return (!sameList(fr.r0, n.bindings) || fr.r1 !== n.body) ? { type: "Letrec", "bindings": fr.r0, "body": fr.r1 } : n;
    case "Lam":
      return (!sameList(fr.r0, n.params) || fr.r1 !== n.body) ? { type: "Lam", "params": fr.r0, "body": fr.r1 } : n;
    case "Call":
      return (fr.r0 !== n.fn || !sameList(fr.r1, n.args)) ? { type: "Call", "fn": fr.r0, "args": fr.r1 } : n;
    case "Prim":
      return (!sameList(fr.r0, n.args)) ? { type: "Prim", "op": n.op, "args": fr.r0 } : n;
    case "BindFree":
      return (fr.r0 !== n.body) ? { type: "BindFree", "names": n.names, "body": fr.r0 } : n;
    default:
      throw new Error("[fuse L7] 没有产生式 " + tag + " 的构造子");
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
      case 0: fr.r0 = v; return;
      case 1: fr.r1 = v; return;
      case 2: fr.r2 = v; return;
      default:
        throw new Error("[fuse L7] 槽位越界 " + i);
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
            "[fuse L7] 不认识的产生式 " + node.type +
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
          r0: undefined, r1: undefined, r2: undefined,
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
          "[fuse L7] 输入嵌套太深：" + whereOf(lastNode) +
            "。\n  融合遍历器的 identity 那条路不占原生栈，但 handler 里调 rec、子节点又有 handler 时会嵌套 —— 层数等于路径上带 handler 的节点数（t18 / t27）。",
        );
        err.name = "StackOverflow";
        throw err;
      }
      throw e;
    }
  }

  return { run, arity: K };
}

return build;
})();

/** 第 i 步的 handler 表 / extra 初值 —— 从管线声明上取，不在这里复制。 */
const rulesOf = (i) => MAIN.steps[i].spec.rules;
const initOf = (i) => MAIN.steps[i].spec.init ?? (() => []);

/**
 * 一步怎么跑。
 *
 *   - 普通 pass：遍历器（PW i）就全部
 *   - **loop 步**（不动点 / 重写规则）：遍历器 + 一层循环，循环的语义从 loops.ts 拿
 *     （只有一份实现，产物不复制它）
 *   - opaque 又没有 loop 的（整程序分析那种）：它的逻辑不在 spec 里，只能调它的 run
 */
const stepRun = [
  (x) => PW0(rulesOf(0), initOf(0)).run(x),
  (x) => PW1(rulesOf(1), initOf(1)).run(x),
  (x) => PW2(rulesOf(2), initOf(2)).run(x),
  (x) => PW3(rulesOf(3), initOf(3)).run(x),
  (x) => PW4(rulesOf(4), initOf(4)).run(x),
  (x) => PW5(rulesOf(5), initOf(5)).run(x),
  (x) => PW6(rulesOf(6), initOf(6)).run(x),
  (x) => PW7(rulesOf(7), initOf(7)).run(x),
  (x) => { MAIN.steps[8].loop.setup?.(x); const w = PW8(rulesOf(8), initOf(8)); return rewriteLoop((y) => w.run(y), "algebraic-simplify")(x); },
  (x) => PW9(rulesOf(9), initOf(9)).run(x),
  (x) => PW10(rulesOf(10), initOf(10)).run(x),
  (x) => { MAIN.steps[11].loop.setup?.(x); const w = PW11(rulesOf(11), initOf(11)); return fixpointLoop((y) => w.run(y), 100, "global-const")(x); },
  (x) => PW12(rulesOf(12), initOf(12)).run(x),
  (x) => PW13(rulesOf(13), initOf(13)).run(x),
  (x) => PW14(rulesOf(14), initOf(14)).run(x),
  (x) => PW15(rulesOf(15), initOf(15)).run(x),
];

/** 融合：每组的递归版（快）和蹦床版（深）。 */
const groupFast = [
  (x) => PW0(rulesOf(0), initOf(0)).run(x),
  (x) => GR1([rulesOf(1), rulesOf(2), rulesOf(3)], initOf(1)).run(x),
  (x) => PW4(rulesOf(4), initOf(4)).run(x),
  (x) => GR3([rulesOf(5), rulesOf(6), rulesOf(7)], initOf(5)).run(x),
  (x) => { MAIN.steps[8].loop.setup?.(x); const w = PW8(rulesOf(8), initOf(8)); return rewriteLoop((y) => w.run(y), "algebraic-simplify")(x); },
  (x) => PW9(rulesOf(9), initOf(9)).run(x),
  (x) => PW10(rulesOf(10), initOf(10)).run(x),
  (x) => { MAIN.steps[11].loop.setup?.(x); const w = PW11(rulesOf(11), initOf(11)); return fixpointLoop((y) => w.run(y), 100, "global-const")(x); },
  (x) => PW12(rulesOf(12), initOf(12)).run(x),
  (x) => PW13(rulesOf(13), initOf(13)).run(x),
  (x) => PW14(rulesOf(14), initOf(14)).run(x),
  (x) => PW15(rulesOf(15), initOf(15)).run(x),
];
/**
 * 兜底变体（蹦床）。**没有兜底的组是 null** —— 见 runGroup。
 */
const groupSlow = [
  (x) => GT0([rulesOf(0)], initOf(0)).run(x),
  (x) => GT1([rulesOf(1), rulesOf(2), rulesOf(3)], initOf(1)).run(x),
  (x) => GT2([rulesOf(4)], initOf(4)).run(x),
  (x) => GT3([rulesOf(5), rulesOf(6), rulesOf(7)], initOf(5)).run(x),
  (x) => { MAIN.steps[8].loop.setup?.(x); const w = GT4([rulesOf(8)], initOf(8)); return rewriteLoop((y) => w.run(y), "algebraic-simplify")(x); },
  (x) => GT5([rulesOf(9)], initOf(9)).run(x),
  (x) => GT6([rulesOf(10)], initOf(10)).run(x),
  (x) => { MAIN.steps[11].loop.setup?.(x); const w = GT7([rulesOf(11)], initOf(11)); return fixpointLoop((y) => w.run(y), 100, "global-const")(x); },
  (x) => GT8([rulesOf(12)], initOf(12)).run(x),
  (x) => GT9([rulesOf(13)], initOf(13)).run(x),
  (x) => GT10([rulesOf(14)], initOf(14)).run(x),
  (x) => GT11([rulesOf(15)], initOf(15)).run(x),
];

/**
 * 兜底触发过哪些组（可观察，给测试和诊断用）。
 */
export const fallbacks = [];

/**
 * 逐组兜底：默认走递归（快），某一组溢出就**只把那一组**换成蹦床版重跑。
 *
 * 认出"溢出"靠生成的 guard 打的 `name = "StackOverflow"`（不是匹配报错文本 ——
 * 文本是给人看的、本来就该能改）。只兜一次：蹦床也溢出就把它的报错原样抛出，
 * 那条限制（handler 嵌套太深）是真的。
 */
function runGroup(g, x) {
  const slow = groupSlow[g];
  if (slow === null) return groupFast[g](x); // 没有兜底变体（手搭的 Step）
  try {
    return groupFast[g](x);
  } catch (e) {
    const overflow = e instanceof RangeError || (e instanceof Error && e.name === "StackOverflow");
    if (!overflow) throw e;
    fallbacks.push(g);
    return slow(x);
  }
}

/** 整条管线：融合 + 逐组兜底。 */
export function run(ast) {
  let cur = ast;
  for (let g = 0; g < groupFast.length; g++) cur = runGroup(g, cur);
  return cur;
}

/**
 * 跑 steps 里的 [from, to) 这一段。
 *
 * 为什么要区间而不只是前缀：e2e 里有一条检查是"**去糖那一段**重跑一遍不该变"——
 * 它跑的不是第 0..k 步，而是中间的一段（从 Lsrc 那一步开始）。只有前缀的话那条检查
 * 会把整条管线从头再跑一遍，喂进去的是已经处理过的树，直接炸。
 */
export function runRange(ast, from, to) {
  let cur = ast;
  for (let i = from; i < to; i++) cur = stepRun[i](cur);
  return cur;
}

/** 跑前 k 步（perf 按前缀量每个 pass 用）。 */
export function runPrefix(ast, k) {
  return runRange(ast, 0, k);
}

/** 不融合：逐步跑，把每一步的产物留下（第 0 步是输入）。 */
export function runStages(ast) {
  const out = [{ name: "(输入)", lang: "Lnum", ast }];
  let cur = ast;
  for (let i = 0; i < stepRun.length; i++) {
    cur = stepRun[i](cur);
    out.push({ name: MAIN.steps[i].name, lang: MAIN.steps[i].to, ast: cur });
  }
  return out;
}
