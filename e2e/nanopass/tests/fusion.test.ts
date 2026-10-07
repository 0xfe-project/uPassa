/**
 * Fusion guardrail.
 *
 * The claim fusion makes: for a run of passes, running them fused produces **the same tree** as
 * running them one at a time. This file is what holds that claim up.
 *
 * Why it exists as a test rather than as an argument: fusion is restricted to "same nonterminal
 * names + arity 0" because the analysis that would make it safe in general — "does any pass inspect
 * a child's tag before a later pass changes it?" — is not implemented. The restriction is a
 * heuristic; the guarantee comes from checking the output.
 *
 * Why this specific test exists: pipeline fusion was once deleted by a commit whose message said
 * only "reorganize directory structure", and the assertions that would have caught it were removed
 * in the same commit. Nothing went red. A guardrail that lives in the same commit as the thing it
 * guards is not a guardrail.
 */

import { describe, it, expect } from "vitest";
import { canFuse, buildFusedGroup } from "../../../src/nanopass/codegen.ts";
import type { WalkerSpec } from "../../../src/nanopass/codegen.ts";
import { beginElim, beginElimSpec } from "../passes/begin-elim.T0->T1.pass.ts";
import { negElim, negElimSpec } from "../passes/neg-elim.T1->T2.pass.ts";
import { foldConst, foldConstSpec } from "../passes/fold-const.T2.pass.ts";
import { addZero, addZeroSpec } from "../passes/add-zero.T2.pass.ts";
import { CORPUS } from "../fixtures/toy-corpus.ts";
import type { T0_Expr } from "../langs/toy.lang.ts";

/** The full chain, in pipeline order. */
const CHAIN = [
  { run: beginElim, spec: beginElimSpec },
  { run: negElim, spec: negElimSpec },
  { run: foldConst, spec: foldConstSpec },
  { run: addZero, spec: addZeroSpec },
] as const;

type Run = (n: any) => any;

/** Run passes one at a time. */
function runUnfused(input: unknown, passes: readonly Run[]): unknown {
  let x = input;
  for (const p of passes) x = p(x);
  return x;
}

/** Run passes as one fused traversal. */
function runFused(input: unknown, specs: readonly WalkerSpec[]): unknown {
  return buildFusedGroup(specs).run(input);
}

/** Stable serialization for comparison. */
function show(x: unknown): string {
  return JSON.stringify(x);
}

describe("fusion: canFuse", () => {
  it("accepts a single pass", () => {
    expect(canFuse([beginElimSpec as unknown as WalkerSpec])).toBe(true);
  });

  it("accepts a run of same-nonterminal, arity-0 passes", () => {
    expect(canFuse([beginElimSpec as unknown as WalkerSpec, negElimSpec as unknown as WalkerSpec])).toBe(
      true,
    );
  });

  it("accepts the whole chain", () => {
    expect(canFuse(CHAIN.map((c) => c.spec as unknown as WalkerSpec))).toBe(true);
  });

  it("rejects an empty group", () => {
    expect(canFuse([])).toBe(false);
  });

  it("rejects a group containing a pass with extra values (arity > 0)", () => {
    // neg-elim is arity 0, so borrow a spec that is not, by faking the field.
    const withExtra = { ...negElimSpec, arity: 1 } as unknown as WalkerSpec;
    expect(canFuse([beginElimSpec as unknown as WalkerSpec, withExtra])).toBe(false);
  });

  it("rejects a group whose nonterminal names differ", () => {
    const otherNames = {
      from: { id: "X", entry: "Expr", rules: { Thing: {} } },
      to: { id: "Y", entry: "Expr", rules: { Thing: {} } },
      arity: 0,
      rules: {},
    } as unknown as WalkerSpec;
    expect(canFuse([beginElimSpec as unknown as WalkerSpec, otherNames])).toBe(false);
  });
});

describe("fusion: fused output equals unfused output", () => {
  // Every contiguous run of the chain. Some are fusable, some are not; both are interesting.
  const runs: Array<{ label: string; start: number; end: number }> = [];
  for (let start = 0; start < CHAIN.length; start++) {
    for (let end = start + 1; end <= CHAIN.length; end++) {
      runs.push({
        label: `${CHAIN[start]!.spec.from.id}..${CHAIN[end - 1]!.spec.to.id}`,
        start,
        end,
      });
    }
  }

  for (const { label, start, end } of runs) {
    const group = CHAIN.slice(start, end);
    const specs = group.map((g) => g.spec as unknown as WalkerSpec);

    it(`run [${label}] (${group.length} pass${group.length > 1 ? "es" : ""})`, () => {
      expect(canFuse(specs)).toBe(true);

      // Bring the corpus to this run's input language by running the earlier passes unfused.
      const prefix = CHAIN.slice(0, start).map((c) => c.run as Run);

      let checked = 0;
      for (const tree of CORPUS as readonly T0_Expr[]) {
        const input = runUnfused(tree, prefix);
        const unfused = runUnfused(
          input,
          group.map((g) => g.run as Run),
        );
        const fused = runFused(input, specs);

        expect(show(fused)).toBe(show(unfused));
        checked++;
      }

      // Guard against a corpus that silently emptied out.
      expect(checked).toBe(CORPUS.length);
    });
  }
});

describe("fusion: trampoline path agrees with the recursive path", () => {
  it("produces the same tree for the whole chain", () => {
    const specs = CHAIN.map((c) => c.spec as unknown as WalkerSpec);
    const recursive = buildFusedGroup(specs).run;
    const tramp = buildFusedGroup(specs, { trampoline: true }).run;

    for (const tree of CORPUS as readonly T0_Expr[]) {
      expect(show(tramp(tree))).toBe(show(recursive(tree)));
    }
  });

  it("produces the same tree as running the passes one at a time", () => {
    const specs = CHAIN.map((c) => c.spec as unknown as WalkerSpec);
    const tramp = buildFusedGroup(specs, { trampoline: true }).run;

    for (const tree of CORPUS as readonly T0_Expr[]) {
      const unfused = runUnfused(
        tree,
        CHAIN.map((c) => c.run as Run),
      );
      expect(show(tramp(tree))).toBe(show(unfused));
    }
  });
});

describe("fusion: the corpus is not empty", () => {
  it("has enough shapes to be meaningful", () => {
    expect(CORPUS.length).toBeGreaterThan(100);
  });
});

// ───────────────────────── Regression pins ─────────────────────────
//
// Both of the following were latent bugs in the original fusion implementation. Neither showed up
// in the pipeline it was written for, because that pipeline happened not to contain the triggering
// shape. The guardrail above found them; these tests pin them so they cannot come back silently.

describe("fusion regression: a pass that changes a tag is seen by later passes", () => {
  // neg-elim rewrites Neg -> Sub. fold-const handles Sub. When fused, fold-const must see the
  // freshly created Sub — otherwise the fused run stops one step short of the unfused run.
  const specs = [negElimSpec as unknown as WalkerSpec, foldConstSpec as unknown as WalkerSpec];
  const tree = { type: "Neg", operand: { type: "Int", value: 3 } } as unknown as T0_Expr;

  it("recursive path folds the node the previous pass created", () => {
    expect(show(buildFusedGroup(specs).run(tree))).toBe(show({ type: "Int", value: -3, __lang__: "T2" }));
  });

  it("trampoline path folds the node the previous pass created", () => {
    expect(show(buildFusedGroup(specs, { trampoline: true }).run(tree))).toBe(
      show({ type: "Int", value: -3, __lang__: "T2" }),
    );
  });
});

describe("fusion regression: __lang__ comes from the last pass in the group", () => {
  // The group's result belongs to the last pass's output language. Using the first pass's output
  // language stamps every node with the wrong language — invisible in same-language groups, wrong
  // in cross-language ones.
  const specs = [beginElimSpec as unknown as WalkerSpec, negElimSpec as unknown as WalkerSpec];
  const tree = {
    type: "Begin",
    body: { type: "Neg", operand: { type: "Int", value: 3 } },
  } as unknown as T0_Expr;

  it("recursive path stamps the output language", () => {
    const out = buildFusedGroup(specs).run(tree) as { __lang__?: string };
    expect(out.__lang__).toBe("T2");
  });

  it("trampoline path stamps the output language", () => {
    const out = buildFusedGroup(specs, { trampoline: true }).run(tree) as { __lang__?: string };
    expect(out.__lang__).toBe("T2");
  });
});
