/**
 * Reader for the micro-Scheme source language.
 *
 * Deliberately small: integers, booleans, symbols, lists, and `;` comments. Nothing else — the
 * point of this compiler is the pipeline behind it, not the surface syntax.
 *
 * It tracks line and column so a malformed program points at the place it went wrong rather than
 * saying "unexpected token" and leaving you to count parentheses.
 */

// ───────────────────────── Syntax ─────────────────────────

export type SExpr =
  | { kind: "int"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "symbol"; name: string }
  | { kind: "list"; items: SExpr[] };

export function isList(e: SExpr): e is Extract<SExpr, { kind: "list" }> {
  return e.kind === "list";
}

export function isSymbol(e: SExpr, name?: string): e is Extract<SExpr, { kind: "symbol" }> {
  return e.kind === "symbol" && (name === undefined || e.name === name);
}

/** The items of a list, for the common `(head ...)` shape. */
export function items(e: SExpr): SExpr[] {
  if (!isList(e)) throw new Error(`expected a list, got ${print(e)}`);
  return e.items;
}

/** A short rendering, used in error messages and test output. */
export function print(e: SExpr): string {
  switch (e.kind) {
    case "int":
      return String(e.value);
    case "bool":
      return e.value ? "#t" : "#f";
    case "symbol":
      return e.name;
    case "list":
      return `(${e.items.map(print).join(" ")})`;
  }
}

// ───────────────────────── Errors ─────────────────────────

export class ReadError extends Error {
  readonly line: number;
  readonly col: number;

  constructor(message: string, line: number, col: number) {
    super(`${message} (line ${line}, column ${col})`);
    this.name = "ReadError";
    this.line = line;
    this.col = col;
  }
}

// ───────────────────────── Reader ─────────────────────────

class Reader {
  private readonly src: string;
  private pos = 0;
  private line = 1;
  private col = 1;

  constructor(src: string) {
    this.src = src;
  }

  private atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  private peek(): string {
    return this.src[this.pos] ?? "";
  }

  private next(): string {
    const c = this.src[this.pos++] ?? "";
    if (c === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return c;
  }

  private skipSpace(): void {
    for (;;) {
      const c = this.peek();
      if (c === "") return;
      if (c === ";") {
        while (!this.atEnd() && this.peek() !== "\n") this.next();
        continue;
      }
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
        this.next();
        continue;
      }
      return;
    }
  }

  /** Read every top-level form in the source. */
  readAll(): SExpr[] {
    const out: SExpr[] = [];
    for (;;) {
      this.skipSpace();
      if (this.atEnd()) return out;
      out.push(this.readExpr());
    }
  }

  private readExpr(): SExpr {
    this.skipSpace();
    if (this.atEnd()) throw new ReadError("unexpected end of input", this.line, this.col);

    const c = this.peek();

    if (c === "(") {
      const startLine = this.line;
      const startCol = this.col;
      this.next();
      const list: SExpr[] = [];
      for (;;) {
        this.skipSpace();
        if (this.atEnd()) throw new ReadError("unclosed '('", startLine, startCol);
        if (this.peek() === ")") {
          this.next();
          return { kind: "list", items: list };
        }
        list.push(this.readExpr());
      }
    }

    if (c === ")") {
      throw new ReadError("unexpected ')'", this.line, this.col);
    }

    return this.readAtom();
  }

  private readAtom(): SExpr {
    const line = this.line;
    const col = this.col;
    let text = "";
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === "(" || c === ")" || c === " " || c === "\t" || c === "\n" || c === "\r" || c === ";") break;
      text += this.next();
    }

    if (text === "") throw new ReadError("expected an expression", line, col);

    if (text === "#t") return { kind: "bool", value: true };
    if (text === "#f") return { kind: "bool", value: false };

    if (/^-?[0-9]+$/.test(text)) return { kind: "int", value: Number(text) };

    // Anything that looks like a number but is not one is a mistake worth reporting here rather
    // than letting it become a symbol that fails somewhere far away.
    if (/^-?[0-9]/.test(text)) {
      throw new ReadError(`malformed number '${text}'`, line, col);
    }

    return { kind: "symbol", name: text };
  }
}

/** Read every top-level form. */
export function read(source: string): SExpr[] {
  return new Reader(source).readAll();
}

/** Read exactly one form. */
export function readOne(source: string): SExpr {
  const forms = read(source);
  if (forms.length === 0) throw new ReadError("no expression", 1, 1);
  if (forms.length > 1) throw new ReadError(`expected one expression, got ${forms.length}`, 1, 1);
  return forms[0]!;
}
