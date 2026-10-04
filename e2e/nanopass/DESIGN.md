# Nanopass language chain design

## Purpose

Exercises the core nanopass features:
- Language declarations (`language()`)
- Derivation (`derive()`)
- Pass declarations (`pass()`)
- Traversal and pattern matching

## The chain

```
L0  source language
 ↓  [desugar-let]
L1  let removed, lambda application only
 ↓  [explicit-refs]
L2  references explicit, with binding depth
 ↓  [flatten]
L3  flattened expressions (temporaries)
```

The full chain (declared in `languages.ts`) continues to L10: free-variable
analysis, boxing, closure conversion, lambda lifting, explicit control flow,
basic blocks, and a final instruction form. Only L0–L3 have implemented passes.

### L0: source

- `Int` literal
- `Var` reference
- `Lambda` (`param`, `body`)
- `App` (`func`, `arg`)
- `Let` (`name`, `val`, `body`)
- `Add`, `Mul`

### L1: after desugaring

`let` is removed, rewritten to a lambda application:

```
(let ([x 1]) body)  =>  ((lambda (x) body) 1)
```

### L2: explicit references

Every variable reference carries its binding depth:

```
Var{name}  =>  Ref{name, depth}
```

### L3: flattened

Nested expressions are hoisted into temporaries:

```
(+ (+ 1 2) 3)  =>  Seq{ bindings: [Temp{0, (+ 1 2)}], result: (+ t0 3) }
```

## Test plan

1. Language declarations type-check
2. `derive()` inherits and modifies correctly
3. Each pass transforms correctly
4. The composed pipeline runs end to end

## Implementation order

1. Declare L0–L3 (`languages.ts`) — done
2. Implement passes (`passes.ts`) — done
3. Compose and test (`pipeline.ts`, `example.ts`, tests) — done
