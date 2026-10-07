/**
 * `cond` becomes nested `if`.
 *
 * A clause whose test is the symbol `else` becomes the remaining branch. A `cond` with no matching
 * clause and no `else` is `void`.
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { S2, S3, type S2_Expr, type S3_Expr } from "../langs/chain.ts";

const spec = pass({
  from: S2,
  to: S3,
  rules: {
    Expr: {
      Cond: (n, rec): S3_Expr => {
        const build = (i: number): S3_Expr => {
          const clause = n.clauses[i];
          if (clause === undefined) return { type: "Void" };
          if (clause.test.type === "Var" && clause.test.name === "else") return rec(clause.body);
          return {
            type: "If",
            cond: rec(clause.test as S2_Expr),
            then: rec(clause.body),
            alt: build(i + 1),
          };
        };
        return build(0);
      },
    },
  },
});

export const removeCond = buildWalker(spec).run;
export const removeCondSpec = spec;
