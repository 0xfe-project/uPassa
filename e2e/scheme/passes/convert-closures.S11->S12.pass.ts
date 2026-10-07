/**
 * Lambdas become closures, and every function's variables become frame slots.
 *
 * A lambda is split in two:
 *
 *   (lambda (x) body)[free = (n)]   =>   (make-closure fn1 (n))
 *                                        fn1(f0, p0) = body[n := f0, x := p0]
 *
 * Two renamings happen here, and leaving either out produces a body that refers to a variable that
 * does not exist — which nothing would notice until the interpreter ran it.
 *
 * 1. A captured variable belongs to an enclosing function's frame. Once the body is lifted it can
 *    no longer see that frame, so each reference is rewritten to the capture parameter the value
 *    arrives in.
 * 2. Parameters are renamed to their frame slots. The calling convention the lowering and the
 *    interpreter agree on is `f0, f1, ...` for captures then `p0, p1, ...` for arguments, so after
 *    this pass the params of a lifted body *are* its frame, positionally.
 *
 * The substitution is accumulated, not replaced: an inner lambda that captured the outer `n` now
 * captures the outer `f0`, because that is the name the value lives under here. Nested capture
 * lists are positional over the already-renamed outer list, so the mapping composes.
 */

import { pass, sig, buildWalker } from "../../../src/nanopass/index.ts";
import { S11, S12, type S11_Expr, type S12_Expr, type S12_Program } from "../langs/chain.ts";

interface FunDef {
  type: "FunDef";
  name: string;
  params: string[];
  body: S12_Expr;
}

interface Ctx {
  /** Bodies of the lambdas seen so far. */
  fns: FunDef[];
  /** Next function label. */
  n: number;
  /** Accumulated renaming: name in the source -> the name it is carried under. */
  rename: Map<string, string>;
}

const spec = pass({
  from: S11,
  to: S12,
  sig: sig({ fns: [], n: 0, rename: new Map<string, string>() } satisfies Ctx),
  init: (): [Ctx] => [{ fns: [], n: 0, rename: new Map() }],
  rules: {
    Program: {
      Program: (n, rec, c): readonly [S12_Program, Ctx] => {
        // Convert the definitions and body first, so `c.fns` is complete by the time the program
        // is rebuilt.
        const defs = n.defs.map((d) => rec(d, c)[0]);
        const body = n.body.map((e) => rec(e, c)[0]);
        return [{ type: "Program", defs, body, fns: [...c.fns] } as S12_Program, c];
      },
    },

    Expr: {
      Var: (n, rec, c): readonly [S12_Expr, Ctx] => {
        const to = c.rename.get(n.name);
        return [to === undefined ? n : { type: "Var", name: to }, c];
      },

      Lambda: (n, rec, c): readonly [S12_Expr, Ctx] => {
        const label = `fn${c.n++}`;

        const captureParams = n.free.map((_, i) => `f${i}`);
        const argParams = n.params.map((_, i) => `p${i}`);
        const map = new Map(n.free.map((name, i) => [name, captureParams[i]!]));
        for (const [j, name] of n.params.entries()) map.set(name, argParams[j]!);

        // The enclosing renaming still applies inside this body; this lambda's own mapping is
        // layered on top of it.
        const outer = c.rename;
        c.rename = new Map([...outer, ...map]);
        const [body] = rec(n.body, c);
        c.rename = outer;

        c.fns.push({
          type: "FunDef",
          name: label,
          params: [...captureParams, ...argParams],
          body,
        });

        // The closure carries the captured values, read where the lambda was written — that is,
        // in the enclosing function's frame, so only the enclosing renaming applies to them.
        return [
          {
            type: "MakeClosure",
            fn: label,
            free: n.free.map((name) => ({ type: "Var", name: outer.get(name) ?? name }) as S12_Expr),
          },
          c,
        ];
      },

      App: (n, rec, c): readonly [S12_Expr, Ctx] => {
        const [fn] = rec(n.func, c);
        const args = n.args.map((a) => rec(a, c)[0]);
        return [{ type: "Call", fn, args }, c];
      },
    },
  },
});

export const convertClosures = buildWalker(spec).run;
export const convertClosuresSpec = spec;
