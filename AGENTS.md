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

`e2e/scheme/` is a micro-Scheme compiler written *on* the framework. It is a test
vehicle, not a deliverable — and it is the only thing that checks the two layers fit
together, which is where the interesting bugs live.

## Standing discipline (every change)

1. **fmt** — `pnpm fmt`
2. **check** — `pnpm check` (`tsc --noEmit`)
3. **test** — `pnpm test` (vitest)
4. **bench** — `pnpm bench:nanopass` / `pnpm bench:ssa` when touching hot paths
5. **commit** — one change per commit; the message says what and why.
   **Quote file names containing `>`** — `cat > x.S0->S1.pass.ts` is a redirect: the
   content lands in `S1.pass.ts` and an empty stub is left behind, and `pnpm check`
   does not catch it because the stray file is outside the tsconfig include.
6. **English only** — code, comments, commit messages, docs, READMEs

## Node and TypeScript constraints

**Tests run `.ts` directly under node** (v24 strip-only mode: types erased, no
codegen). Two consequences:

1. **Write only "erasable" TS.** `enum`, `namespace`, and parameter properties
   (`constructor(private x: T)`) throw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
   (Tests run under vitest now, which tolerates more, but the constraint stays: the
   library is consumed by tools that do not.)
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
- **(b) block-local** — only within its own block
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

The scaling benchmarks (`bench:nanopass`, `bench:ssa`) fit a **log-log slope** over
n / 2n / 4n / 8n (linear = 1.00, quadratic = 2.00, > 1.25 flags superlinear), end to
end rather than between consecutive sizes — one noisy pair would otherwise fail the
gate for no reason. A single ratio is too noisy to gate on — a gate that flaps gets
ignored.

The sizes have to be large enough that the measurement is not dominated by noise. At a
few milliseconds the slope is whatever the scheduler did; `bench:nanopass` starts at
25,000 nodes for that reason, and builds a **balanced** tree, because a left-leaning
tree of that size is 200,000 levels deep and a recursive walker overflows the stack
before it finishes.

Two traps, both hit before:

1. **Do not build the fixture inside the timed region.** Otherwise you measure
   allocation and GC, not the algorithm. Build the input once, time the work.
2. **Call `gc()` before each run** (`--expose-gc` is passed by the scripts).
   On an uncontrolled heap you cannot distinguish "superlinear algorithm" from
   "GC got expensive".

The benchmarks have already caught two real quadratics — see the commit
"fix two real quadratics". Keep them honest: if you change a hot path, re-run.

## Measuring the compiler against something

`bench:scheme` reports **four rows**, and they answer four different questions. Reading
one as another is the mistake this section exists to prevent:

| row | what it is | what it answers |
|-----|-----------|-----------------|
| `interpreted` | the same source, no compiler | what compiling buys |
| `compiled` | the same source, SSA passes off | what the SSA passes buy |
| `optimized` | the same source, passes on | |
| `hand-written` | **a different program** | what the algorithm costs |

The `hand-written` row is the same computation in C style — loops instead of recursion,
no intermediate data. It is not the same source, so it is **not** a baseline for the
compiler. It was the only baseline in the first version of the report, which meant "how
good is the compiler" was being answered by comparing two different algorithms.

Two rules follow, and both were broken:

1. **A baseline has to be the same program.** To ask what compiling buys, run the same
   source without a compiler. `e2e/scheme/tree-interp.ts` is that.
2. **Do not cripple the baseline.** The source interpreter implements tail calls. Without
   a trampoline a 100,000-iteration loop overflows the JS stack, and the compiler's
   advantage would read as "it can run the program at all" — true, and the largest single
   thing compiling buys, but it would hide how much *work* is saved. A baseline that
   cannot run the program is not a baseline.

Comparisons are stated in words, never as a bare ratio: **fewer instructions is less
work**, and a ratio whose direction is only implied gets read the wrong way. This file's
report once labelled a division `optimized/hand-written` while dividing the other way
round, which turned the worst result in the corpus into the best-looking one. A test now
pins the direction.

The counters are defined in "Counting what a program does" above. For the interpreted
row the unit is coarser — one tree node plus one variable reference — and its omissions
(chain depth, dispatch, the frame a `let` allocates) are all in the direction of making
it look cheaper, so the factor between the rows is a lower bound on what compiling saved.

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
  nanopass/     languages, passes, fixtures, tests, bench.ts (walk scaling)
  ssa/          test IR, tests, bench.ts (analysis scaling)
  scheme/       the micro-Scheme compiler: chain, passes, lowering, SSA passes,
                interpreter, benchmarks
```

- `src/` is the library. It contains **no language** — languages are the user's.
- `e2e/` is the framework's own test suite, not a shipped compiler.
- There is **no CFG layer**. Two layers: nanopass (trees) and SSA (blocks). A graph
  of basic blocks is what an SSA function *is*, not a separate stage.

## Contracts between the pieces (each one was broken once)

**`derive()` removes before it adds, at the type level and at runtime.** The runtime
did it the other way, so `remove: ["Lambda"], add: { Expr: { Lambda: ... } }` deleted
the production it had just redefined, and `tsc` stayed green because the types still
claimed it existed. If you change one, change both, and add a case to the tests.

**Fusion: a group ends before a pass that would synthesise a node the next pass
handles.** A tag that is new in a pass's output can only have been synthesised rather
than rewritten, and a synthesised node is only seen by the next pass if the pass
happened to pass it through `rec`. `lift-lambdas` builds its `DefFun` wrappers inside
its `Program` handler, so fusing it with `mark-tail` silently dropped every tail
marker. `canFuse` is necessary, not sufficient — the guard test in
`e2e/nanopass/tests/fusion.test.ts` is what actually holds the claim up.

**The verifier does not check that every use is defined.** A name a function never
defines is external — a parameter, a frame slot, a global — and the framework cannot
tell that from a typo. Requiring phi operands to be defined looked like a safe half of
it and is not: a phi merging two parameters has exactly that shape and is correct. What
is checkable about a phi is structural, and `checkPhiPlacement` checks it.

**Braun's input is variable-based and contains no phis.** Its walk skips phis it did not
create, so a phi placed by hand is silently ignored and its operands go stale. A value
produced in two places is named by a `copy` in each — one variable, two definitions —
and the construction puts the phi where they meet.

**Anything that assigns to a frame slot runs *before* the SSA construction, never
after.** A slot assigned twice is what SSA forbids; the construction is what turns the
two definitions into a phi. `e2e/scheme/tail-to-loop.ts` is the case in point, and
getting the order wrong is quiet: the header's frame reads resolve to the bare
parameter name, which looks exactly like a phi with one operand after the trivial-phi
rule has removed it.

**A rewrite that reorders two traversals needs an effect condition.** Deforestation turns
`(fold f a (map g xs))` into one loop, which interleaves `g` and `f` where they used to run
one after the other. If both do something observable, that is a different program —
demonstrated: with both printing, the unfused order is `1,2,0` and the fused order is
`1,0,2`. With only one of them effectful the relative order of the effects is unchanged,
so the condition is **at least one of the two must be pure**, checked at the call site
against the closure actually passed. Syntactic purity of the body cannot decide it:
`(f acc (car xs))` contains a call in both the safe and the unsafe case.

**A pass must not report a change it has already made.** CSE rewrote uses only in the
block that found the duplicate, so readers in other blocks kept the old name live, DCE
could not remove the instruction, and every round found the same duplicate again. The
pipeline never reached a fixpoint. When a pass rewrites a value, it rewrites the
readers everywhere.

**A pass that needs the whole program cannot be fused, and that is the correct
classification.** Deciding whether a call site fuses needs to know which functions are
producers and which are consumers, so `deforest` threads its tables through `sig`. A pass
with extra values controls its own descent, so `canFuse` says no. The first version did
its own traversal and merged the fused function into the tree without going through the
walker; a fused `mark-tail` then never saw it and every tail marker on a fused loop was
silently dropped — the same bug `lift-lambdas` had.

**New code in a non-recursive traversal may need an explicit visit.** A node synthesised
inside a handler and not passed to `rec` is invisible to every later pass in a fused
group. Same root cause as the fusion rule above.

## Counting what a program does

Wall-clock measures the interpreter, not the compiled code. What is counted, in
`e2e/scheme/interp.ts`:

- **instructions** — one per instruction executed, plus one per frame slot written on
  entry to a call. **Phi nodes and terminators are not counted**: a phi names a merge of
  values that already exist and the register allocator resolves it away, and counting
  phis but not terminators would decide "did this tail call become a loop" by the
  counting rather than by the program — and decide it backwards, since the loop form has
  phis where the call form has a terminator.
- **frames** — frames allocated. A tail call **reuses** the caller's frame; that is what
  a tail call is. Allocating a fresh one per iteration made the frame count measure the
  interpreter's bookkeeping.
- **allocs** — heap allocations: pairs and closures.

Both sides of every comparison go through the same counter, including the hand-written
baselines. If a number moves, check that the counter did not.
