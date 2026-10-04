/**
 * SSA IR definition (minimal, generic)
 *
 * The framework provides minimal control-flow nodes (phi, jump, branch, ret, unreachable).
 * Users extend the IR with their own instruction types via the generic parameter T.
 *
 * Type display: uses Expand<> to unfold type aliases so hovering/errors show the flattened union,
 * not `MinimalIS | T`.
 */

/**
 * Expand utility: distributes union aliases so type display shows flattened members,
 * not named aliases. Uses identity distribution — no structural change, just forces
 * TypeScript to inline each union member rather than keeping the alias name.
 */
type Expand<T> = T extends unknown ? T : never;

export type ValueId = string;
export type BlockId = string;
export type FunctionId = string;

// Minimal instruction set (framework-provided)
export type PhiNode = {
  readonly type: "phi";
  readonly dest: ValueId;
  readonly incoming: ReadonlyArray<readonly [BlockId, ValueId]>;
};

// Minimal terminator set
export type JumpNode = {
  readonly type: "jump";
  readonly target: BlockId;
};

export type BranchNode = {
  readonly type: "branch";
  readonly cond: ValueId;
  readonly ifTrue: BlockId;
  readonly ifFalse: BlockId;
};

export type RetNode = {
  readonly type: "ret";
  readonly value?: ValueId;
};

export type UnreachableNode = {
  readonly type: "unreachable";
};

export type MinimalTerminator = JumpNode | BranchNode | RetNode | UnreachableNode;

/**
 * Instruction (non-terminator)
 *
 * Minimal: phi (for SSA merge points)
 * Users extend via T
 */
export type Instruction<T = never> = Expand<PhiNode | T>;

/**
 * Terminator (control-flow)
 *
 * Minimal: jump, branch, ret, unreachable
 * Users extend via T
 */
export type Terminator<T = never> = Expand<MinimalTerminator | T>;

/**
 * Basic block
 */
export interface BasicBlock<T = never> {
  id: BlockId;
  instructions: Instruction<T>[];
  terminator: Terminator<T>;
  predecessors: BlockId[];
  successors: BlockId[];
}

/**
 * Function in SSA form
 */
export interface SSAFunction<T = never> {
  id: FunctionId;
  blocks: Map<BlockId, BasicBlock<T>>;
  entry: BlockId;
}

/**
 * SSA module (collection of functions)
 */
export interface SSAModule<T = never> {
  functions: Map<FunctionId, SSAFunction<T>>;
  entry: FunctionId;
}

/**
 * Helper: get successors of a block from its terminator
 */
export function getSuccessors<T>(term: Terminator<T>): BlockId[] {
  if (typeof term === "object" && term !== null && "target" in term) return [term.target];
  if (typeof term === "object" && term !== null && "ifTrue" in term && "ifFalse" in term) return [term.ifTrue, term.ifFalse];
  return [];
}

/**
 * Helper: check if instruction is a minimal phi node
 */
export function isPhi<T>(inst: Instruction<T>): inst is PhiNode {
  return typeof inst === "object" && inst !== null && "type" in inst && inst.type === "phi";
}

/**
 * Helper: get all phi nodes in a block
 */
export function getPhiNodes<T>(block: BasicBlock<T>): PhiNode[] {
  return block.instructions.filter(isPhi);
}
