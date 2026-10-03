# e2e/nanopass

Tests for nanopass framework (tree rewriting layer).

## Structure

- `langs/` - Test language definitions (Lsrc, L1, L2, ..., L10)
- `passes/` - Test passes (structural rewrites)
- `tests/` - Framework tests (fusion, type safety, performance)
- `fixtures/` - Test programs (nested-let, closures, etc.)

## What this tests

- Tree rewriting correctness
- Pass fusion
- Type safety (errors caught by TypeScript)
- Performance (O(n) guarantee)
- Deep nesting without stack overflow
