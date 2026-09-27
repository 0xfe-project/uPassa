/**
 * 纯 s-expr 的读入：源码 → S 表达式（带位置）。
 *
 * 这一层不认识 Lsrc，也不认识任何语言 —— 它只管括号、字符串、原子、注释。
 * 把形式变成 AST 是 reader.ts 的事。
 *
 * 位置是给 __meta__ 用的：报错要能说"第 2 行的这个形式"，而不是"某个节点"。
 */

export interface Loc {
  readonly line: number;
  readonly col: number;
}

export interface Atom {
  readonly kind: "atom";
  readonly value: string | number | boolean;
  /** 原文。`1` 和 `1.0` 值相同但写法不同 —— Int / Float 得靠它分。 */
  readonly raw: string;
  readonly loc: Loc;
}

export interface SList {
  readonly kind: "list";
  readonly items: Sexp[];
  readonly loc: Loc;
}

export type Sexp = Atom | SList;

export class SyntaxError_ extends Error {}

/** 这个原子是不是 `symbol`？（用来认 if / lambda / + 这些形式头） */
export function isSymbol(x: Sexp, name: string): boolean {
  return x.kind === "atom" && x.value === name;
}

/** 取一个原子的符号名。不是符号就报错。 */
export function symbolOf(x: Sexp, where: string): string {
  if (x.kind !== "atom" || typeof x.value !== "string") {
    throw new SyntaxError_(`${where}: 期望一个符号，拿到 ${describe(x)}`);
  }
  return x.value;
}

export function describe(x: Sexp): string {
  if (x.kind === "atom") return typeof x.value === "string" ? x.value : String(x.value);
  return `(${x.items.map(describe).join(" ")})`;
}

/**
 * 把 S 表达式原样印回源码。用来在报错里显示"你写的那个形式"。
 * 带位置的不印 —— 那对读报错的人没意义。
 */
export function unparse(x: Sexp): string {
  if (x.kind === "atom") {
    if (typeof x.value === "string") return x.value;
    if (typeof x.value === "boolean") return x.value ? "#t" : "#f";
    return String(x.value);
  }
  return `(${x.items.map(unparse).join(" ")})`;
}

// ───────────────────────── 分词 ─────────────────────────

type Token =
  | { kind: "lparen"; line: number; col: number }
  | { kind: "rparen"; line: number; col: number }
  | { kind: "atom"; text: string; line: number; col: number };

const DELIM = new Set(["(", ")", "[", "]", '"', ";"]);

function tokenize(source: string, file: string): Token[] {
  const ts: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const bump = (): void => {
    if (source[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
    i++;
  };

  while (i < source.length) {
    const c = source[i]!;

    if (c === "\n" || c === " " || c === "\t" || c === "\r") {
      bump();
      continue;
    }

    // 行注释
    if (c === ";") {
      while (i < source.length && source[i] !== "\n") bump();
      continue;
    }

    if (c === "(" || c === "[") {
      ts.push({ kind: "lparen", line, col });
      bump();
      continue;
    }
    if (c === ")" || c === "]") {
      ts.push({ kind: "rparen", line, col });
      bump();
      continue;
    }

    if (c === '"') {
      const startLine = line;
      const startCol = col;
      bump(); // 开引号
      let text = "";
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") {
          bump();
          const esc = source[i];
          if (esc === "n") text += "\n";
          else if (esc === "t") text += "\t";
          else if (esc === "\\") text += "\\";
          else if (esc === '"') text += '"';
          else throw new SyntaxError_(`${file}:${startLine}: 不认识的转义 \\${esc ?? ""}`);
          bump();
        } else {
          text += source[i];
          bump();
        }
      }
      if (i >= source.length) throw new SyntaxError_(`${file}:${startLine}: 字符串没闭合`);
      bump(); // 闭引号
      // 字符串原子用 JSON 编码存，避免和符号名混淆
      ts.push({ kind: "atom", text: JSON.stringify(text), line: startLine, col: startCol });
      continue;
    }

    // 其它：读到分隔符为止
    const startLine = line;
    const startCol = col;
    let text = "";
    while (i < source.length && !DELIM.has(source[i]!) && !/\s/.test(source[i]!)) {
      text += source[i];
      bump();
    }
    ts.push({ kind: "atom", text, line: startLine, col: startCol });
  }

  return ts;
}

// ───────────────────────── 原子 → 值 ─────────────────────────

const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/;

function atomValue(text: string, file: string, loc: Loc): string | number | boolean {
  if (text.startsWith('"')) return JSON.parse(text) as string; // 字符串（上面 JSON 编码过）
  if (text === "#t") return true;
  if (text === "#f") return false;
  if (INT_RE.test(text)) return Number(text);
  if (FLOAT_RE.test(text)) return Number(text);
  return text; // 符号
}

/** 这个原子是浮点字面量吗？（INT_RE 与 FLOAT_RE 不重叠） */
export function looksFloat(text: string): boolean {
  return FLOAT_RE.test(text);
}

// ───────────────────────── 解析 ─────────────────────────

export interface Parsed {
  readonly forms: Sexp[];
  readonly file: string;
}

/**
 * 解析时追踪嵌套深度，只为了在栈溢出时能报出位置。
 *
 * 为什么不做限制、只报错：真正的边界取决于输入形状，定阈值会误杀跑得过的输入。
 * 实测边界：约 5 万层括号（parse）、约 2 万层嵌套表达式（readProgram/readProgram 的
 * buildExpr）、约 1 万层（生成的遍历器）。三条都是递归下树造成的 —— 见 t27。
 */
let parseDepth = 0;
let parseMaxDepth = 0;
let parseDeepest: Loc = { line: 0, col: 0 };

export function parse(source: string, file: string): Parsed {
  parseDepth = 0;
  parseMaxDepth = 0;
  parseDeepest = { line: 0, col: 0 };
  try {
    return parseInner(source, file);
  } catch (e) {
    if (e instanceof RangeError && /stack/i.test(String(e.message))) {
      throw new SyntaxError_(
        `${file}:${parseDeepest.line}:${parseDeepest.col}: 嵌套太深（走到 ${parseMaxDepth} 层就溢出了）。\n` +
          `  解析器是递归下树的，深度受 JS 调用栈限制。这是已知限制（t27）。`,
      );
    }
    throw e;
  }
}

function parseInner(source: string, file: string): Parsed {
  const ts = tokenize(source, file);
  let p = 0;

  function readOne(): Sexp {
    const t = ts[p];
    if (t === undefined) throw new SyntaxError_(`${file}: 输入意外结束`);

    if (t.kind === "atom") {
      p++;
      const loc = { line: t.line, col: t.col };
      return { kind: "atom", value: atomValue(t.text, file, loc), raw: t.text, loc };
    }

    if (t.kind === "rparen") {
      throw new SyntaxError_(`${file}:${t.line}:${t.col}: 多了一个 ${`')'`}`);
    }

    // 左括号 —— 这是唯一会递归的分支，深度就在这儿记。
    // 刻意**不**拆成两层函数再 try/finally：那样每层多一个栈帧，容量会从约 5 万
    // 掉到约 1.6 万。深度只在报错时读，所以中途抛异常不回填也没关系。
    p++;
    const loc = { line: t.line, col: t.col };
    parseDepth++;
    if (parseDepth > parseMaxDepth) {
      parseMaxDepth = parseDepth;
      parseDeepest = loc;
    }
    const items: Sexp[] = [];
    for (;;) {
      const n = ts[p];
      if (n === undefined) {
        throw new SyntaxError_(`${file}:${loc.line}:${loc.col}: 括号没闭合`);
      }
      if (n.kind === "rparen") {
        p++;
        break;
      }
      items.push(readOne());
    }
    parseDepth--;
    return { kind: "list", items, loc };
  }

  const forms: Sexp[] = [];
  while (p < ts.length) forms.push(readOne());
  return { forms, file };
}
