# SSA Test Suite

Test passes and fixtures for the SSA optimization framework.

## Structure

```
e2e/ssa/
├── passes/          # Test optimization passes
│   ├── dce.ts       # Dead code elimination
│   ├── sccp.ts      # Sparse conditional constant propagation
│   ├── mem2reg.ts   # Memory to register promotion
│   └── cfg.ts       # CFG simplification
├── tests/           # Pass correctness tests
│   ├── braun.test.ts       # Braun construction tests
│   ├── domtree.test.ts     # Dominator tree tests
│   ├── passes.test.ts      # Optimization pass tests
│   └── manager.test.ts     # Pass manager tests
└── fixtures/        # Test IR programs
    ├── simple.ts    # Basic blocks and branches
    ├── loops.ts     # Loop constructs
    └── phi.ts       # Phi node placement
```

## Test Passes

These passes are for **testing the SSA framework only**, not production use.

### Dead Code Elimination (DCE)
- Removes unused definitions
- Tests: usedef chains, CFG traversal

### Sparse Conditional Constant Propagation (SCCP)
- Propagates constants through phi nodes
- Tests: worklist algorithm, lattice values

### Mem2Reg
- Promotes memory to SSA registers
- Tests: Braun construction, phi insertion

### CFG Simplification
- Removes unreachable blocks
- Merges single-predecessor blocks
- Tests: dominator tree, CFG modification

## Running Tests

```bash
pnpm test:ssa              # Run all SSA tests
pnpm test:ssa:passes       # Test optimization passes
pnpm test:ssa:analysis     # Test analysis passes
pnpm test:ssa:perf         # Performance benchmarks
```

## Fixtures

Fixtures are hand-written SSA IR programs used for testing:

- `simple.ts`: Basic blocks, branches, simple control flow
- `loops.ts`: Natural loops, nested loops, loop exits
- `phi.ts`: Phi node placement, merging values from multiple paths
- `complex.ts`: Real-world patterns (nested loops + conditionals)

Each fixture includes:
- The SSA function definition
- Expected analysis results (domtree, loops, etc.)
- Expected optimization results
