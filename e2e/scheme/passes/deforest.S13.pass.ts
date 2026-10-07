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
function knownPure(e: E, defs: ReadonlyMap<string, Resolved>): boolean {
  if (e.type === "MakeClosure") {
    if (children(e).some(hasCall)) return false;
    const d = defs.get(e.fn as string);
    return d !== undefined && !hasCall(d.body);
  }
  if (e.type === "Var") {
    const d = defs.get(e.name as string);
    return d !== undefined && !hasCall(d.body);
  }
  return false;
}

const v = (name: string): E => ({ type: "Var", name });
const call = (fn: string, args: E[]): E => ({ type: "Call", fn: v(fn), args });

// ───────────────────────── Recognising the shapes ─────────────────────────

interface Producer {
  readonly name: string;
  readonly params: string[];
  /**
   * The function applied to each element.
   *
   * Its own field rather than part of `extra`: it is what `elem` calls, and it is the thing that
   * gets inlined away at a specialized call site. Treating it as an extra to pass through left a
   * closure allocated per call for a function that had already been substituted into the loop.
   */
  readonly f: string;
  /** Parameters the producer carries along untouched: `P(f, extra..., src)`. */
  readonly extra: string[];
  /** The parameter being traversed. Always the last one. */
  readonly src: string;
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
  if (params.length < 2) return undefined;
  const f = params[0]!;
  const src = params[params.length - 1]!;
  const extra = params.slice(1, -1);

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

  return { name: d.name, params, f, extra, src, test: cond, next: step, elem };
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
/**
 * A closure literal, resolved to its body.
 *
 * Only a capture-free one: the body of a closure that captures is written in terms of `f0, f1, ...`,
 * which are slots the fused function does not have. Nothing here can supply them, so a capturing
 * closure is left as an indirect call.
 */
interface Resolved {
  readonly params: readonly string[];
  readonly body: E;
}

/** A top-level function, by name: what it takes and what it does. */
type DefBody = Resolved;

function resolveClosure(e: E | undefined, bodies: ReadonlyMap<string, Resolved>): Resolved | undefined {
  if (e === undefined || e.type !== "MakeClosure") return undefined;
  const free = e.free;
  if (Array.isArray(free) && free.length > 0) return undefined;
  return bodies.get(e.fn as string);
}

/**
 * Build the fused function.
 *
 * Two shapes, and which one is produced depends only on what is known at the call site:
 *
 *   generic       `$fused_fold_map(cf, ce, acc, src)` — the two functions stay parameters, and each
 *                 element costs two indirect calls.
 *   specialized   `$fused_fold_map$fn3$fn4(acc, src)` — the two closure literals' bodies are
 *                 substituted in, so the loop has no calls in it at all. This is what a C
 *                 programmer writes, and it is the difference between 4.5x and parity.
 *
 * Specializing is what the call site already knows: the functions are literals written right there.
 * It is not a general inliner — a function passed as a variable, or a capturing closure, keeps the
 * generic shape.
 */
function fuse(
  consumer: Consumer,
  producer: Producer,
  combine: Resolved | undefined,
  combineName: string | undefined,
  element: Resolved | undefined,
  elementName: string | undefined,
): Fused {
  const specialized = combine !== undefined && element !== undefined;
  // The name carries which closures were inlined. Two different pairs would otherwise produce the
  // same name — one `$fused_fold_map$2$1` is indistinguishable from another — and the second would
  // silently shadow the first.
  const suffix = specialized ? `$${combineName}$${elementName}` : "";
  const name = `$fused_${consumer.name}_${producer.name}${suffix}`;

  // Parameters are frame slots, not source names: `convert-closures` already renamed every
  // parameter to the slot it lives in, and the lowering binds a function's parameters to their own
  // names. A fused function is synthesized after that point, so it has to follow the same
  // convention — a `$src` here is a name nothing ever binds.
  //
  // In the specialized shape the two function slots are gone, so the frame is shorter: the extras
  // the producer carries, then the accumulator, then the source.
  // The frame is the producer's extras, then the accumulator, then the source — preceded by the two
  // function slots when they were not inlined away.
  const base = specialized ? 0 : 2;
  const cf = "p0";
  const ce = "p1";
  const extraParams = producer.extra.map((_, i) => `p${i + base}`);
  const cacc = `p${producer.extra.length + base}`;
  const csrc = `p${producer.extra.length + base + 1}`;

  // Everything the producer's element says is in terms of the producer's own parameters; the
  // traversed one becomes the fused function's `src`, and the rest become the fused extras.
  const elemMap = new Map<string, E>();
  elemMap.set(producer.f, v(ce));
  producer.extra.forEach((p, i) => elemMap.set(p, v(extraParams[i]!)));
  elemMap.set(producer.src, v(csrc));

  const srcMap = new Map<string, E>([[consumer.src, v(csrc)]]);

  /** The producer's element for one item of the source. */
  const elemExpr = (): E => {
    if (element === undefined) return subst(producer.elem, elemMap);
    // The element function applied to the head of the source, inlined: its parameter is bound to
    // the head, and everything else it says is its own body.
    const head = { type: "Prim", op: "car", args: [v(csrc)] } as E;
    const m = new Map<string, E>([[element.params[0]!, head]]);
    return subst(element.body, m);
  };

  /** The new accumulator, in terms of the old one. */
  const combineExpr = (): E => {
    const elem = elemExpr();
    if (combine === undefined) return { type: "Call", fn: v(cf), args: [v(cacc), elem] };
    const m = new Map<string, E>([
      [combine.params[0]!, v(cacc)],
      [combine.params[1]!, elem],
    ]);
    return subst(combine.body, m);
  };

  const recurseArgs = specialized
    ? [...extraParams.map(v), combineExpr(), subst(consumer.next, srcMap)]
    : [v(cf), v(ce), ...extraParams.map(v), combineExpr(), subst(consumer.next, srcMap)];

  const body: E = {
    type: "If",
    cond: subst(consumer.test, srcMap),
    then: v(cacc),
    alt: call(name, recurseArgs),
  };

  const params = specialized ? [...extraParams, cacc, csrc] : [cf, ce, ...extraParams, cacc, csrc];
  return {
    def: { type: "DefFun", name, params, body } as unknown as S13_Def,
    params,
  };
}

interface Ctx {
  readonly producers: Map<string, Producer>;
  readonly consumers: Map<string, Consumer>;
  readonly bodies: Map<string, Resolved>;
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
    bodies: new Map<string, Resolved>(),
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
          ctx.bodies.set(d.name, { params: d.params, body: d.body as unknown as E });
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
        const combineArg = headArgs[0];
        const elementArg = pargs[0];
        const pureCombine = combineArg !== undefined && knownPure(combineArg, ctx.bodies);
        const pureElement = elementArg !== undefined && knownPure(elementArg, ctx.bodies);
        if (!pureCombine && !pureElement) return [node as unknown as S13_Expr, ctx];

        // Both functions are literals written at this call site, so their bodies can be substituted
        // into the loop. See `fuse`.
        const combine = resolveClosure(combineArg, ctx.bodies);
        const element = resolveClosure(elementArg, ctx.bodies);
        const specialized = combine !== undefined && element !== undefined;

        const key = specialized
          ? `${consumer.name}|${producer.name}|${combineArg!.fn}|${elementArg!.fn}`
          : `${consumer.name}|${producer.name}`;
        let f = ctx.fused.get(key);
        if (f === undefined) {
          f = fuse(
            consumer,
            producer,
            combine,
            combineArg?.fn as string | undefined,
            element,
            elementArg?.fn as string | undefined,
          );
          ctx.fused.set(key, f);
          ctx.added.push(f.def);
        }

        // The two function slots are dropped from the call when they were inlined away, and the
        // element function's slot is the producer's first parameter, not one of its extras.
        const extraArgs = pargs.slice(1, -1);
        const srcArg = pargs[pargs.length - 1]!;
        const accArg = args[args.length - 2]!;
        const fnArgs = specialized ? extraArgs : [...headArgs, elementArg!, ...extraArgs];

        return [call(f.def.name, [...fnArgs, accArg, srcArg]) as unknown as S13_Expr, ctx];
      },
    },
  },
});

export const deforest = buildWalker(spec).run;
export const deforestSpec = spec;
