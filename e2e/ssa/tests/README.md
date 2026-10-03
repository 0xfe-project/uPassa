# SSA Tests

Correctness and performance tests for the SSA framework.

## Test Categories

### `braun.test.ts` - Braun Construction
Tests SSA construction from imperative control flow:
- Variable definitions and uses
- Phi node insertion at merge points
- Nested control flow
- Loop back edges

### `domtree.test.ts` - Dominator Tree
Tests dominator tree construction:
- Immediate dominators
- Dominance frontiers
- Dominator queries
- Edge cases (unreachable blocks, diamonds, loops)

### `passes.test.ts` - Optimization Passes
Tests individual optimization passes:
- DCE removes dead code
- SCCP propagates constants
- Mem2Reg promotes allocations
- CFG simplification preserves semantics

### `manager.test.ts` - Pass Manager
Tests pass orchestration:
- Dependency resolution
- Analysis caching
- Invalidation
- Fixed-point iteration
- Statistics collection

### `performance.test.ts` - Performance Benchmarks
Measures framework overhead:
- Braun construction time (should be linear)
- Dominator tree construction
- Analysis computation
- Pass execution

## Running Tests

```bash
# All SSA tests
pnpm test:ssa

# Individual categories
pnpm test e2e/ssa/tests/braun.test.ts
pnpm test e2e/ssa/tests/domtree.test.ts
pnpm test e2e/ssa/tests/passes.test.ts
pnpm test e2e/ssa/tests/manager.test.ts

# Performance only
pnpm test:ssa:perf
```

## Test Fixtures

Tests use fixtures from `../fixtures/`:
- Pre-built SSA functions
- Expected analysis results
- Reference transformations
