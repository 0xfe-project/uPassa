/**
 * Nanopass language chain for testing
 *
 * L0 → L1 → L2 → L3 → L4 → L5 → L6 → L7 → L8 → L9 → L10
 * Complete transformation pipeline from surface syntax to CFG-ready IR
 */

import { language, derive, list, type Nodes, type NodeOf } from "../../src/nanopass/index.js";

/**
 * L0: Source language with let bindings
 */
export const L0 = language({
  id: "L0",
  entry: "Expr",
  rules: {
    Expr: {
      Int: { value: "number" },
      Var: { name: "string" },
      Lambda: { param: "string", body: "Expr" },
      App: { func: "Expr", arg: "Expr" },
      Let: { name: "string", val: "Expr", body: "Expr" },
      Add: { left: "Expr", right: "Expr" },
      Mul: { left: "Expr", right: "Expr" },
    },
  },
});

/**
 * L1: Desugared - let converted to lambda application
 */
export const L1 = derive({
  id: "L1",
  base: L0,
  remove: ["Let"],
});

/**
 * L2: Explicit references with binding depth
 */
export const L2 = derive({
  id: "L2",
  base: L1,
  remove: ["Var"],
  add: {
    Expr: {
      Ref: { name: "string", depth: "number" },
    },
  },
});

/**
 * L3: Flattened expressions with temporary bindings
 */
export const L3 = derive({
  id: "L3",
  base: L2,
  add: {
    Expr: {
      Temp: { id: "number", expr: "Expr" },
      Seq: { bindings: list("Expr"), result: "Expr" },
    },
  },
});

/**
 * L4: Free variable analysis - lambdas annotated with free vars
 */
export const L4 = derive({
  id: "L4",
  base: L3,
  remove: ["Lambda"],
  add: {
    Expr: {
      Lambda: { param: "string", body: "Expr", free: list("string") },
    },
  },
});

/**
 * L5: Box mutable variables (heap-allocated cells)
 */
export const L5 = derive({
  id: "L5",
  base: L4,
  add: {
    Expr: {
      Box: { value: "Expr" },
      BoxGet: { box: "Expr" },
      BoxSet: { box: "Expr", value: "Expr" },
    },
  },
});

/**
 * L6: Explicit closures (code + environment)
 */
export const L6 = derive({
  id: "L6",
  base: L5,
  remove: ["Lambda"],
  add: {
    Expr: {
      ClosureMake: { funcId: "string", env: list("Expr") },
      ClosureCall: { closure: "Expr", arg: "Expr" },
    },
  },
});

/**
 * L7: Top-level functions (lambda lifting)
 */
export const L7 = derive({
  id: "L7",
  base: L6,
  add: {
    Program: {
      TopLevel: { funcs: list("FunDef"), main: "Expr" },
    },
    FunDef: {
      FunDef: { id: "string", param: "string", envParam: "string", body: "Expr" },
    },
  },
});

/**
 * L8: Explicit control flow (if, loop, break, continue)
 */
export const L8 = derive({
  id: "L8",
  base: L7,
  add: {
    Expr: {
      If: { cond: "Expr", then: "Expr", else: "Expr" },
      Loop: { body: "Expr" },
      Break: {},
      Continue: {},
    },
  },
});

/**
 * L9: Basic blocks (A-normal form with explicit jumps)
 */
export const L9 = derive({
  id: "L9",
  base: L8,
  remove: ["If", "Loop", "Break", "Continue"],
  add: {
    Expr: {
      Block: { label: "string", body: list("Expr"), term: "Expr" },
      Jump: { target: "string" },
      Branch: { cond: "Expr", trueBranch: "string", falseBranch: "string" },
      Return: { value: "Expr" },
    },
  },
});

/**
 * L10: Final IR (generic instruction form, ready for CFG/SSA)
 */
export const L10 = derive({
  id: "L10",
  base: L9,
  remove: ["Add", "Mul", "ClosureCall", "BoxGet", "BoxSet", "Temp", "Seq"],
  add: {
    Expr: {
      Instr: { op: "string", args: list("Expr"), dest: "string" },
    },
    Terminator: {
      TermJump: { target: "string" },
      TermBranch: { cond: "string", trueBranch: "string", falseBranch: "string" },
      TermReturn: { value: "string" },
    },
  },
});

// Type exports for use in passes
export type L0_Expr = Nodes<typeof L0>;
export type L1_Expr = Nodes<typeof L1>;
export type L2_Expr = Nodes<typeof L2>;
export type L3_Expr = Nodes<typeof L3>;
export type L4_Expr = Nodes<typeof L4>;
export type L5_Expr = Nodes<typeof L5>;
export type L6_Expr = Nodes<typeof L6>;
export type L7_Program = NodeOf<typeof L7, "Program">;
export type L7_FunDef = NodeOf<typeof L7, "FunDef">;
export type L7_Expr = NodeOf<typeof L7, "Expr">;
export type L8_Expr = NodeOf<typeof L8, "Expr">;
export type L9_Expr = NodeOf<typeof L9, "Expr">;
export type L10_Expr = NodeOf<typeof L10, "Expr">;
export type L10_Terminator = NodeOf<typeof L10, "Terminator">;
