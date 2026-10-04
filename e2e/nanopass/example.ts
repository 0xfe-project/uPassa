/**
 * Example: Demonstrate the nanopass transformation chain
 * 
 * L0 (let) → L1 (lambda) → L2 (explicit refs) → L3 (flattened)
 */

import { desugarLet, explicitRefs, flatten, resetTempCounter } from "./passes.js";
import type { L0_Expr } from "./languages.js";

/**
 * Example 1: Simple let binding
 * (let ([x 5]) (+ x 3))
 */
const example1: L0_Expr = {
  type: "Let",
  name: "x",
  val: { type: "Int", value: 5 },
  body: {
    type: "Add",
    left: { type: "Var", name: "x" },
    right: { type: "Int", value: 3 },
  },
};

console.log("Example 1: Simple let binding");
console.log("Input (L0):", JSON.stringify(example1, null, 2));

const ex1_l1 = desugarLet(example1);
console.log("\nAfter desugarLet (L1):", JSON.stringify(ex1_l1, null, 2));

const ex1_l2 = explicitRefs(ex1_l1);
console.log("\nAfter explicitRefs (L2):", JSON.stringify(ex1_l2, null, 2));

resetTempCounter();
const ex1_l3 = flatten(ex1_l2);
console.log("\nAfter flatten (L3):", JSON.stringify(ex1_l3, null, 2));

/**
 * Example 2: Nested arithmetic
 * (let ([x 1]) (+ (* x 2) (* x 3)))
 */
const example2: L0_Expr = {
  type: "Let",
  name: "x",
  val: { type: "Int", value: 1 },
  body: {
    type: "Add",
    left: {
      type: "Mul",
      left: { type: "Var", name: "x" },
      right: { type: "Int", value: 2 },
    },
    right: {
      type: "Mul",
      left: { type: "Var", name: "x" },
      right: { type: "Int", value: 3 },
    },
  },
};

console.log("\n\n=== Example 2: Nested arithmetic ===");
console.log("Input (L0):", JSON.stringify(example2, null, 2));

const ex2_l1 = desugarLet(example2);
console.log("\nAfter desugarLet (L1):", JSON.stringify(ex2_l1, null, 2));

const ex2_l2 = explicitRefs(ex2_l1);
console.log("\nAfter explicitRefs (L2):", JSON.stringify(ex2_l2, null, 2));

resetTempCounter();
const ex2_l3 = flatten(ex2_l2);
console.log("\nAfter flatten (L3):", JSON.stringify(ex2_l3, null, 2));

/**
 * Example 3: Nested let (closure)
 * (let ([x 1]) (let ([y 2]) (+ x y)))
 */
const example3: L0_Expr = {
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

console.log("\n\n=== Example 3: Nested let (closure) ===");
console.log("Input (L0):", JSON.stringify(example3, null, 2));

const ex3_l1 = desugarLet(example3);
console.log("\nAfter desugarLet (L1):", JSON.stringify(ex3_l1, null, 2));

const ex3_l2 = explicitRefs(ex3_l1);
console.log("\nAfter explicitRefs (L2):", JSON.stringify(ex3_l2, null, 2));

resetTempCounter();
const ex3_l3 = flatten(ex3_l2);
console.log("\nAfter flatten (L3):", JSON.stringify(ex3_l3, null, 2));
