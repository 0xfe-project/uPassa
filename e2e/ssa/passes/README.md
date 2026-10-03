# SSA Test Passes

Test optimization passes for validating the SSA framework.

## Purpose

These passes demonstrate how to use the SSA pass infrastructure and serve as test cases for:
- Pass declaration API
- Analysis computation and caching
- IR transformation
- Pass manager scheduling

**These are test passes, not production optimizations.**

## Passes

### `dce.ts` - Dead Code Elimination
Removes instructions whose results are never used.

**Requires:** `usedef`  
**Invalidates:** `usedef`

### `sccp.ts` - Sparse Conditional Constant Propagation
Propagates constants and folds operations.

**Requires:** `domtree`, `usedef`  
**Invalidates:** `usedef`

### `mem2reg.ts` - Memory to Register Promotion
Promotes memory allocations to SSA values using Braun construction.

**Requires:** `domtree`  
**Invalidates:** `usedef`

### `cfg.ts` - CFG Simplification
Simplifies control flow graph:
- Remove unreachable blocks
- Merge blocks with single predecessor/successor
- Eliminate empty blocks

**Requires:** `domtree`  
**Invalidates:** `domtree`, `usedef`, `loops`

## Usage Example

```typescript
import { pipeline } from "../../src/ssa/pass-manager.ts";
import { dce } from "./passes/dce.ts";
import { sccp } from "./passes/sccp.ts";
import { simplifyControlFlow } from "./passes/cfg.ts";

// Build optimization pipeline
const opts = pipeline()
  .add(sccp)
  .add(dce)
  .add(simplifyControlFlow)
  .build();

// Run on function
opts.runOnFunction(func, { maxIterations: 5 });
```
