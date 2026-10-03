/**
 * SSA IR definition
 *
 * Core data structures for SSA-form intermediate representation.
 * Uses explicit φ nodes (not block parameters) for SSA construction.
 */

export type ValueId = string;
export type BlockId = string;
export type FunctionId = string;

/**
 * SSA value types
 */
export type ValueType = "int" | "float" | "bool" | "ptr" | "void";

/**
 * Binary operations
 */
export type BinOp =
  "add" | "sub" | "mul" | "div" | "mod" | "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "and" | "or";

/**
 * Unary operations
 */
export type UnOp = "neg" | "not";

/**
 * SSA instruction (non-terminator)
 */
export type Instruction =
  | { kind: "const"; id: ValueId; value: number | boolean; type: ValueType }
  | { kind: "phi"; id: ValueId; type: ValueType; incoming: Array<{ block: BlockId; value: ValueId }> }
  | { kind: "binop"; id: ValueId; op: BinOp; left: ValueId; right: ValueId; type: ValueType }
  | { kind: "unop"; id: ValueId; op: UnOp; operand: ValueId; type: ValueType }
  | { kind: "call"; id: ValueId; func: FunctionId; args: ValueId[]; type: ValueType }
  | { kind: "load"; id: ValueId; addr: ValueId; type: ValueType }
  | { kind: "store"; addr: ValueId; value: ValueId }
  | { kind: "alloca"; id: ValueId; type: ValueType };

/**
 * Basic block terminator
 */
export type Terminator =
  | { kind: "jmp"; target: BlockId }
  | { kind: "br"; cond: ValueId; then: BlockId; else: BlockId }
  | { kind: "ret"; value?: ValueId }
  | { kind: "unreachable" };

/**
 * Basic block
 */
export interface BasicBlock {
  id: BlockId;
  instructions: Instruction[];
  terminator: Terminator;
  predecessors: BlockId[];
  successors: BlockId[];
}

/**
 * Function in SSA form
 */
export interface SSAFunction {
  id: FunctionId;
  params: Array<{ id: ValueId; type: ValueType }>;
  returnType: ValueType;
  blocks: Map<BlockId, BasicBlock>;
  entry: BlockId;
}

/**
 * SSA module (collection of functions)
 */
export interface SSAModule {
  functions: Map<FunctionId, SSAFunction>;
  entry: FunctionId;
}

/**
 * Helper: get all φ nodes in a block
 */
export function getPhiNodes(block: BasicBlock): Instruction[] {
  return block.instructions.filter((i) => i.kind === "phi");
}

/**
 * Helper: get all non-φ instructions in a block
 */
export function getNonPhiInstructions(block: BasicBlock): Instruction[] {
  return block.instructions.filter((i) => i.kind !== "phi");
}

/**
 * Helper: get instruction by ID
 */
export function findInstruction(block: BasicBlock, id: ValueId): Instruction | undefined {
  return block.instructions.find((i) => "id" in i && i.id === id);
}

/**
 * Helper: get all defined values in a block
 */
export function getDefinedValues(block: BasicBlock): Set<ValueId> {
  const defined = new Set<ValueId>();
  for (const inst of block.instructions) {
    if ("id" in inst) {
      defined.add(inst.id);
    }
  }
  return defined;
}

/**
 * Helper: get all used values in an instruction
 */
export function getUsedValues(inst: Instruction | Terminator): ValueId[] {
  switch (inst.kind) {
    case "const":
    case "alloca":
      return [];
    case "phi":
      return inst.incoming.map((p) => p.value);
    case "binop":
      return [inst.left, inst.right];
    case "unop":
      return [inst.operand];
    case "call":
      return inst.args;
    case "load":
      return [inst.addr];
    case "store":
      return [inst.addr, inst.value];
    case "jmp":
    case "unreachable":
      return [];
    case "br":
      return [inst.cond];
    case "ret":
      return inst.value ? [inst.value] : [];
  }
}

/**
 * Helper: replace a use in an instruction
 */
export function replaceUse(inst: Instruction | Terminator, oldId: ValueId, newId: ValueId): void {
  switch (inst.kind) {
    case "phi":
      for (const incoming of inst.incoming) {
        if (incoming.value === oldId) {
          incoming.value = newId;
        }
      }
      break;
    case "binop":
      if (inst.left === oldId) inst.left = newId;
      if (inst.right === oldId) inst.right = newId;
      break;
    case "unop":
      if (inst.operand === oldId) inst.operand = newId;
      break;
    case "call":
      inst.args = inst.args.map((a) => (a === oldId ? newId : a));
      break;
    case "load":
      if (inst.addr === oldId) inst.addr = newId;
      break;
    case "store":
      if (inst.addr === oldId) inst.addr = newId;
      if (inst.value === oldId) inst.value = newId;
      break;
    case "br":
      if (inst.cond === oldId) inst.cond = newId;
      break;
    case "ret":
      if (inst.value === oldId) inst.value = newId;
      break;
  }
}
