/**
 * The instruction set the SSA tests are written against, and its `SSAOps`.
 *
 * Deliberately includes a node with **no destination** (`print`) and a node with a **read of its own
 * destination** is expressible (`copy`) — the two shapes that trip up a naive operand model.
 */

import type { SSAOps, BasicBlock, SSAFunction, BlockId, ValueId } from "../../src/ssa/ir.ts";
import type { Instruction, Terminator } from "../../src/ssa/ir.ts";

export type TestInstr =
  | { type: "const"; dest: ValueId; value: number }
  | { type: "add"; dest: ValueId; left: ValueId; right: ValueId }
  | { type: "sub"; dest: ValueId; left: ValueId; right: ValueId }
  | { type: "copy"; dest: ValueId; src: ValueId }
  | { type: "print"; value: ValueId };

export const testOps: SSAOps<TestInstr> = {
  def: (i) => (i.type === "print" ? undefined : i.dest),

  uses: (i) => {
    switch (i.type) {
      case "const":
        return [];
      case "add":
      case "sub":
        return [i.left, i.right];
      case "copy":
        return [i.src];
      case "print":
        return [i.value];
    }
  },

  setDef: (i, name) => {
    if (i.type !== "print") i.dest = name;
  },

  setUse: (i, from, to) => {
    switch (i.type) {
      case "add":
      case "sub":
        if (i.left === from) i.left = to;
        if (i.right === from) i.right = to;
        break;
      case "copy":
        if (i.src === from) i.src = to;
        break;
      case "print":
        if (i.value === from) i.value = to;
        break;
    }
  },
};

// ───────────────────────── Builders ─────────────────────────

export function block(
  id: BlockId,
  instructions: Instruction<TestInstr>[],
  terminator: Terminator<TestInstr>,
): BasicBlock<TestInstr> {
  return { id, instructions, terminator, predecessors: [], successors: [] };
}

export function fn(entry: BlockId, blocks: BasicBlock<TestInstr>[], id = "test"): SSAFunction<TestInstr> {
  return { id, entry, blocks: new Map(blocks.map((b) => [b.id, b])) };
}

/** The destination of an instruction, or `undefined` for one that defines nothing. */
export function destOf(i: TestInstr): ValueId | undefined {
  return i.type === "print" ? undefined : i.dest;
}

/** The phi nodes of a block, in order. */
export function phisOf(f: SSAFunction<TestInstr>, blockId: BlockId): Array<{ dest: string; from: string[] }> {
  const b = f.blocks.get(blockId)!;
  const out: Array<{ dest: string; from: string[] }> = [];
  for (const inst of b.instructions) {
    if (inst.type !== "phi") break;
    out.push({ dest: inst.dest, from: inst.incoming.map(([, v]) => v) });
  }
  return out;
}

/** The instructions of a block, phis excluded. */
export function bodyOf(f: SSAFunction<TestInstr>, blockId: BlockId): TestInstr[] {
  return f.blocks.get(blockId)!.instructions.filter((i): i is TestInstr => i.type !== "phi");
}

/** Every value name defined anywhere in the function. */
export function defsOf(f: SSAFunction<TestInstr>): Set<ValueId> {
  const out = new Set<ValueId>();
  for (const b of f.blocks.values()) {
    for (const inst of b.instructions) {
      if (inst.type === "phi") out.add(inst.dest);
      else {
        const d = destOf(inst);
        if (d !== undefined) out.add(d);
      }
    }
  }
  return out;
}
