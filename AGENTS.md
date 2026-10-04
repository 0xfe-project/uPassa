# Working in this repository

## What this project is

**uPassa** — a meta-framework for building language frontends in TypeScript.

Two independent layers:

- **`src/nanopass/`** — functional tree rewriting. You declare languages
  (`language()`, `derive()`), declare passes (`pass()`), and the framework
  generates type-safe walkers from the declarations.
- **`src/ssa/`** — graph optimization infrastructure. Braun SSA construction,
  dominator trees, loop detection, use-def chains, a pass manager.

The framework ships **algorithms and infrastructure**. It does not ship a
compiler: no optimization passes, no backend, no lowering between layers.

## Standing discipline (every change)

1. **fmt** — `pnpm fmt`
2. **check** — `pnpm check` (`tsc --noEmit`)
3. **test** — `pnpm test` (vitest)
4. **bench** — `pnpm bench:nanopass` / `pnpm bench:ssa` when touching hot paths
5. **commit** — one change per commit; the message says what and why
6. **English only** — code, comments, commit messages, docs, READMEs

## Node and TypeScript constraints

**Tests run `.ts` directly under node** (v24 strip-only mode: types erased, no
codegen). Two consequences:

1. **Write only "erasable" TS.** `enum`, `namespace`, and parameter properties
   (`constructor(private x: T)`) throw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
   `tsconfig.json` has **`erasableSyntaxOnly: true`** to catch this at
   `pnpm check` — do not turn it off. Use string-literal unions instead of enums.
2. **Verify with a real node.** On this machine `node` may be a Bun shim, and
   Bun **tolerates** the syntax node rejects. A change that is green locally can
   fail under a real node. Gate through `pnpm <script>` (which uses real node).

## Type system pitfall: TS2589 (solved — do not re-solve it)

**Symptom**: a pass with rules on `Program` and a `sig` fails with TS2589
(instantiation excessively deep) when a handler lacks a return annotation.

**Cause**: without a return annotation, TS infers the output language from the
handler's return position, which is `Ret<O, NT, Ctx>` = `[NodeOf<O, NT>, ...]`.
`NodeOf` is a mapped type — inferring from a mapped type explodes.

**Fix**: the `NoInfer<Rules<F, O, Ctx>>` on the `rules` parameter in
`src/nanopass/pass.ts`. It forces inference from `from` / `to` / `sig` only —
which is where it should come from; all three are explicitly written.

**It is not about derive depth.** The old note blamed the `MergeRules<...>`
chain. Measured: 0 layers (a plain `language()` literal) explodes the same way.

Annotations are optional but recommended — they change error quality by an
order of magnitude (TS2322 "type X not assignable to type Y" vs. TS2719 "two
different types with this name exist").

## Performance discipline: no O(n²)

Scope: framework code plus the test passes in `e2e/`.

Every superlinear spot is either fixed or documented as exempt, with a reason:

- **(a) local** — inside one function, n is bounded
- **(b) CFG-local** — only within its own block
- **(c) parallelizable** — a pure map with no cross-element ordering

Patterns to watch for:

| Smell | Why it is bad |
|-------|---------------|
| Nested traversal of the same tree | re-walks the subtree at every level |
| Per-node full-table lookup / deep compare | n nodes × O(n) table |
| Fixed-point judged by deep comparison | k rounds → O(k·n); use a counter/hash |
| Linear scan to find a block by label | use a Map |
| Building an array of strings then `join` | only fine for constant size |
| `queue.shift()` in a worklist | O(array length) → O(n²); use a cursor |

## Benchmark discipline

The benchmarks fit a **log-log slope** over n / 2n / 4n / 8n (linear = 1.00,
quadratic = 2.00, > 1.25 flags superlinear). A single ratio is too noisy to gate
on — a gate that flaps gets ignored.

Two traps, both hit before:

1. **Do not build the fixture inside the timed region.** Otherwise you measure
   allocation and GC, not the algorithm. Build the input once, time the work.
2. **Call `gc()` before each run** (`--expose-gc` is passed by the scripts).
   On an uncontrolled heap you cannot distinguish "superlinear algorithm" from
   "GC got expensive".

The benchmarks have already caught two real quadratics — see the commit
"fix two real quadratics". Keep them honest: if you change a hot path, re-run.

## SSA IR: minimal and generic

The framework owns only control flow:

```ts
PhiNode | JumpNode | BranchNode | RetNode | UnreachableNode
```

Users extend via a type parameter `T`:

```ts
Instruction<T> = Expand<PhiNode | T>
Terminator<T>  = Expand<MinimalTerminator | T>
```

- `Expand<T>` is **identity distribution** (`T extends unknown ? T : never`).
  A key-remapping version (`{ [K in keyof U]: U[K] }`) breaks discriminated-union
  narrowing — do not use one.
- Because `T` is unconstrained, TS cannot narrow `Expand<T>` by `.type` alone.
  Write type guards defensively:
  `typeof x === "object" && x !== null && "type" in x && x.type === "phi"`.
- Framework algorithms are generic over `T`; user instructions flow through
  untouched. Do not teach the framework about user instruction semantics.

## SSA layer is a library, not codegen

Tree traversal can be generated from a declaration — the shape is local and
enumerable. Graph algorithms cannot: the shape is global, cyclic, and shares
nodes. `src/ssa/walker.ts` is hand-written traversal utilities. There is no
SSA codegen, deliberately.

## Exit codes must be real

A gate that always passes is worse than no gate: you think it is guarding
something. Test scripts must return a non-zero exit code on failure.

## Structure

```
src/
  nanopass/     lang.ts, pass.ts, pipeline.ts, codegen.ts
  ssa/          ir.ts, braun.ts, walker.ts, verify.ts, pass.ts,
                pass-manager.ts, analysis/{domtree,loops,usedef}.ts
e2e/
  nanopass/     languages, passes, pipeline, fixtures, tests
  ssa/          test passes, pipeline, fixtures, tests
  integration/  lowering + end-to-end tests
```

- `src/` is the library. It contains **no language** — languages are the user's.
- `e2e/` is the framework's own test suite, not a shipped compiler.
