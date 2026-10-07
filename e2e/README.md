# e2e

Tests for the two framework layers. This is the framework's own test suite — it exercises the
framework implementations, not a shipped compiler. Test programs are vehicles for that.

## Naming conventions

| Kind | Pattern | Example |
|------|---------|---------|
| Language declaration | `*.lang.ts` | `langs/toy.lang.ts` |
| Language **chain** | `langs/*.chain.ts` | `scheme/langs/chain.ts` |
| Pass, cross-language | `*.<from>-><to>.pass.ts` | `passes/begin-elim.T0->T1.pass.ts` |
| Pass, same language | `*.<lang>.pass.ts` | `passes/fold-const.T2.pass.ts` |
| Test | `*.test.ts` | `tests/fusion.test.ts` |
| Fixture / corpus | `*.ts` under `fixtures/` | `fixtures/toy-corpus.ts` |

Notes:

- A **chain** is one artifact: a run of languages where each layer differs from its neighbour by one
  construct. It lives in one `*.chain.ts` file, read top to bottom, rather than one tiny file per
  layer. A standalone language uses `*.lang.ts`.
- A pass file exports both the runnable function and the pass **spec**. Fusion needs the spec;
  everything else needs the function. Export both rather than re-deriving one from the other.
- No `*.md.ts`. Documentation is `*.md`.
- No folder that exists only to hold a README. If a folder has no code yet, it does not exist yet.

## Layout

```
e2e/
  nanopass/
    langs/      *.lang.ts        language declarations
    passes/     *.pass.ts        transformations
    fixtures/   *.ts             corpora
    tests/      *.test.ts        framework tests
  ssa/
    passes/     *.ts             test optimization passes (not framework deliverables)
    fixtures/   *.ts             hand-built SSA functions
    tests/      *.test.ts
  integration/
    tests/                       end-to-end: source -> nanopass -> SSA -> interpreter
```

## What the nanopass tests must cover

The framework claims: declare a language and a pass, and get a correct, type-safe, **fusable**
walker. So the tests are about those claims, not about any particular compiler:

- **codegen correctness** — a pass transforms what it says it transforms
- **fusion** — a fused run produces the same tree as running the passes one at a time
  (`tests/fusion.test.ts`; this is the guardrail that fusion's correctness rests on)
- **type safety** — wrong handlers are rejected at compile time (`@ts-expect-error` negatives)
- **extra values** — the threading model (a child's returned extra feeds the next sibling)
- **identity reuse** — an unchanged subtree keeps its reference
- **derive** — removed productions are gone from the type
- **scaling** — pass execution is linear in input size

## What the SSA tests must cover

The framework claims: Braun produces correct SSA, the analyses are correct, and the pass manager
schedules and invalidates correctly. So:

- **Braun** — phi placement, and `verifySSA` accepts the result
- **dominator tree** — against known immediate dominators
- **loops**, **use-def chains**
- **pass manager** — analysis caching, invalidation, fixed-point iteration
- **scaling** — linear

## What is not here

- No production optimization passes. The SSA passes under `ssa/passes/` exist to test the pass
  infrastructure; they are not deliverables.
- No lowering from nanopass to SSA as a framework feature. That bridge is user code, written in
  `integration/`.

## Running

```bash
pnpm test              # everything
pnpm test:nanopass     # this layer only
pnpm test:ssa
pnpm bench:nanopass    # scaling checks (log-log slope)
pnpm bench:ssa
```
