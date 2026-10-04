/**
 * Nanopass test fixtures
 *
 * Representative source programs that exercise the transformation chain.
 */

import type { L0_Expr } from "./languages.js";

/**
 * Simple let binding: (let ([x 5]) (+ x 3))
 */
export const simpleLet: L0_Expr = {
  type: "Let",
  name: "x",
  val: { type: "Int", value: 5 },
  body: {
    type: "Add",
    left: { type: "Var", name: "x" },
    right: { type: "Int", value: 3 },
  },
};

/**
 * Nested arithmetic: (+ (* 2 3) (+ 4 5))
 * Requires flattening to introduce temporaries.
 */
export const nestedArithmetic: L0_Expr = {
  type: "Add",
  left: {
    type: "Mul",
    left: { type: "Int", value: 2 },
    right: { type: "Int", value: 3 },
  },
  right: {
    type: "Add",
    left: { type: "Int", value: 4 },
    right: { type: "Int", value: 5 },
  },
};

/**
 * Nested let (closure-like): (let ([x 1]) (let ([y 2]) (+ x y)))
 * Tests binding depth tracking.
 */
export const nestedLet: L0_Expr = {
  type: "Let",
  name: "x",
  val: { type: "Int", value: 1 },
  body: {
    type: "Let",
    name: "y",
    val: { type: "Int", value: 2 },
    body: {
      type: "Add",
      left: { type: "Var", name: "x" },
      right: { type: "Var", name: "y" },
    },
  },
};

/**
 * Lambda with captured variable: (lambda (y) (let ([x (+ y 1)]) (* x x)))
 */
export const lambdaCapture: L0_Expr = {
  type: "Lambda",
  param: "y",
  body: {
    type: "Let",
    name: "x",
    val: {
      type: "Add",
      left: { type: "Var", name: "y" },
      right: { type: "Int", value: 1 },
    },
    body: {
      type: "Mul",
      left: { type: "Var", name: "x" },
      right: { type: "Var", name: "x" },
    },
  },
};

/**
 * Deeply nested lets (stress test for the walker).
 */
export function deepNestedLet(depth: number): L0_Expr {
  let expr: L0_Expr = { type: "Var", name: "x0" };
  for (let i = depth; i >= 1; i--) {
    expr = {
      type: "Let",
      name: `x${i}`,
      val: { type: "Int", value: i },
      body: expr,
    };
  }
  return expr;
}

/**
 * Wide arithmetic expression (many operands).
 */
export function wideArithmetic(width: number): L0_Expr {
  let expr: L0_Expr = { type: "Int", value: 0 };
  for (let i = 1; i < width; i++) {
    expr = {
      type: "Add",
      left: expr,
      right: { type: "Int", value: i },
    };
  }
  return expr;
}

/**
 * All fixtures by name.
 */
export const FIXTURES = {
  simpleLet,
  nestedArithmetic,
  nestedLet,
  lambdaCapture,
} as const;
