# e2e

The framework's own test suite. It exercises the two layers — `src/nanopass/` and `src/ssa/` — and
it is not a shipped compiler. The test programs are vehicles for the framework.

There are three suites. Two test a layer on its own; the third uses both together, because a layer
that is correct alone can still be unusable together, and that is exactly the kind of defect that
survives a green build.

| Suite | Tests |
|-------|-------|
| `nanopass/` | the tree-rewriting layer: codegen, fusion, the threading model, derivation |
| `ssa/` | the graph layer: Braun, the analyses, the verifier, the pass manager |
| `scheme/` | a micro-Scheme compiler written *on* both layers, run by an interpreter |

## Layout

```
e2e/
  nanopass/
    langs/          *.lang.ts      language declarations
    passes/         *.pass.ts      transformations
    fixtures/       *.ts           corpora
    tests/          *.test.ts
    bench.ts                       scaling: a walk must be linear in the tree
  ssa/
    ir.ts                          the instruction set the tests are written against
    tests/          *.test.ts
    bench.ts                       scaling: an analysis must be linear in the block count
  scheme/
    reader.ts                      text -> s-expressions
    surface.ts                     s-expressions -> S0
    langs/chain.ts                 the language chain, S0..S14, read top to bottom
    passes/                        one construct per pass
    pipeline.ts                    the chain, composed; fused and unfused
    lower.ts                       S14 -> basic blocks
    tail-to-loop.ts                a self tail call becomes a jump
    ir.ts                          the compiler's SSA instruction set, and its SSAOps
    ssa-passes/                    optimization passes, written on the framework
    optimize.ts                    the pass list, run to a fixpoint
    interp.ts                      runs the optimized SSA IR; the oracle
    run.ts                         source -> running program, the one place that knows the chain
    fixtures/       *.ts           programs and their expected output
    tree-interp.ts                 interprets S0 directly; the row with no compiler
    bench/                         the corpus, hand-written baselines, the report
    tests/          *.test.ts
```

## Naming

| Kind | Pattern | Example |
|------|---------|---------|
| Language declaration | `*.lang.ts` | `nanopass/langs/toy.lang.ts` |
| Language **chain** | `*.chain.ts` | `scheme/langs/chain.ts` |
| Pass, cross-language | `*.<from>-><to>.pass.ts` | `nanopass/passes/begin-elim.T0->T1.pass.ts` |
| Pass, same language | `*.<lang>.pass.ts` | `scheme/ssa-passes/cse.ssa.pass.ts` |
| Test | `*.test.ts` | `nanopass/tests/fusion.test.ts` |
| Fixture / corpus | `*.ts` under `fixtures/` | `scheme/fixtures/programs.ts` |

Notes:

- A **chain** is one artifact: a run of languages where each layer differs from its neighbour by one
  construct. It lives in one `*.chain.ts` file, read top to bottom, rather than one tiny file per
  layer. A standalone language uses `*.lang.ts`.
- A pass file exports both the runnable function and the pass **spec**. Fusion needs the spec;
  everything else needs the function. Export both rather than re-deriving one from the other.
- No `*.md.ts`. Documentation is `*.md`.
- No folder that exists only to hold a README. If a folder has no code yet, it does not exist yet.

## What the nanopass tests must cover

The framework claims: declare a language and a pass, and get a correct, type-safe, **fusable**
walker. So the tests are about those claims, not about any particular compiler:

- **codegen correctness** — a pass transforms what it says it transforms
- **fusion** — a fused run produces the same tree as running the passes one at a time
  (`tests/fusion.test.ts`; this is the guardrail fusion's correctness rests on, and it is not
  optional)
- **type safety** — wrong handlers are rejected at compile time (`@ts-expect-error` negatives)
- **extra values** — the threading model (a child's returned extra feeds the next sibling)
- **identity reuse** — an unchanged subtree keeps its reference
- **derive** — removed productions are gone from the type, and *the runtime agrees with the type*
- **scaling** — `bench.ts`: pass execution is linear in input size

## What the SSA tests must cover

The framework claims: Braun produces correct SSA, the analyses are correct, and the pass manager
schedules and invalidates correctly. So:

- **Braun** — phi placement, and `verifySSA` accepts the result
- **dominator tree** — against known immediate dominators
- **loops**, **use-def chains**
- **verifier** — it rejects what is actually wrong, and only that
- **pass manager** — analysis caching, invalidation, fixed-point iteration
- **scaling** — `bench.ts`: every analysis is linear in the block count

## The `scheme/` suite

A micro-Scheme compiler, end to end, on both layers. It exists because each layer passing its own
tests does not mean the two fit together: the lowering has to produce exactly the shape the SSA
construction expects, and getting that wrong produces code that is well-formed by every local check
and wrong at runtime.

```
source -> reader -> surface -> S0
       -> nanopass passes -> S14
       -> lowering -> basic blocks
       -> self tail calls become jumps
       -> Braun -> SSA
       -> SSA passes -> optimized SSA
       -> interpreter -> value, instructions, frames, allocations
```

The pipeline is checked in two shapes, and both are needed:

- **fused and unfused agree**, byte for byte, over the fixture corpus
- **optimized and unoptimized agree**, in output and in value, with the IR verified after every pass

The interpreter is the oracle. There is no second evaluator: it runs the optimized SSA, and the
expected values in `fixtures/programs.ts` are worked out by hand from the source. That is why the
fixtures are small and each says what it covers.

`bench/` is the exception to "small": it is where the question the project exists to ask — does
functional code run like C — is answered. Four rows per program, and they are not four measurements
of the same thing:

| row | what it is | what it answers |
|-----|-----------|-----------------|
| `interpreted` | the same source, run by `tree-interp.ts`, no compiler | what compiling buys |
| `compiled` | the same source, SSA passes off | what the SSA passes buy |
| `optimized` | the same source, passes on | |
| `hand-written` | **a different program**, C style, in `baselines.ts` | what the algorithm costs |

The `hand-written` row is not a baseline for the compiler: it is a different program. It is the row
that says what the source's choice of algorithm costs — `map-fold` builds two lists and calls two
closures per element where a C programmer writes one loop — and it is the only row that can be read
as "how far is the functional style from the C style".

## What is not here

- **No CFG layer.** There are two layers, nanopass (trees) and SSA (blocks). A graph of basic blocks
  is what an SSA function *is*, not a separate stage.
- **No production optimization passes in `src/`.** The framework ships algorithms and infrastructure.
  The passes under `scheme/ssa-passes/` are written *on* the framework, from `e2e/`, and are the
  framework's exercise rather than part of it.
- **No lowering between layers as a framework feature.** That bridge is user code, and
  `scheme/lower.ts` is the user code that proves the bridge is expressible.

## Running

```bash
pnpm test              # everything
pnpm test:nanopass     # one suite
pnpm test:ssa
pnpm bench:nanopass    # scaling: log-log slope over n/2n/4n/8n
pnpm bench:ssa
pnpm bench:scheme      # interpreted vs compiled vs optimized vs hand-written, per program
```

Both scaling benchmarks exit non-zero on a flagged slope. A gate that always passes is worse than no
gate.
