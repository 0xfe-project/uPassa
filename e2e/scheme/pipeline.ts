/**
 * The nanopass pipeline, composed.
 *
 * Read top to bottom: source text goes in, S14 comes out, ready for the lowering. Each entry names
 * one pass and carries the spec it was built from, so the same list drives both the plain run and
 * the fused run — a pass cannot be added to one and forgotten in the other.
 *
 * ── Fusion
 *
 * A contiguous run of passes can be collapsed into a single traversal when they agree on their
 * nonterminal names and none of them threads extra values. That is a real speedup and it is
 * optional, so it is a flag rather than the only path: `tests/fusion.test.ts` runs the pipeline
 * both ways over the same programs and asserts the outputs are byte-identical. Fusing changes
 * evaluation order — a later pass in a group sees an earlier pass's rewrite of the same node, but
 * not yet of that node's children — so "the output is the same" is a property that has to be
 * checked, not assumed.
 */

import { buildFusedGroup, canFuse, type WalkerSpec } from "../../src/nanopass/index.ts";
import { parse } from "./surface.ts";
import type { S0_Program, S14_Program } from "./langs/chain.ts";

import { desugarDefFun, desugarDefFunSpec } from "./passes/desugar-def-fun.S0->S1.pass.ts";
import { removeWhenUnless, removeWhenUnlessSpec } from "./passes/remove-when-unless.S1->S2.pass.ts";
import { removeCond, removeCondSpec } from "./passes/remove-cond.S2->S3.pass.ts";
import { removeAndOrNot, removeAndOrNotSpec } from "./passes/remove-and-or-not.S3->S4.pass.ts";
import { expandLetStar, expandLetStarSpec } from "./passes/expand-let-star.S4->S5.pass.ts";
import { removeIfAlt, removeIfAltSpec } from "./passes/remove-if-alt.S5->S6.pass.ts";
import { normalizeBegin, normalizeBeginSpec } from "./passes/normalize-begin.S6->S7.pass.ts";
import { alphaRename, alphaRenameSpec } from "./passes/alpha-rename.S7->S8.pass.ts";
import { normalizeLet, normalizeLetSpec } from "./passes/normalize-let.S8->S9.pass.ts";
import { resolvePrimitives, resolvePrimitivesSpec } from "./passes/resolve-primitives.S9->S10.pass.ts";
import { uncoverFree, uncoverFreeSpec } from "./passes/uncover-free.S10->S11.pass.ts";
import { convertClosures, convertClosuresSpec } from "./passes/convert-closures.S11->S12.pass.ts";
import { liftLambdas, liftLambdasSpec } from "./passes/lift-lambdas.S12->S13.pass.ts";
import { markTail, markTailSpec } from "./passes/mark-tail.S13->S14.pass.ts";

export interface PipelineStep {
  /** File-name stem of the pass, so a failure names the pass that produced it. */
  readonly name: string;
  readonly spec: WalkerSpec;
  /**
   * The pass's own entry point.
   *
   * Used for passes that cannot be fused — a pass with extra values controls its own descent, so
   * it cannot be collapsed into a shared traversal and has to be run on its own.
   */
  readonly run: (node: never) => unknown;
}

/** The passes, in the order the chain in `langs/chain.ts` declares. */
export const PIPELINE: readonly PipelineStep[] = [
  { name: "desugar-def-fun", spec: desugarDefFunSpec, run: desugarDefFun },
  { name: "remove-when-unless", spec: removeWhenUnlessSpec, run: removeWhenUnless },
  { name: "remove-cond", spec: removeCondSpec, run: removeCond },
  { name: "remove-and-or-not", spec: removeAndOrNotSpec, run: removeAndOrNot },
  { name: "expand-let-star", spec: expandLetStarSpec, run: expandLetStar },
  { name: "remove-if-alt", spec: removeIfAltSpec, run: removeIfAlt },
  { name: "normalize-begin", spec: normalizeBeginSpec, run: normalizeBegin },
  { name: "alpha-rename", spec: alphaRenameSpec, run: alphaRename },
  { name: "normalize-let", spec: normalizeLetSpec, run: normalizeLet },
  { name: "resolve-primitives", spec: resolvePrimitivesSpec, run: resolvePrimitives },
  { name: "uncover-free", spec: uncoverFreeSpec, run: uncoverFree },
  { name: "convert-closures", spec: convertClosuresSpec, run: convertClosures },
  { name: "lift-lambdas", spec: liftLambdasSpec, run: liftLambdas },
  { name: "mark-tail", spec: markTailSpec, run: markTail },
];

/** Every production tag a language declares, across all its nonterminals. */
function tagsOf(lang: { rules: Record<string, Record<string, unknown>> }): Set<string> {
  const tags = new Set<string>();
  for (const prods of Object.values(lang.rules)) for (const tag of Object.keys(prods)) tags.add(tag);
  return tags;
}

/** The tags a pass handles. */
function handles(spec: WalkerSpec): Set<string> {
  const tags = new Set<string>();
  for (const rules of Object.values(spec.rules)) {
    if (rules !== null && typeof rules === "object") for (const tag of Object.keys(rules)) tags.add(tag);
  }
  return tags;
}

/**
 * Whether `a`'s output introduces a tag that `b` handles and `a`'s input did not have.
 *
 * A tag that is new in the output can only have been *synthesised* by `a` rather than rewritten
 * from an input node. A synthesised node is only seen by `b` if `a` happened to pass it through
 * `rec`; when `a` builds it inside a parent's handler instead, `b` never sees it and its rule
 * silently does nothing.
 *
 * That is not hypothetical: `lift-lambdas` builds the `DefFun` wrappers inside its `Program`
 * handler, so fusing it with `mark-tail` loses every tail marker on a lifted body. The rule above
 * finds that without anyone having to remember it.
 *
 * This is a *necessary* condition, not a sufficient one — it cannot see a pass that synthesises a
 * tag its input already had. `tests/pipeline.test.ts` runs the whole pipeline both ways and asserts
 * the outputs are byte-identical, which is what actually keeps this honest.
 */
function introducesHandledTag(a: PipelineStep, b: PipelineStep): boolean {
  const before = tagsOf(a.spec.from);
  const after = tagsOf(a.spec.to);
  const bHandles = handles(b.spec);
  for (const tag of after) {
    if (!before.has(tag) && bHandles.has(tag)) return true;
  }
  return false;
}

/**
 * Group the passes into the longest contiguous runs that may be fused.
 *
 * A group ends at a pass that threads extra values — fusion requires arity 0, since a fused
 * traversal has one extra-value channel and the passes in it would have to agree on its type — and
 * before a pass that would synthesise a node the next pass handles.
 */
export function fusionGroups(
  steps: readonly PipelineStep[] = PIPELINE,
): readonly (readonly PipelineStep[])[] {
  const groups: PipelineStep[][] = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    const fits =
      last !== undefined &&
      prev !== undefined &&
      !introducesHandledTag(prev, step) &&
      canFuse([...last.map((s) => s.spec), step.spec]);
    if (fits) last.push(step);
    else groups.push([step]);
  }
  return groups;
}

/** Run the pipeline one pass at a time. */
export function runUnfused(program: S0_Program): S14_Program {
  let cur: unknown = program;
  for (const step of PIPELINE) {
    cur = runStep(step, cur);
  }
  return cur as S14_Program;
}

/** Run the pipeline with every fusable group collapsed into a single traversal. */
export function runFused(program: S0_Program): S14_Program {
  let cur: unknown = program;
  for (const group of fusionGroups()) {
    if (group.length === 1) {
      cur = runStep(group[0]!, cur);
      continue;
    }
    cur = buildFusedGroup(group.map((s) => s.spec)).run(cur);
  }
  return cur as S14_Program;
}

/**
 * Run one pass.
 *
 * The specs are typed for their own languages; the pipeline is a chain of unknown-to-unknown steps
 * because TypeScript cannot follow a list of dependent pairs. The pass that produced a bad node is
 * named in the error so a failure points at it rather than at the end of the pipeline.
 */
function runStep(step: PipelineStep, node: unknown): unknown {
  try {
    return step.run(node as never);
  } catch (e) {
    throw new Error(`[${step.name}] ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

export interface CompileOptions {
  /** Collapse contiguous fusable groups into one traversal. Default false. */
  readonly fuse?: boolean;
}

/** Source text to S14. */
export function compile(source: string, opts: CompileOptions = {}): S14_Program {
  const program = parse(source);
  return (opts.fuse ?? false) ? runFused(program) : runUnfused(program);
}
