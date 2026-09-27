/**
 * S 表达式 → **Lnum** AST。
 *
 * 这一层认识 Lnum 的糖：if / cond / and / or / let* / lambda / define …… 全都建出来。
 * 它的输出受 Lnum 的类型检查，所以语言声明一改，这里当场编译不过 —— 不会漂移。
 *
 * **产出 Lnum 而不是 Lsrc**（t15）：数字是一笼统的 `Num { value, repr }`。
 * 读入器知道的只是"源码里写的是什么"（`repr`），"这是 Int 还是 Float"是后面
 * `refine-repr` 那一步在类型环境里做的判断。见 langs/Lnum.lang.ts 的文件头。
 *
 * 每个节点都贴上 __meta__（行、列）。框架负责把它一路搬到输出节点，所以报错能说
 * "第 2 行的这个形式"，不是说"某个节点"。
 */

import type { NodeOf } from "../src/lang.ts";
import { Lnum } from "./langs/Lnum.lang.ts";
import {
  describe,
  isSymbol,
  symbolOf,
  SyntaxError_,
  unparse,
  type Loc,
  type Sexp,
  type SList,
} from "./s-expr.ts";

type Program = NodeOf<typeof Lnum, "Program">;
type Def = NodeOf<typeof Lnum, "Def">;
type Param = NodeOf<typeof Lnum, "Param">;
type Clause = NodeOf<typeof Lnum, "Clause">;
type Bind = NodeOf<typeof Lnum, "Bind">;
type Expr = NodeOf<typeof Lnum, "Expr">;

/** 把位置贴到节点上。节点类型里没有 __meta__（塞进去会撑爆 TS 的递归），所以在边界贴。 */
function at<T extends object>(node: T, where: Loc, file: string): T {
  return Object.assign(node, { __meta__: { file, line: where.line, col: where.col } });
}

function needList(x: Sexp, where: string): SList {
  if (x.kind !== "list") throw new SyntaxError_(`${where}: 期望一个 (...) 形式，拿到 ${describe(x)}`);
  return x;
}

function needAtom(x: Sexp, where: string, depth = 0): Expr {
  const list = x.kind === "atom" ? x : null;
  if (list === null) return buildExpr(x, where);
  const loc = `${where} 的 ${unparse(x)}`;
  if (typeof list.value === "boolean") return at<Expr>({ type: "Bool", value: list.value }, x.loc, where);
  if (typeof list.value === "number") {
    // 只记下"值"和"源码里怎么写" —— 分 Int/Float 是 refine-repr 的事
    return at<Expr>({ type: "Num", value: list.value, repr: list.raw }, x.loc, where);
  }
  if (list.raw.startsWith('"')) return at<Expr>({ type: "Str", value: list.value }, x.loc, where);
  return at<Expr>({ type: "Var", name: list.value }, x.loc, where);
}

function buildParams(x: Sexp, where: string, depth = 0): Param[] {
  const list = needList(x, where);
  return list.items.map((it) => {
    const name = symbolOf(it, `${where} 的参数表`);
    return at<Param>({ type: "Param", name }, it.loc, where);
  });
}

function buildBinds(x: Sexp, where: string, depth = 0): Bind[] {
  const list = needList(x, where);
  return list.items.map((it) => {
    const pair = needList(it, `${where} 的绑定`);
    if (pair.items.length !== 2) {
      throw new SyntaxError_(`${where}: 绑定 ${unparse(it)} 要正好两个元素 (名字 值)`);
    }
    const name = symbolOf(pair.items[0]!, `${where} 的绑定名`);
    const value = buildExpr(pair.items[1]!, where);
    return at<Bind>({ type: "Bind", name, value }, it.loc, where);
  });
}

/**
 * 建 AST。
 *
 * 深度是**当参数传**的，不是模块级计数器 —— 单帧，而且不用 try/finally。
 * 拆成两层函数再 try/finally 会每层多一个栈帧，容量直接砍半（实测 2.6 万 → 1.3 万）。
 *
 * 深度只用来在栈溢出时报位置，不做限制：真正的边界取决于输入形状，定阈值会误杀
 * 跑得过的输入。
 */
// 只在报错时读，所以只是两个"记录最深"的槽，不是线程模型。
let buildMaxDepth = 0;
let buildDeepest: Loc = { line: 0, col: 0 };

function buildExpr(x: Sexp, file: string, depth = 0): Expr {
  if (depth > buildMaxDepth) {
    buildMaxDepth = depth;
    buildDeepest = x.loc;
  }
  if (x.kind === "atom") return needAtom(x, file);

  const items = x.items;
  if (items.length === 0) throw new SyntaxError_(`${file}: 空的 () 不是表达式`);

  const head = items[0]!;
  const args = items.slice(1);
  const where = `${file}:${x.loc.line}`;

  const err = (n: number): never => {
    throw new SyntaxError_(
      `${where}: ${head.kind === "atom" ? String(head.value) : describe(head)} 要 ${n} 个操作数，拿到 ${args.length}`,
    );
  };

  if (head.kind === "atom" && typeof head.value === "string") {
    const op = head.value;
    switch (op) {
      case "if": {
        if (args.length === 3) {
          return at(
            {
              type: "If",
              cond: buildExpr(args[0]!, file, depth + 1),
              then: buildExpr(args[1]!, file, depth + 1),
              alt: buildExpr(args[2]!, file, depth + 1),
            } satisfies Expr,
            x.loc,
            file,
          );
        }
        if (args.length === 2) {
          return at(
            {
              type: "IfAlt",
              cond: buildExpr(args[0]!, file, depth + 1),
              then: buildExpr(args[1]!, file, depth + 1),
            } satisfies Expr,
            x.loc,
            file,
          );
        }
        return err(3);
      }
      case "when":
        if (args.length !== 2) return err(2);
        return at(
          {
            type: "When",
            cond: buildExpr(args[0]!, file, depth + 1),
            body: buildExpr(args[1]!, file, depth + 1),
          } satisfies Expr,
          x.loc,
          file,
        );
      case "unless":
        if (args.length !== 2) return err(2);
        return at(
          {
            type: "Unless",
            cond: buildExpr(args[0]!, file, depth + 1),
            body: buildExpr(args[1]!, file, depth + 1),
          } satisfies Expr,
          x.loc,
          file,
        );
      case "cond": {
        // 一个分支都没有是**没有意义**的，不是"退化成一个空值"：
        // 它不表示任何东西，而这个语言里"什么都不做"要显式写 (void)。
        // （只有一个 else 是合法的，那表示"无条件取这个值"。）
        if (args.length === 0) throw new SyntaxError_(`${where}: (cond) 至少要有一个分支`);
        const clauses: Clause[] = [];
        let els: Expr | undefined;
        for (const c of args) {
          const pair = needList(c, `${where}: cond 的分支`);
          if (pair.items.length !== 2)
            throw new SyntaxError_(`${where}: cond 分支 ${unparse(c)} 要正好两个元素 (条件 值)`);
          if (isSymbol(pair.items[0]!, "else")) {
            if (els !== undefined) throw new SyntaxError_(`${where}: cond 里有多个 else`);
            els = buildExpr(pair.items[1]!, file, depth + 1);
            continue;
          }
          if (els !== undefined) throw new SyntaxError_(`${where}: else 之后还有分支`);
          clauses.push(
            at(
              {
                type: "Clause",
                test: buildExpr(pair.items[0]!, file, depth + 1),
                body: buildExpr(pair.items[1]!, file, depth + 1),
              } satisfies Clause,
              c.loc,
              file,
            ),
          );
        }
        return at<Expr>({ type: "Cond", clauses, else: els }, x.loc, file);
      }
      case "and":
        return at<Expr>({ type: "And", exprs: args.map((a) => buildExpr(a, file, depth + 1)) }, x.loc, file);
      case "or":
        return at<Expr>({ type: "Or", exprs: args.map((a) => buildExpr(a, file, depth + 1)) }, x.loc, file);
      case "not":
        if (args.length !== 1) return err(1);
        return at<Expr>({ type: "Not", expr: buildExpr(args[0]!, file, depth + 1) }, x.loc, file);
      case "begin":
        return at<Expr>(
          { type: "Begin", exprs: args.map((a) => buildExpr(a, file, depth + 1)) },
          x.loc,
          file,
        );
      case "let":
      case "let*":
      case "letrec": {
        if (args.length !== 2) throw new SyntaxError_(`${where}: ${op} 要 (绑定表) 和 一个体`);
        const bindings = buildBinds(args[0]!, `${where}: ${op} 的绑定表`);
        const body = buildExpr(args[1]!, file, depth + 1);
        const tag = op === "let" ? "Let" : op === "let*" ? "LetStar" : "Letrec";
        return at<Expr>({ type: tag, bindings, body }, x.loc, file);
      }
      case "lambda": {
        if (args.length !== 2) throw new SyntaxError_(`${where}: lambda 要 (参数表) 和 一个体`);
        const params = buildParams(args[0]!, `${where}: lambda 的参数表`);
        return at<Expr>({ type: "Lam", params, body: buildExpr(args[1]!, file, depth + 1) }, x.loc, file);
      }
      default:
        break;
    }

    // 原语
    if (PRIMITIVES.has(op)) {
      return at<Expr>(
        { type: "Prim", op, args: args.map((a) => buildExpr(a, file, depth + 1)) },
        x.loc,
        file,
      );
    }

    // 剩下的都是调用
    return at(
      {
        type: "Call",
        fn: buildExpr(head, file, depth + 1),
        args: args.map((a) => buildExpr(a, file, depth + 1)),
      } satisfies Expr,
      x.loc,
      file,
    );
  }

  // 头不是符号，就是调用
  return at(
    {
      type: "Call",
      fn: buildExpr(head, file, depth + 1),
      args: args.map((a) => buildExpr(a, file, depth + 1)),
    } satisfies Expr,
    x.loc,
    file,
  );
}

/** 解释器必须认识这些。改这里要同时改 Lcore 和解释器。 */
export const PRIMITIVES = new Set(["+", "-", "*", "/", "<", "=", "modulo"]);

function buildDef(x: Sexp, file: string, depth = 0): Def {
  const list = needList(x, `${file}: define`);
  const parts = list.items;
  if (parts.length < 3) throw new SyntaxError_(`${file}: define 至少要有名字和一个体: ${unparse(x)}`);
  if (!isSymbol(parts[0]!, "define"))
    throw new SyntaxError_(`${file}: 期望 define，拿到 ${describe(parts[0]!)}`);

  const nameSexp = parts[1]!;
  const where = `${file}:${list.loc.line}`;

  // (define (f x) e)  —— 函数定义
  if (nameSexp.kind === "list") {
    const sig = nameSexp.items;
    if (sig.length === 0) throw new SyntaxError_(`${where}: define 的函数名空了`);
    const name = symbolOf(sig[0]!, `${where}: 函数名`);
    const params = sig.slice(1).map((p) => {
      const pn = symbolOf(p, `${where}: ${name} 的参数`);
      return at<Param>({ type: "Param", name: pn }, p.loc, file);
    });
    if (parts.length !== 3) throw new SyntaxError_(`${where}: (define (${name} ...) ...) 只能有一个体`);
    return at<Def>(
      { type: "DefFun", name, params, body: buildExpr(parts[2]!, file, depth + 1) },
      list.loc,
      file,
    );
  }

  // (define f e) —— 变量定义
  const name = symbolOf(nameSexp, `${where}: define 的名字`);
  if (parts.length !== 3) throw new SyntaxError_(`${where}: (define ${name} ...) 只能有一个体`);
  return at<Def>({ type: "DefVal", name, value: buildExpr(parts[2]!, file, depth + 1) }, list.loc, file);
}

/**
 * 顶层：前面的 (define ...) 是定义，剩下的是体。
 * 定义出现在非定义之后 —— 报错，不猜。
 */
export function readProgram(forms: Sexp[], file: string): Program {
  buildMaxDepth = 0;
  buildDeepest = { line: 1, col: 1 };
  try {
    return readProgramInner(forms, file);
  } catch (e) {
    if (e instanceof RangeError && /stack/i.test(String(e.message))) {
      throw new SyntaxError_(
        `${file}:${buildDeepest.line}:${buildDeepest.col}: 嵌套太深（走到 ${buildMaxDepth} 层就溢出了）。\n` +
          `  建 AST 也是递归下树的，深度受 JS 调用栈限制。这是已知限制（t27）。`,
      );
    }
    throw e;
  }
}

function readProgramInner(forms: Sexp[], file: string): Program {
  const defs: Def[] = [];
  const body: Expr[] = [];
  let sawBody = false;
  let where: Loc = { line: 1, col: 1 };

  for (const f of forms) {
    where = f.loc;
    if (f.kind === "list" && isSymbol(f.items[0]!, "define")) {
      if (sawBody) {
        throw new SyntaxError_(`${file}:${f.loc.line}: define 出现在其它表达式之后。定义要放在前面。`);
      }
      defs.push(buildDef(f, file));
      continue;
    }
    sawBody = true;
    body.push(buildExpr(f, file));
  }

  return at<Program>({ type: "Prog", defs, body }, where, file);
}
