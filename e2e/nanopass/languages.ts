/**
 * Nanopass language chain for testing
 * 
 * L0 → L1 → L2 → L3
 * (source with let) → (desugar let) → (explicit refs) → (flatten)
 */

import { language, derive, list, type Nodes } from "../../src/nanopass/index.js";

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

// Type exports for use in passes
export type L0_Expr = Nodes<typeof L0>;
export type L1_Expr = Nodes<typeof L1>;
export type L2_Expr = Nodes<typeof L2>;
export type L3_Expr = Nodes<typeof L3>;
