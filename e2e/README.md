# e2e: uPassa test suite

End-to-end tests for the two framework layers:
- **nanopass**: functional tree rewriting
- **ssa**: graph-based optimization

These tests are the framework's own tests — they exercise the framework
implementations, not a "reference compiler". The test programs (fixtures)
are just vehicles for that.

## Layout

```
e2e/
├── nanopass/          # Tree rewriting tests
│   ├── languages.ts   # Language chain L0 → L10
│   ├── passes.ts      # Transformation passes
│   ├── pipeline.ts    # Composed pipeline
│   ├── fixtures.ts    # Test programs
│   └── example.ts     # Runnable demo
├── ssa/               # Graph optimization tests
│   ├── passes.ts      # Test optimization passes
│   ├── pipeline.ts    # Composed optimization pipeline
│   ├── fixtures.ts    # Test CFGs
│   └── tests/         # Unit tests
└── integration/       # End-to-end tests
    └── tests/         # Full pipeline tests
```

## Running

```bash
pnpm test              # All tests
pnpm test:nanopass     # Nanopass tests only
pnpm test:ssa          # SSA tests only
pnpm example:nanopass  # Run the nanopass demo
```

## Nanopass layer

Tests the tree rewriting framework:

- **Language declarations** (`language()`, `derive()`)
- **Pass declarations** (`pass()` with rules)
- **Codegen** (generated walkers)
- **Transformations** (desugar, explicit refs, flatten)

### Language chain

```
L0  Surface language (let bindings)
 ↓  desugar-let
L1  Lambda application
 ↓  explicit-refs
L2  Explicit references (binding depth)
 ↓  flatten
L3  Flattened (temporaries)
```

The chain continues to L10 (declared in `languages.ts`) covering closure
conversion, lambda lifting, and control flow lowering. Only L0–L3 have
implemented passes so far.

## SSA layer

Tests the graph optimization framework:

- **Braun construction** (imperative CFG → SSA)
- **Dominator tree** (Lengauer-Tarjan)
- **Use-def chains**
- **Loop recognition**
- **Pass manager** (scheduling, analysis caching, invalidation)

### Test passes

These are **test passes only**, not framework deliverables:

| Pass | Purpose |
|------|---------|
| DCE | Remove unused instructions |
| SCCP | Fold constants |
| SimplifyCFG | Remove unreachable blocks |
| CopyProp | Propagate copies |
| Mem2Reg | (stub) Promote memory to registers |

## What is NOT tested here

- The framework does not ship production optimization passes
- The framework does not ship a complete compiler
- Lowering from nanopass output to SSA is the user's responsibility
