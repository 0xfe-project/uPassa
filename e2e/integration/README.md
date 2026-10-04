# Integration Tests

End-to-end tests for the complete compilation pipeline:

**Source → Nanopass → SSA → Optimized**

## Purpose

Validates that the two frameworks work together correctly:
- Nanopass performs high-level tree transformations
- Lower to SSA IR for graph-based optimizations
- Verify correctness through the entire pipeline

## Structure

```
e2e/integration/
├── lower.ts           # L_final → SSA lowering
├── pipeline.ts        # Complete compilation pipeline
├── tests/             # End-to-end tests
│   ├── simple.test.ts      # Basic programs
│   ├── closures.test.ts    # Closure conversion → SSA
│   └── optimize.test.ts    # Full optimization chain
└── fixtures/          # Source programs
    ├── factorial.ts
    ├── fibonacci.ts
    └── nested-closures.ts
```

## Pipeline Stages

### 1. Nanopass Chain (Tree Transformations)
High-level semantic transformations:
- `Lsrc` → `L1`: Desugar syntax
- `L1` → `L2`: Alpha rename
- `L2` → `L3`: Mark free variables
- `L3` → `L4`: Box mutable variables
- `L4` → `L5`: Convert closures (flat closures)
- `L5` → `L6`: Optimize known calls
- `L6` → `L7`: Lift lambdas
- `L7` → `L8`: Convert to continuation-passing style (optional)
- `L8` → `L9`: Simplify control flow
- `L9` → `L_final`: Lower to explicit control flow

**Result:** Tree with explicit control flow, no nested expressions

### 2. Lowering (Tree → CFG)
Convert final tree to SSA input:
- Build basic blocks
- Generate explicit jumps and branches
- Prepare for SSA construction

### 3. SSA Construction (CFG → SSA)
Use Braun algorithm:
- Insert phi nodes at merge points
- Rename variables to SSA form
- Build def-use chains

### 4. SSA Optimization
Graph-based transformations:
- Sparse conditional constant propagation (SCCP)
- Dead code elimination (DCE)
- CFG simplification
- Loop optimizations (if applicable)

## Example

```typescript
import { compileProgram } from "./pipeline.ts";

const source = `
  (define (factorial n)
    (if (<= n 1)
        1
        (* n (factorial (- n 1)))))
`;

const result = compileProgram(source, {
  enableNanopassOpts: true,
  enableSSAOpts: true,
  maxIterations: 5,
});

console.log(result.optimizedSSA);
```

## Running Tests

```bash
pnpm test:integration       # All integration tests
pnpm test:e2e              # Nanopass + SSA + integration
```

## Validation

Each test validates:
1. **Correctness**: Output matches expected semantics
2. **Optimization**: Dead code removed, constants folded
3. **SSA properties**: Proper phi placement, single assignment
4. **Performance**: Linear time complexity maintained
