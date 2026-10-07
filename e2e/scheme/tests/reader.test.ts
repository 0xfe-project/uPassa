/**
 * Tests for the reader.
 *
 * Small, but it covers the cases that would otherwise fail far from where they went wrong: a
 * missing paren, a stray paren, a malformed number. Those are the errors a person actually makes
 * when writing the source for the benchmarks.
 */

import { describe, it, expect } from "vitest";
import { read, readOne, print, isSymbol, isList, items, ReadError, type SExpr } from "../reader.ts";

const sym = (name: string): SExpr => ({ kind: "symbol", name });
const int = (value: number): SExpr => ({ kind: "int", value });
const list = (...items: SExpr[]): SExpr => ({ kind: "list", items });

describe("reader: atoms", () => {
  it("reads integers", () => {
    expect(readOne("42")).toEqual(int(42));
    expect(readOne("-7")).toEqual(int(-7));
    expect(readOne("0")).toEqual(int(0));
  });

  it("reads booleans", () => {
    expect(readOne("#t")).toEqual({ kind: "bool", value: true });
    expect(readOne("#f")).toEqual({ kind: "bool", value: false });
  });

  it("reads symbols", () => {
    expect(readOne("x")).toEqual(sym("x"));
    expect(readOne("foo-bar?")).toEqual(sym("foo-bar?"));
    expect(readOne("+")).toEqual(sym("+"));
    expect(readOne("set!")).toEqual(sym("set!"));
  });
});

describe("reader: lists", () => {
  it("reads an empty list", () => {
    expect(readOne("()")).toEqual(list());
  });

  it("reads a nested list", () => {
    expect(readOne("(+ 1 (* 2 3))")).toEqual(list(sym("+"), int(1), list(sym("*"), int(2), int(3))));
  });

  it("reads several top-level forms", () => {
    const forms = read("(define x 1) (define y 2) (+ x y)");
    expect(forms).toHaveLength(3);
    expect(forms[2]).toEqual(list(sym("+"), sym("x"), sym("y")));
  });

  it("ignores line comments", () => {
    const forms = read(`
      ; a comment
      (define x 1)  ; trailing
      (+ x 1)
    `);
    expect(forms).toHaveLength(2);
  });

  it("tolerates arbitrary whitespace", () => {
    expect(readOne("(\n  +\n  1\n  2\n)")).toEqual(list(sym("+"), int(1), int(2)));
  });
});

describe("reader: errors point at the problem", () => {
  it("reports an unclosed paren at the paren's position", () => {
    let err: ReadError | undefined;
    try {
      read("(+ 1");
    } catch (e) {
      err = e as ReadError;
    }
    expect(err).toBeInstanceOf(ReadError);
    expect(err!.message).toMatch(/unclosed/);
    expect(err!.line).toBe(1);
    expect(err!.col).toBe(1);
  });

  it("reports a stray closing paren", () => {
    expect(() => read("(+ 1))")).toThrow(/unexpected '\)'/);
  });

  it("reports a malformed number", () => {
    expect(() => read("12abc")).toThrow(/malformed number/);
  });

  it("tracks the line of a later error", () => {
    let err: ReadError | undefined;
    try {
      read("(define x 1)\n(define y 2)\n(+ 1");
    } catch (e) {
      err = e as ReadError;
    }
    expect(err!.line).toBe(3);
  });
});

describe("reader: helpers", () => {
  it("print round-trips a form", () => {
    const src = "(define (f x) (+ x 1))";
    expect(print(readOne(src))).toBe(src);
  });

  it("isSymbol and isList narrow", () => {
    const e = readOne("(a b)");
    expect(isList(e)).toBe(true);
    expect(isSymbol(e)).toBe(false);
    expect(isSymbol(readOne("a"), "a")).toBe(true);
    expect(isSymbol(readOne("a"), "b")).toBe(false);
  });

  it("items throws on a non-list", () => {
    expect(() => items(readOne("x"))).toThrow(/expected a list/);
  });
});
