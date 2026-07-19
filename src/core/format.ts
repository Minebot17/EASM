import type { Instruction, Operand } from "./types";

export function formatOperand(operand: Operand): string {
  switch (operand.kind) {
    case "register":
      return operand.name;
    case "memory":
      return `[${operand.address}]`;
    case "indirectRegister":
      return `[${operand.register}]`;
    case "indirectMemory":
      return `[[${operand.pointerAddress}]]`;
    case "immediate":
      return operand.value.toString();
  }
}

export function formatInstruction(instruction: Instruction): string {
  const suffix = instruction.operands.length
    ? ` ${instruction.operands.map(formatOperand).join(", ")}`
    : "";
  return `${instruction.opcode}${suffix}`;
}

export function cloneInstruction(instruction: Instruction): Instruction {
  return {
    ...instruction,
    operands: instruction.operands.map((operand) => ({ ...operand })),
  };
}
