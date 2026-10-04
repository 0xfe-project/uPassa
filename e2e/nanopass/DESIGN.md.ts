/**
 * Nanopass Language Chain Design
 *
 * Complete transformation pipeline from surface syntax to CFG-ready IR.
 * Each pass does ONE focused transformation.
 *
 * Design principles:
 * - Each language adds or removes exactly one construct
 * - No pass does two conceptually different things
 * - Passes should be composable and testable in isolation
 * - Follow Chez Scheme's nanopass approach
 */

/**
 * Language Chain Overview
 * =======================
 *
 * L0: Surface language with let bindings
 *     Productions: Let, Var, Lambda, App, Add, Mul, Int
 *
 * L1: Desugar let to lambda application
 *     - Let → (lambda (x) body) applied to value
 *     Productions: Var, Lambda, App, Add, Mul, Int
 *
 * L2: Explicit variable references with binding depth
 *     - Var → Ref (with depth for lexical scope)
 *     Productions: Ref, Lambda, App, Add, Mul, Int
 *
 * L3: Flatten nested expressions
 *     + Seq: sequence of temporaries
 *     + Temp: temporary binding
 *     Productions: Ref, Lambda, App, Add, Mul, Int, Seq, Temp
 *
 * L4: Identify free variables (closure analysis)
 *     + Lambda: add free variable list
 *     - Track which variables escape their binding scope
 *     Productions: Ref, Lambda (with free vars), App, Add, Mul, Int, Seq, Temp
 *
 * L5: Box mutable variables
 *     + Box: heap-allocated mutable cell
 *     + BoxSet: mutation
 *     + BoxGet: dereference
 *     - Any variable that might be mutated is boxed
 *     Productions: Ref, Lambda, App, Add, Mul, Int, Seq, Temp, Box, BoxSet, BoxGet
 *
 * L6: Convert closures to explicit records
 *     + Closure: explicit closure record (code + environment)
 *     - Lambda → ClosureMake (code pointer + captured vars)
 *     - App on closure → ClosureCall
 *     Productions: Ref, Closure, ClosureMake, ClosureCall, Add, Mul, Int, Seq, Temp, Box, BoxSet, BoxGet
 *
 * L7: Lift lambdas to top level
 *     + TopLevel: program with top-level functions
 *     + FunDef: top-level function definition
 *     - All closures become top-level functions with explicit env parameter
 *     - Closure records only store function ID + captured values
 *     Productions: TopLevel, FunDef, Ref, ClosureMake, ClosureCall, Add, Mul, Int, Seq, Temp, Box, BoxSet, BoxGet
 *
 * L8: Make control flow explicit
 *     + If: conditional (branch)
 *     + Loop: while loop
 *     + Break/Continue: loop control
 *     - All implicit control flow made explicit
 *     Productions: TopLevel, FunDef, If, Loop, Break, Continue, Ref, ClosureCall, Add, Mul, Int, Seq, Temp, Box, BoxSet, BoxGet
 *
 * L9: Flatten to basic blocks (A-normal form)
 *     + Block: labeled basic block
 *     + Jump: unconditional jump
 *     + Branch: conditional jump
 *     - All expressions are atomic (no nested calls)
 *     - Control flow is explicit jumps
 *     Productions: TopLevel, FunDef, Block, Jump, Branch, Ref, ClosureCall, Add, Mul, Int, Temp, Box, BoxSet, BoxGet
 *
 * L10: Final IR (ready for SSA construction)
 *     + Instruction: generic instruction form
 *     + Terminator: block terminator (jump/branch/return)
 *     - Ready to convert to CFG and run Braun algorithm
 *     Productions: TopLevel, FunDef, Block, Instruction, Terminator
 */

/**
 * Pass Responsibilities
 * =====================
 *
 * Pass 1: desugarLet (L0 → L1)
 * - Transform let bindings to lambda applications
 * - Simple syntactic transformation
 *
 * Pass 2: explicitRefs (L1 → L2)
 * - Convert Var to Ref with binding depth
 * - Track lexical environment depth
 *
 * Pass 3: flatten (L2 → L3)
 * - Flatten nested expressions to temporaries
 * - Introduce Seq and Temp nodes
 *
 * Pass 4: analyzeFree (L3 → L4)
 * - Compute free variable sets for each lambda
 * - Mark which variables need to be captured
 *
 * Pass 5: boxMutables (L4 → L5)
 * - Identify mutable variables (for now, none - but structure is ready)
 * - Insert Box/BoxSet/BoxGet for mutable cells
 *
 * Pass 6: convertClosures (L5 → L6)
 * - Convert lambdas to explicit closure records
 * - Transform applications to closure calls
 *
 * Pass 7: liftLambdas (L6 → L7)
 * - Lift all lambdas to top level
 * - Generate top-level function definitions
 *
 * Pass 8: explicitControl (L7 → L8)
 * - Make control flow explicit (if, loop, break, continue)
 * - Prepare for CFG construction
 *
 * Pass 9: blockify (L8 → L9)
 * - Convert to basic blocks with explicit jumps
 * - A-normal form with labeled blocks
 *
 * Pass 10: lower (L9 → L10)
 * - Final lowering to generic instruction form
 * - Ready for CFG construction and SSA
 */

/**
 * Testing Strategy
 * ================
 *
 * 1. Unit tests for each pass
 *    - Simple input → expected output
 *    - Identity cases (no transformation needed)
 *    - Edge cases (deeply nested, empty, etc.)
 *
 * 2. Integration tests
 *    - Full pipeline: L0 → L10
 *    - Verify each intermediate representation
 *
 * 3. Property tests
 *    - Type preservation (well-typed input → well-typed output)
 *    - No information loss
 *    - Free variables correctly tracked
 *
 * 4. Performance tests
 *    - O(n) guarantee for each pass
 *    - Measure compilation time vs AST size
 */

export type LanguageChain = {
  L0: "Surface with let";
  L1: "Lambda application";
  L2: "Explicit refs";
  L3: "Flattened";
  L4: "Free variable analysis";
  L5: "Boxed mutables";
  L6: "Explicit closures";
  L7: "Top-level functions";
  L8: "Explicit control flow";
  L9: "Basic blocks";
  L10: "Final IR";
};
