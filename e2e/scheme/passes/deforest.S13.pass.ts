/**
 * Deforestation: a producer consumed directly by a consumer becomes one loop.
 *
 *     (fold f a (map g xs))   =>   (fused f g a xs)
 *     fused f g a xs = if (null? xs) a (fused f g (f a (g (car xs))) (cdr xs))
 *
 * The intermediate list is never built. This is the one thing that makes `map-fold` cost six times
 * the C shape, and no amount of SSA optimization removes it — the list is there because the source
 * asked for it, and removing it is a rewrite of the *source*, which is what this pass is.
 *
 * ── What this is, and what it is not
 *
 * This is **shortcut fusion**: a rule that recognises a producer and a consumer by their shapes and
 * emits the fused loop. It is not Wadler's deforestation, which is the general algorithm and works
 * by requiring the source to be in `foldr`/`build` form and then applying one algebraic law. The
 * practical version in real compilers is this one — GHC's `foldr`/`build` rule is also a rule.
 *
 * The shapes it recognises, and nothing else:
 *
 *   producer  P(extra..., src) = if (test src) () (cons (elem extra src) (P extra... (next src)))
 *   consumer  C(f, extra..., acc, src) = if (test src) acc (C f extra... (f acc (head src)) (next src))
 *
 * and the fusion fires when a consumer's list argument is a call to a producer. `test` and `next`
 * have to agree between the two — the same emptiness test, the same way of stepping — because
 * fusing two traversals that do not agree on what "the rest of the list" is would be wrong. That is
 * the whole safety condition, and it is checked structurally.
 *
 * Anything outside that shape is left alone, which is why `build` — a producer whose emptiness test
 * is `(= n 0)` rather than `(null? xs)` — does not fuse with `fold`, and should not: they are not
 * traversing the same thing.
 *
 * ── The effect condition, which is not optional
 *
 * Fusing interleaves two traversals that used to run one after the other:
 *
 *   unfused   g(e1) g(e2) g(e3)  then  f(a0,m1) f(a1,m2) f(a2,m3)
 *   fused     g(e1) f(a0,m1) g(e2) f(a1,m2) g(e3) f(a2,m3)
 *
 * If both `g` and `f` do something observable, that is a different program. With only one of them
 * effectful the relative order of the effects is unchanged — the effectful one still happens once
 * per element, in element order — and the rewrite is sound. So the condition is **at least one of
 * the two must be pure**, and it is checked at the call site, against the closure actually passed.
 *
 * Syntactic purity of the *body* is not enough to decide this: `(f acc (car xs))` contains a call in
 * both the safe and the unsafe case. What is decidable is whether the closure passed at this call
 * site is a literal whose body makes no calls at all — which is what `knownPure` asks. Being wrong
 * in the permissive direction here silently reorders a program's output, so the check is written to
 * say no when it cannot tell.
 *
 * ── Why the shapes are read here and not in the SSA
 *
 * Because here they are three lines each and legible. Lowered, the same two functions are a dozen
 * blocks and phis, and the pattern that says "this one builds, that one consumes" is spread across
 * them. The SSA layer is the wrong place to ask a question about the source's structure.
 *
 * ── Why this pass cannot be fused
 *
 * Deciding whether a call site fuses needs the whole program: which functions are producers, which
 * are consumers, and what a closure literal's body does. That state is threaded through `sig`, and a
 * pass with extra values controls its own descent — so `canFuse` says no and the pass runs on its
 * own. That is not a limitation being worked around, it is the correct classification: the first
 * version did the traversal itself and merged the two functions into the tree without going through
 * the walker, so a fused `mark-tail` never saw them and every tail marker on a fused loop was
 * silently dropped. The fusion guardrail caught it, which is what it is for.
 */

import { pass, sig, buildWalker } from "../../../src/nanopass/index.ts";
import { S13, type S13_Expr, type S13_Program, type S13_Def } from "../langs/chain.ts";

/** A node as this pass sees it: a tag and some fields, some of which are expressions. */
type E = { type: string; [k: string]: unknown };

// ───────────────────────── Structural helpers ─────────────────────────

const isE = (x: unknown): x is E =>
  typeof x === "object" && x !== null && typeof (x as { type?: unknown }).type === "string";

/** Every expression directly inside a node: the fields that are nodes or lists of nodes. */
function children(e: E): E[] {
  const out: E[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (k === "type" || k === "__lang__") continue;
    if (isE(v)) out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (isE(x)) out.push(x);
  }
  return out;
}

/** Rebuild a node with its child expressions replaced, in the order `children` returned them. */
function withChildren(e: E, replacements: E[]): E {
  const out: E = { ...e };
  let i = 0;
  for (const [k, v] of Object.entries(e)) {
    if (k === "type" || k === "__lang__") continue;
    if (isE(v)) out[k] = replacements[i++];
    else if (Array.isArray(v)) {
      out[k] = v.map((x) => (isE(x) ? replacements[i++] : x));
    }
  }
  return out;
}

/** Replace `from` with `to` throughout, by name. */
function subst(e: E, map: ReadonlyMap<string, E>): E {
  if (e.type === "Var") {
    const to = map.get(e.name as string);
    return to === undefined ? e : to;
  }
  return withChildren(
    e,
    children(e).map((c) => subst(c, map)),
  );
}

/**
 * A node's shape with one variable renamed to a fixed token, as a string.
 *
 * Two traversals agree when their tests and steps have the same canonical form — the variable
 * names differ because they are different functions' parameters, and that is the only difference
 * that is allowed to.
 */
function canonical(e: E, variable: string): string {
  return JSON.stringify(e, (k, val) => {
    if (k === "__lang__") return undefined;
    if (isE(val) && val.type === "Var" && val.name === variable) {
      return { type: "Var", name: "$" };
    }
    return val;
  });
}

// ───────────────────────── Effects ─────────────────────────

/** True when the expression contains any call, at any depth. A call may print. */
function hasCall(e: E): boolean {
  if (e.type === "Call") return true;
  return children(e).some(hasCall);
}

/**
 * True when the expression is *known* to denote a function with no effects.
 *
 * Only a closure literal or a reference to a top-level function can be resolved, and only when the
 * body makes no calls at all — `+` and `*` are primitives, so arithmetic qualifies. Anything else
 * is unknown, and unknown means no.
 */
function knownPure(e: E, defs: ReadonlyMap<string, E>): boolean {
  if (e.type === "MakeClosure") {
    if (children(e).some(hasCall)) return false;
    const body = defs.get(e.fn as string);
    return body !== undefined && !hasCall(body);
  }
  if (e.type === "Var") {
    const body = defs.get(e.name as string);
    return body !== undefined && !hasCall(body);
  }
  return false;
}

const v = (name: string): E => ({ type: "Var", name });
const call = (fn: string, args: E[]): E => ({ type: "Call", fn: v(fn), args });

// ───────────────────────── Recognising the shapes ─────────────────────────

interface Producer {
  readonly name: string;
  readonly params: string[];
  /** The parameter being traversed. Always the last one. */
  readonly src: string;
  readonly extra: string[];
  readonly test: E;
  readonly next: E;
  /** The element the producer puts in the list, in terms of all its parameters. */
  readonly elem: E;
}

interface Consumer {
  readonly name: string;
  readonly params: string[];
  readonly f: string;
  readonly extra: string[];
  readonly acc: string;
  readonly src: string;
  readonly test: E;
  readonly next: E;
  /** What `f` is applied to, in terms of `src`. */
  readonly head: E;
}

/** `P(extra..., src) = if (test src) () (cons elem (P extra... (next src)))` */
function asProducer(d: S13_Def): Producer | undefined {
  if (d.type !== "DefFun") return undefined;
  const params = d.params;
  if (params.length === 0) return undefined;
  const src = params[params.length - 1]!;
  const extra = params.slice(0, -1);

  const body = d.body as unknown as E;
  if (body.type !== "If") return undefined;

  const cond = body.cond as unknown as E;
  const then = body.then as unknown as E;
  const alt = body.alt as unknown as E;
  if (then.type !== "Nil") return undefined;
  if (alt.type !== "Prim" || alt.op !== "cons") return undefined;

  const args = alt.args as E[];
  const elem = args[0];
  const tail = args[1];
  if (elem === undefined || tail === undefined) return undefined;

  const step = selfStep(tail, d.name, params);
  if (step === undefined) return undefined;

  return { name: d.name, params, src, extra, test: cond, next: step, elem };
}

/** `C(f, extra..., acc, src) = if (test src) acc (C f extra... (f acc (head src)) (next src))` */
function asConsumer(d: S13_Def): Consumer | undefined {
  if (d.type !== "DefFun") return undefined;
  const params = d.params;
  if (params.length < 3) return undefined;
  const src = params[params.length - 1]!;
  const acc = params[params.length - 2]!;
  const f = params[0]!;
  const extra = params.slice(1, -2);

  const body = d.body as unknown as E;
  if (body.type !== "If") return undefined;

  const then = body.then as unknown as E;
  const alt = body.alt as unknown as E;
  if (then.type !== "Var" || then.name !== acc) return undefined;
  if (alt.type !== "Call") return undefined;
  if (!isE(alt.fn) || alt.fn.type !== "Var" || alt.fn.name !== d.name) return undefined;

  const args = alt.args as E[];
  if (args.length !== params.length) return undefined;

  // The leading parameters pass through unchanged.
  for (let i = 0; i < params.length - 2; i++) {
    const a = args[i]!;
    if (a.type !== "Var" || a.name !== params[i]) return undefined;
  }

  const combine = args[params.length - 2]!;
  if (combine.type !== "Call") return undefined;
  if (!isE(combine.fn) || combine.fn.type !== "Var" || combine.fn.name !== f) return undefined;
  const combineArgs = combine.args as E[];
  const head = combineArgs[1];
  if (head === undefined) return undefined;
  if (combineArgs[0]?.type !== "Var" || combineArgs[0].name !== acc) return undefined;

  const next = args[params.length - 1]!;

  return { name: d.name, params, f, extra, acc, src, test: body.cond as unknown as E, next, head };
}

/**
 * `(self extra... (step src))` — the recursive call of a producer, if that is what this is.
 *
 * The leading parameters have to be passed through unchanged; only the traversed one may change.
 * A call that reshuffles them is not a traversal of the same thing.
 */
function selfStep(e: E, name: string, params: string[]): E | undefined {
  if (e.type !== "Call") return undefined;
  if (!isE(e.fn) || e.fn.type !== "Var" || e.fn.name !== name) return undefined;
  const args = e.args as E[];
  if (args.length !== params.length) return undefined;
  for (let i = 0; i < params.length - 1; i++) {
    const a = args[i]!;
    if (a.type !== "Var" || a.name !== params[i]) return undefined;
  }
  return args[params.length - 1];
}

// ───────────────────────── The pass ─────────────────────────

interface Fused {
  readonly def: S13_Def;
  /** Parameters of the fused function, in order: consumer's `f`, producer's extras, acc, src. */
  readonly params: string[];
}

/** Build the fused function for a consumer/producer pair. */
function fuse(consumer: Consumer, producer: Producer): Fused {
  const name = `$fused_${consumer.name}_${producer.name}`;
  // Parameters are frame slots, not source names: `convert-closures` already renamed every
  // parameter to the slot it lives in, and the lowering binds a function's parameters to their own
  // names. A fused function is synthesized after that point, so it has to follow the same
  // convention — a `$src` here is a name nothing ever binds.
  const cf = "p0";
  const extraParams = producer.extra.map((_, i) => `p${i + 1}`);
  const cacc = `p${producer.extra.length + 1}`;
  const csrc = `p${producer.extra.length + 2}`;

  // Everything the producer's element says is in terms of the producer's own parameters; the
  // traversed one becomes the fused function's `src`, and the rest become the fused extras.
  const elemMap = new Map<string, E>();
  producer.extra.forEach((p, i) => elemMap.set(p, v(extraParams[i]!)));
  elemMap.set(producer.src, v(csrc));

  const srcMap = new Map<string, E>([[consumer.src, v(csrc)]]);

  const body: E = {
    type: "If",
    cond: subst(consumer.test, srcMap),
    then: v(cacc),
    alt: call(name, [
      v(cf),
      ...extraParams.map(v),
      { type: "Call", fn: v(cf), args: [v(cacc), subst(producer.elem, elemMap)] },
      subst(consumer.next, srcMap),
    ]),
  };

  const params = [cf, ...extraParams, cacc, csrc];
  return {
    def: { type: "DefFun", name, params, body } as unknown as S13_Def,
    params,
  };
}

interface Ctx {
  readonly producers: Map<string, Producer>;
  readonly consumers: Map<string, Consumer>;
  readonly bodies: Map<string, E>;
  /** One fused function per pair, shared by every call site that fuses the same way. */
  readonly fused: Map<string, Fused>;
  readonly added: S13_Def[];
}

const spec = pass({
  from: S13,
  to: S13,
  sig: sig({
    producers: new Map<string, Producer>(),
    consumers: new Map<string, Consumer>(),
    bodies: new Map<string, E>(),
    fused: new Map<string, Fused>(),
    added: [] as S13_Def[],
  } satisfies Ctx),
  init: (): [Ctx] => [
    { producers: new Map(), consumers: new Map(), bodies: new Map(), fused: new Map(), added: [] },
  ],
  rules: {
    Program: {
      Program: (n, rec, ctx): readonly [S13_Program, Ctx] => {
        for (const d of n.defs) {
          if (d.type !== "DefFun") continue;
          ctx.bodies.set(d.name, d.body as unknown as E);
          const p = asProducer(d);
          if (p !== undefined) ctx.producers.set(p.name, p);
          const c = asConsumer(d);
          if (c !== undefined) ctx.consumers.set(c.name, c);
        }

        // The definitions and the body are walked by the walker, not by a traversal of our own, so
        // that whatever comes after this pass sees everything this pass produces. The synthesized
        // functions are walked too, for the same reason.
        const defs = n.defs.map((d) => rec(d, ctx)[0]);
        const body = n.body.map((e) => rec(e, ctx)[0]);
        const added = ctx.added.map((d) => rec(d as never, ctx)[0]);

        return [{ type: "Program", defs: [...defs, ...added], body } as unknown as S13_Program, ctx];
      },
    },

    Expr: {
      Call: (n, rec, ctx): readonly [S13_Expr, Ctx] => {
        // Children first: a fusion nested inside another one has to have happened before this node
        // is examined, or the shape here would still be the unfused one.
        const fnOut = rec(n.fn, ctx)[0];
        const argsOut = n.args.map((a) => rec(a, ctx)[0]);

        // The pass works on shapes, and the language's own types are too precise to pattern-match
        // against loosely. The narrowing happens once, here.
        const fn = fnOut as unknown as E;
        const args = argsOut as unknown as E[];
        const node: E = { type: "Call", fn: fnOut, args: argsOut };

        const consumer = fn.type === "Var" ? ctx.consumers.get(fn.name as string) : undefined;
        if (consumer === undefined) return [node as unknown as S13_Expr, ctx];
        if (args.length !== consumer.params.length) return [node as unknown as S13_Expr, ctx];

        const last = args[args.length - 1]!;
        if (last.type !== "Call") return [node as unknown as S13_Expr, ctx];
        const pfn = last.fn as unknown as E;
        const producer = pfn.type === "Var" ? ctx.producers.get(pfn.name as string) : undefined;
        if (producer === undefined) return [node as unknown as S13_Expr, ctx];

        const pargs = last.args as E[];
        if (pargs.length !== producer.params.length) return [node as unknown as S13_Expr, ctx];

        // The two traversals have to agree on the emptiness test and on how to step. Without this
        // the rewrite would fuse two different walks.
        if (canonical(consumer.test, consumer.src) !== canonical(producer.test, producer.src)) {
          return [node as unknown as S13_Expr, ctx];
        }
        if (canonical(consumer.next, consumer.src) !== canonical(producer.next, producer.src)) {
          return [node as unknown as S13_Expr, ctx];
        }

        // And at least one of the two functions must be pure, or interleaving them reorders the
        // program's output. See the note at the top: this is not a heuristic, it is the difference
        // between a rewrite and a miscompile.
        const headArgs = args.slice(0, -2);
        const pureCombine = headArgs[0] !== undefined && knownPure(headArgs[0], ctx.bodies);
        const pureElement = pargs[0] !== undefined && knownPure(pargs[0], ctx.bodies);
        if (!pureCombine && !pureElement) return [node as unknown as S13_Expr, ctx];

        const key = `${consumer.name}|${producer.name}`;
        let f = ctx.fused.get(key);
        if (f === undefined) {
          f = fuse(consumer, producer);
          ctx.fused.set(key, f);
          ctx.added.push(f.def);
        }

        const extraArgs = pargs.slice(0, -1);
        const srcArg = pargs[pargs.length - 1]!;
        const accArg = args[args.length - 2]!;

        return [call(f.def.name, [...headArgs, ...extraArgs, accArg, srcArg]) as unknown as S13_Expr, ctx];
      },
    },
  },
});

export const deforest = buildWalker(spec).run;
export const deforestSpec = spec;
