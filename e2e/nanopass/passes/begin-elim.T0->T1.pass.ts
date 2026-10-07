/**
 * begin-elim: T0 -> T1. Drop Begin, keeping its body.
 *
 * (begin e)  =>  e
 */

import { pass, buildWalker } from "../../../src/nanopass/index.ts";
import { T0, T1, type T1_Expr } from "../langs/toy.lang.ts";

const spec = pass({
  from: T0,
  to: T1,
  rules: {
    Expr: {
      Begin: (n, rec): T1_Expr => rec(n.body),
    },
  },
});

export const beginElim = buildWalker(spec).run;
export const beginElimSpec = spec;
