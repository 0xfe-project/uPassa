# uPassa

A meta-framework for building language frontends in TypeScript.

Two layers, independent:

- **nanopass** — functional tree rewriting. Declare languages, declare passes, get type-safe walkers generated from the declarations.
- **ssa** — graph-based optimization infrastructure. Braun SSA construction, dominator trees, loop detection, use-def chains, a pass manager.

There is no separate CFG layer: a graph of basic blocks is what an SSA function *is*.

The framework ships **algorithms and infrastructure**, not a compiler. Languages, passes, and the lowering between layers are the user's.

## Status

Not published. `package.json` is `private: true`; this repository is the framework
and its own test suite, and nothing here is on a registry yet.

## nanopass: tree rewriting

Declare a language:

```typescript
import { language, list } from "upassa/nanopass";

const L0 = language({
  id: "L0",
  entry: "Expr",
  rules: {
    Expr: {
      Int: { value: "number" },
      Var: { name: "string" },
      Add: { left: "Expr", right: "Expr" },
      Lambda: { param: "string", body: "Expr" },
      App: { func: "Expr", arg: "Expr" },
      Let: { name: "string", val: "Expr", body: "Expr" },
    },
  },
});
```

Derive a new language (remove `Let`, add `Ref`):

```typescript
import { derive } from "upassa/nanopass";

const L1 = derive({
  id: "L1",
  base: L0,
  remove: ["Let"],
  add: { Expr: { Ref: { name: "string", depth: "number" } } },
});
```

Declare a pass:

```typescript
import { pass, buildWalker } from "upassa/nanopass";

const desugarLetPass = pass({
  from: L0,
  to: L1,
  rules: {
    Expr: {
      Let: (node, rec) => ({
        type: "App",
        func: { type: "Lambda", param: node.name, body: rec(node.body) },
        arg: rec(node.val),
      }),
    },
  },
});

const desugarLet = buildWalker(desugarLetPass).run;
```

The walker is generated from the language declarations. Handlers you do not
write are handled automatically (identity / structural recursion).

### Fusing a run of passes

A contiguous run of passes can be collapsed into **one traversal** instead of one
per pass:

```typescript
import { canFuse, buildFusedGroup } from "upassa/nanopass";

if (canFuse([p1, p2, p3])) {
  const fused = buildFusedGroup([p1, p2, p3]);
  const out = fused.run(input);
}
```

`canFuse` requires the passes to agree on their nonterminal names and to thread no
extra values. It is a **necessary** condition, not a sufficient one: fusion changes
evaluation order, and whether that is safe depends on what each pass inspects. The
guarantee comes from checking, so check — run the pipeline both ways and compare the
output. `e2e/nanopass/tests/fusion.test.ts` is the worked example, and it is the
reason a silent deletion of this feature was found at all.

## ssa: graph optimization

The SSA IR is minimal: the framework defines control-flow nodes (`phi`, `jump`,
`branch`, `ret`, `unreachable`). You extend it with your own instruction types
via a type parameter:

```typescript
import type { SSAFunction, Instruction } from "upassa/ssa";

type MyInstr =
  | { type: "const"; dest: string; value: number }
  | { type: "add"; dest: string; left: string; right: string };

type MyFunction = SSAFunction<MyInstr>;
```

The framework's algorithms (`toSSA`, `buildDomTree`, `detectLoops`,
`buildUseDefChains`, `verifySSA`) are generic over your extension. They only
look at the control-flow nodes; your instructions flow through untouched.

### Telling the framework about your operands

The framework cannot know which field of your instruction is a destination.
You say so once, with `SSAOops<T>`:

```typescript
import type { SSAOps } from "upassa/ssa";

const ops: SSAOps<MyInstr> = {
  def: (i) => ("dest" in i ? i.dest : undefined),
  uses: (i) => (i.type === "add" ? [i.left, i.right] : []),
  setDef: (i, name) => { if ("dest" in i) i.dest = name; },
  setUse: (i, from, to) => {
    if (i.type !== "add") return;
    if (i.left === from) i.left = to;
    if (i.right === from) i.right = to;
  },
};
```

Every algorithm that reads or rewrites your operands takes it. Phis, jumps,
branches and returns the framework handles itself.

### SSA construction (Braun)

```typescript
import { toSSA } from "upassa/ssa";

const ssa = toSSA(fn, ops);   // SSAFunction<T> in, SSAFunction<T> out
```

One shape in, the same shape out. Operands are **variable names** on the way in
and SSA value names on the way out: an instruction's `dest` is read as the name
of a variable, and a value produced in two places is one variable with two
definitions. **Do not place phis yourself** — the walk skips phis it did not
create, so one placed by hand is silently ignored and its operands go stale.

Instructions are **ordered**, which is what makes `x = 1; x = 2` in one block two
different values and `x = x + 1` read the old one. A read that no definition
reaches stands for itself — that is how parameters and globals pass through.

Braun inserts phi nodes lazily during renaming — no dominance frontier
computation needed upfront.

### Passes and the pass manager

```typescript
import { ssaPass, PassManager } from "upassa/ssa";

const myPass = ssaPass<MyInstr>({
  name: "my-optimization",
  requires: ["domtree", "usedef"],
  invalidates: ["usedef"],
  run: (func, analyses) => {
    // transform func in place
    return { changed: true };
  },
});

const manager = new PassManager<MyInstr>();
manager.runOnFunction(func, [myPass]);
```

The manager computes analyses on demand, caches them, and invalidates them
when a pass says it changed the IR. It runs to a fixed point (with an
iteration cap).

## What the framework does not do

- **No optimization passes.** DCE, SCCP, LICM, vectorization — those are
  yours to write (or reuse from elsewhere). The framework gives you the
  infrastructure to write them. `e2e/scheme/ssa-passes/` is a worked example.
- **No lowering between layers.** Going from nanopass output to SSA input is
  a user-written transformation. Every language lowers differently.
- **No backend.** Instruction selection, register allocation, code emission
  are out of scope.

## Repository layout

```
src/
  nanopass/     Tree rewriting framework
    lang.ts       Language declarations and derivation
    pass.ts       Pass declarations
    pipeline.ts   Pipeline chain validation
    codegen.ts    Walker generation
  ssa/          Graph optimization framework
    ir.ts         Minimal IR (generic over user instructions)
    braun.ts      Braun SSA construction
    walker.ts     Block traversal utilities
    verify.ts     SSA invariant checker
    pass.ts       Pass declarations
    pass-manager.ts  Scheduling and analysis caching
    analysis/
      domtree.ts  Dominator tree
      loops.ts    Loop recognition
      usedef.ts   Use-def chains
e2e/            Framework tests (not shipped)
  nanopass/     Languages, passes, fixtures, tests, scaling bench
  ssa/          Test IR, tests, scaling bench
  scheme/       A micro-Scheme compiler written on both layers, run by an
                interpreter, with benchmarks against hand-written baselines
                and against the same source run with no compiler at all
```

## Development

```bash
pnpm check             # Type check
pnpm fmt               # Format
pnpm test              # Run all tests
pnpm test:nanopass     # Nanopass tests
pnpm test:ssa          # SSA tests
pnpm bench:nanopass    # Scaling: a walk must be linear in the tree
pnpm bench:ssa         # Scaling: an analysis must be linear in the block count
pnpm bench:scheme      # Interpreted vs compiled vs optimized vs hand-written SSA
```
