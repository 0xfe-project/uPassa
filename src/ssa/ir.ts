/**
 * SSA IR (minimal, generic)
 *
 * The framework owns control flow and phi nodes. Everything else — arithmetic, calls, memory,
 * whatever your language needs — is your `T`, and the framework never looks inside it.
 *
 *   Instruction<T> = PhiNode | T
 *   Terminator<T>  = MinimalTerminator | T
 *
 * Framework algorithms (`toSSA`, `buildDomTree`, `detectLoops`, ...) are generic over `T`. They can
 * only read and rewrite operands of your nodes through `SSAOps<T>`, which you implement.
 *
 * The IR is **mutable**. Braun renames operands and inserts phis in place; SSA passes transform in
 * place. There is no fusion and no immutable reconstruction at this layer — that is the nanopass
 * layer's model, not this one.
 */

/**
 * Identity distribution. Keeps type display flat (hovering `Instruction<MyNodes>` shows the
 * members, not `PhiNode | MyNodes`) and does not break discriminated-union narrowing.
 *
 * Do not replace this with a key-remapping mapped type (`{ [K in keyof U]: U[K] }`): that breaks
 * narrowing on `.type`, because TS can no longer see the discriminant through the mapping.
 */
type Expand<T> = T extends unknown ? T : never;

export type ValueId = string;
export type BlockId = string;
export type FunctionId = string;

// ───────────────────────── Framework-owned nodes ─────────────────────────

/**
 * The tags the framework owns. Your `T` must not use them.
 *
 * Dispatch is by tag, so the framework can tell its own nodes from yours: a `phi` is the
 * framework's, a `jump`/`branch`/`ret`/`unreachable` is the framework's, anything else is yours.
 * This is why `T` must have a `type` field.
 */
export type ReservedTag = "phi" | "jump" | "branch" | "ret" | "unreachable";

/** The reserved tags, for runtime checks and for tests that pin the convention. */
export const RESERVED_TAGS: readonly ReservedTag[] = ["phi", "jump", "branch", "ret", "unreachable"];

/**
 * A phi node: `dest = phi(...)`.
 *
 * `incoming` holds one `[predecessor, value]` pair per incoming edge. It is a mutable array:
 * Braun appends to it while a block is still unsealed, then fills it in when the block is sealed.
 */
export type PhiNode = {
  type: "phi";
  dest: ValueId;
  incoming: Array<[BlockId, ValueId]>;
};

export type JumpNode = {
  type: "jump";
  target: BlockId;
};

export type BranchNode = {
  type: "branch";
  cond: ValueId;
  ifTrue: BlockId;
  ifFalse: BlockId;
};

export type RetNode = {
  type: "ret";
  value?: ValueId;
};

export type UnreachableNode = {
  type: "unreachable";
};

export type MinimalTerminator = JumpNode | BranchNode | RetNode | UnreachableNode;

/**
 * An instruction: the framework's phi, or one of your nodes.
 */
export type Instruction<T = never> = Expand<PhiNode | T>;

/**
 * A terminator: one of the framework's, or one of your nodes.
 */
export type Terminator<T = never> = Expand<MinimalTerminator | T>;

export interface BasicBlock<T = never> {
  id: BlockId;
  instructions: Instruction<T>[];
  terminator: Terminator<T>;
  predecessors: BlockId[];
  successors: BlockId[];
}

export interface SSAFunction<T = never> {
  id: FunctionId;
  blocks: Map<BlockId, BasicBlock<T>>;
  entry: BlockId;
}

export interface SSAModule<T = never> {
  functions: Map<FunctionId, SSAFunction<T>>;
  entry: FunctionId;
}

// ───────────────────────── Operand access: SSAOps ─────────────────────────

/**
 * How the framework reads and rewrites the operands of **your** nodes.
 *
 * The framework cannot know which field of your instruction is the destination and which are
 * operands, so you say. Implement these four for your `T`; the framework's own nodes are handled
 * by the framework.
 *
 * ```ts
 * type MyInstr =
 *   | { type: "const"; dest: string; value: number }
 *   | { type: "add"; dest: string; left: string; right: string };
 *
 * const ops: SSAOps<MyInstr> = {
 *   def: (i) => i.dest,
 *   uses: (i) => (i.type === "add" ? [i.left, i.right] : []),
 *   setDef: (i, n) => { i.dest = n; },
 *   setUse: (i, from, to) => {
 *     if (i.type === "add") {
 *       if (i.left === from) i.left = to;
 *       if (i.right === from) i.right = to;
 *     }
 *   },
 * };
 * ```
 *
 * ── Why `setUse` is by name, not by operand index
 *
 * Every read of a variable must become the same SSA value, so rewriting by name is what you want.
 * It also survives structural edits: an index would go stale the moment an operand list changes.
 * A self-referential instruction (`x = x + 1`) is safe because `setUse` only touches **reads** —
 * the destination belongs to `setDef`.
 *
 * ── Nodes with no destination
 *
 * `def` returns `undefined` for instructions that produce no value (a store, a call returning
 * nothing). That is not an error.
 */
export interface SSAOps<T> {
  /** The variable this instruction defines, or `undefined` if it defines none. */
  def(inst: T): ValueId | undefined;

  /** The variables this instruction reads. Order does not matter; duplicates are harmless. */
  uses(inst: T): readonly ValueId[];

  /** Rewrite the destination to `name`. */
  setDef(inst: T, name: ValueId): void;

  /**
   * Rewrite every **read** of `from` to `to`.
   *
   * Must not touch the destination — that is `setDef`'s job.
   */
  setUse(inst: T, from: ValueId, to: ValueId): void;

  /**
   * Successor blocks of one of your terminators.
   *
   * Omit this if your terminators have no successors (the common case — most languages use the
   * framework's `jump`/`branch`/`ret`). The framework cannot guess: `getSuccessors` only knows its
   * own terminators.
   */
  successors?(term: T): readonly BlockId[];
}

/**
 * Identity helper: gives `ops` a contextual type so the four methods are inferred.
 *
 * ```ts
 * const ops = ssaOps<MyInstr>({ def: (i) => i.dest, ... });
 * ```
 */
export function ssaOps<T>(ops: SSAOps<T>): SSAOps<T> {
  return ops;
}

// ───────────────────────── Guards ─────────────────────────

/** Is this one of the framework's own nodes (rather than a node from `T`)? */
export function isFrameworkNode(node: { type?: string }): boolean {
  return typeof node.type === "string" && (RESERVED_TAGS as readonly string[]).includes(node.type);
}

export function isPhi<T>(node: Instruction<T>): node is PhiNode {
  return typeof node === "object" && node !== null && "type" in node && node.type === "phi";
}

export function isJump<T>(term: Terminator<T>): term is JumpNode {
  return typeof term === "object" && term !== null && "type" in term && term.type === "jump";
}

export function isBranch<T>(term: Terminator<T>): term is BranchNode {
  return typeof term === "object" && term !== null && "type" in term && term.type === "branch";
}

export function isRet<T>(term: Terminator<T>): term is RetNode {
  return typeof term === "object" && term !== null && "type" in term && term.type === "ret";
}

export function isUnreachable<T>(term: Terminator<T>): term is UnreachableNode {
  return typeof term === "object" && term !== null && "type" in term && term.type === "unreachable";
}

// ───────────────────────── Helpers ─────────────────────────

/** Successor block ids of a terminator, framework or user. Empty for `ret` and `unreachable`. */
export function getSuccessors<T>(term: Terminator<T>, ops?: SSAOps<T>): BlockId[] {
  if (isJump(term)) return [term.target];
  if (isBranch(term)) return [term.ifTrue, term.ifFalse];
  if (isRet(term) || isUnreachable(term)) return [];
  const fromUser = ops?.successors?.(term as T);
  return fromUser === undefined ? [] : [...fromUser];
}

/** All phi nodes in a block. Phis are required to come first, so this stops at the first non-phi. */
export function getPhiNodes<T>(block: BasicBlock<T>): PhiNode[] {
  const out: PhiNode[] = [];
  for (const inst of block.instructions) {
    if (!isPhi(inst)) break;
    out.push(inst);
  }
  return out;
}

/**
 * The variable a node defines, whether it is a framework node or one of yours.
 *
 * The cast is unavoidable: `Instruction<T>` is `PhiNode | T`, and after ruling out `PhiNode`, TS
 * still cannot conclude `T` (see the note on `Expand`). One cast, in one place.
 */
export function defOf<T>(node: Instruction<T>, ops: SSAOps<T>): ValueId | undefined {
  if (isPhi(node)) return node.dest;
  return ops.def(node as T);
}

/** The variables a node reads, whether it is a framework node or one of yours. */
export function usesOf<T>(node: Instruction<T>, ops: SSAOps<T>): readonly ValueId[] {
  if (isPhi(node)) return node.incoming.map(([, value]) => value);
  return ops.uses(node as T);
}

/** The variables a terminator reads, whether it is a framework terminator or one of yours. */
export function terminatorUses<T>(term: Terminator<T>, ops: SSAOps<T>): readonly ValueId[] {
  if (isBranch(term)) return [term.cond];
  if (isRet(term)) return term.value === undefined ? [] : [term.value];
  if (isJump(term) || isUnreachable(term)) return [];
  return ops.uses(term as T);
}

/** Rewrite every read of `from` to `to`, whether the node is a framework node or one of yours. */
export function rewriteUses<T>(node: Instruction<T>, ops: SSAOps<T>, from: ValueId, to: ValueId): void {
  if (isPhi(node)) {
    for (const entry of node.incoming) {
      if (entry[1] === from) entry[1] = to;
    }
    return;
  }
  ops.setUse(node as T, from, to);
}

/** Rewrite every read of `from` to `to` in a terminator. */
export function rewriteTerminatorUses<T>(
  term: Terminator<T>,
  ops: SSAOps<T>,
  from: ValueId,
  to: ValueId,
): void {
  if (isBranch(term)) {
    if (term.cond === from) term.cond = to;
    return;
  }
  if (isRet(term)) {
    if (term.value === from) term.value = to;
    return;
  }
  if (isJump(term) || isUnreachable(term)) return;
  ops.setUse(term as T, from, to);
}
