# uPassa

A meta-framework for building language frontends in TypeScript.

Two layers, independent:

- **nanopass** — functional tree rewriting. Declare languages, declare passes, get type-safe walkers generated from the declarations.
- **ssa** — graph-based optimization infrastructure. Build SSA from a control-flow graph, compute analyses, run passes.

The framework ships **algorithms and infrastructure**, not a compiler. Languages, passes, and the lowering between layers are the user's.

## Install

```bash
pnpm add upassa
```

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

### SSA construction (Braun)

```typescript
import { toSSA, type PreSSAFunction } from "upassa/ssa";

const ssa = toSSA(preFunc);
```

Braun's algorithm inserts phi nodes lazily during renaming — no dominance
frontier computation needed upfront.

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
  infrastructure to write them.
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
```

## Development

```bash
pnpm check             # Type check
pnpm fmt               # Format
pnpm test              # Run all tests
pnpm test:nanopass     # Nanopass tests
pnpm test:ssa          # SSA tests
```
