# SSA Test Fixtures

Hand-written SSA IR programs for testing.

## Fixtures

### `simple.ts`
Basic control flow patterns:
- Straight-line code
- Simple branches (if-then-else)
- Multiple successors
- Block merging

### `loops.ts`
Loop constructs:
- Simple counted loops
- While loops
- Nested loops
- Loop exits and breaks
- Back edges

### `phi.ts`
Phi node patterns:
- Two-way merge (if-then-else)
- Multi-way merge (switch)
- Loop phi nodes
- Nested merges

### `complex.ts`
Real-world patterns:
- Nested loops with conditionals
- Early returns
- Multiple exit paths
- Deep control flow

## Structure

Each fixture exports:

```typescript
export const fixture = {
  name: "fixture-name",
  func: SSAFunction,           // The IR
  expectedDomTree: DomTree,     // Expected dominator tree
  expectedLoops: LoopInfo,      // Expected loop structure
  expectedUsedef: UseDefChains, // Expected use-def chains
};
```

## Usage

```typescript
import { simpleIfThenElse } from "../fixtures/simple.ts";
import { buildDomTree } from "../../../src/ssa/analysis/domtree.ts";

test("dominator tree for if-then-else", () => {
  const domtree = buildDomTree(simpleIfThenElse.func);
  expect(domtree).toEqual(simpleIfThenElse.expectedDomTree);
});
```
