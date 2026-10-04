/**
 * Nanopass transformations for the language chain
 */

import { pass, sig } from "../../src/nanopass/index.js";
import { L0, L1, L2, L3, type L0_Expr, type L1_Expr, type L2_Expr, type L3_Expr } from "./languages.js";

/**
 * Pass 1: Desugar let bindings to lambda applications
 * 
 * (let ([x val]) body)  =>  ((lambda (x) body) val)
 */
export const desugarLet = pass({
  from: L0,
  to: L1,
  rules: {
    Expr: {
      Let: (node, rec): L1_Expr => {
        return {
          type: "App",
          func: {
            type: "Lambda",
            param: node.name,
            body: rec(node.body),
          },
          arg: rec(node.val),
        };
      },
    },
  },
});

/**
 * Pass 2: Make variable references explicit with binding depth
 * 
 * Tracks lexical depth and converts Var to Ref with depth information.
 */
export const explicitRefs = pass({
  from: L1,
  to: L2,
  sig: sig(new Map<string, number>()),
  init: () => [new Map<string, number>()],
  rules: {
    Expr: {
      Var: (node, rec, env): readonly [L2_Expr, Map<string, number>] => {
        const depth = env.get(node.name) ?? 0;
        return [{ type: "Ref", name: node.name, depth }, env];
      },
      Lambda: (node, rec, env): readonly [L2_Expr, Map<string, number>] => {
        const newEnv = new Map(env);
        for (const [name, d] of env) {
          newEnv.set(name, d + 1);
        }
        newEnv.set(node.param, 0);
        const [body, _] = rec(node.body, newEnv);
        return [
          {
            type: "Lambda",
            param: node.param,
            body,
          },
          env,
        ];
      },
    },
  },
});

/**
 * Pass 3: Flatten nested expressions into sequences with temporaries
 * 
 * (+ (+ 1 2) 3)  =>  (seq [(temp 0 (+ 1 2))] (+ (ref t0) 3))
 */

let tempCounter = 0;

export const flatten = pass({
  from: L2,
  to: L3,
  rules: {
    Expr: {
      Add: (node, rec): L3_Expr => {
        const bindings: L3_Expr[] = [];

        const flattenOp = (operand: L2_Expr): L3_Expr => {
          const flat = rec(operand);
          if (flat.type === "Add" || flat.type === "Mul") {
            const id = tempCounter++;
            bindings.push({ type: "Temp", id, expr: flat });
            return { type: "Ref", name: `t${id}`, depth: 0 };
          }
          return flat;
        };

        const left = flattenOp(node.left);
        const right = flattenOp(node.right);
        const result: L3_Expr = { type: "Add", left, right };

        return bindings.length > 0 ? { type: "Seq", bindings, result } : result;
      },
      Mul: (node, rec): L3_Expr => {
        const bindings: L3_Expr[] = [];

        const flattenOp = (operand: L2_Expr): L3_Expr => {
          const flat = rec(operand);
          if (flat.type === "Add" || flat.type === "Mul") {
            const id = tempCounter++;
            bindings.push({ type: "Temp", id, expr: flat });
            return { type: "Ref", name: `t${id}`, depth: 0 };
          }
          return flat;
        };

        const left = flattenOp(node.left);
        const right = flattenOp(node.right);
        const result: L3_Expr = { type: "Mul", left, right };

        return bindings.length > 0 ? { type: "Seq", bindings, result } : result;
      },
    },
  },
});

/**
 * Reset temporary counter (for testing)
 */
export function resetTempCounter(): void {
  tempCounter = 0;
}
