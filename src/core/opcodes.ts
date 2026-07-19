import type { OpcodeName, Operand } from "./types";

export interface OpcodeDefinition {
  index: number;
  name: OpcodeName;
  minOperands: number;
  maxOperands: number | null;
  destinationIndexes: number[];
  description: string;
}

const exact = (
  index: number,
  name: OpcodeName,
  operands: number,
  destinationIndexes: number[],
  description: string,
): OpcodeDefinition => ({
  index,
  name,
  minOperands: operands,
  maxOperands: operands,
  destinationIndexes,
  description,
});

export const OPCODES: readonly OpcodeDefinition[] = [
  exact(0, "add", 3, [2], "Сложение"),
  exact(1, "sub", 3, [2], "Вычитание"),
  exact(2, "mul", 3, [2], "Умножение"),
  exact(3, "div", 4, [2, 3], "Целочисленное деление: частное и остаток"),
  exact(4, "mod", 3, [2], "Остаток от деления"),
  exact(5, "and", 3, [2], "Побитовое И"),
  exact(6, "or", 3, [2], "Побитовое ИЛИ"),
  exact(7, "xor", 3, [2], "Побитовое исключающее ИЛИ"),
  exact(8, "shl", 3, [2], "Сдвиг влево"),
  exact(9, "shr", 3, [2], "Арифметический сдвиг вправо"),
  exact(10, "ushr", 3, [2], "Логический сдвиг вправо"),
  exact(11, "rol", 3, [2], "Циклический сдвиг влево"),
  exact(12, "ror", 3, [2], "Циклический сдвиг вправо"),
  exact(13, "eq", 3, [2], "Равно"),
  exact(14, "ne", 3, [2], "Не равно"),
  exact(15, "lt", 3, [2], "Меньше"),
  exact(16, "le", 3, [2], "Меньше или равно"),
  exact(17, "gt", 3, [2], "Больше"),
  exact(18, "ge", 3, [2], "Больше или равно"),
  exact(19, "mov", 2, [1], "Копирование значения"),
  exact(20, "neg", 2, [1], "Смена знака"),
  exact(21, "not", 2, [1], "Побитовое НЕ"),
  exact(22, "inc", 2, [1], "Увеличение на один"),
  exact(23, "dec", 2, [1], "Уменьшение на один"),
  exact(24, "rand", 1, [0], "Псевдослучайное знаковое 64-битное число"),
  exact(25, "jmp", 1, [], "Безусловный переход"),
  exact(26, "jz", 2, [], "Переход, если значение равно нулю"),
  exact(27, "jnz", 2, [], "Переход, если значение не равно нулю"),
  exact(28, "nop", 0, [], "Пустая операция"),
  exact(29, "halt", 0, [], "Штатная остановка"),
  { index: 30, name: "insert", minOperands: 2, maxOperands: null, destinationIndexes: [], description: "Вставка инструкции" },
  exact(31, "delete", 1, [], "Удаление инструкции"),
  { index: 32, name: "change", minOperands: 1, maxOperands: null, destinationIndexes: [], description: "Замена операндов инструкции" },
] as const;

export const OPCODE_BY_NAME = new Map(OPCODES.map((definition) => [definition.name, definition]));
export const OPCODE_BY_INDEX = new Map(OPCODES.map((definition) => [definition.index, definition]));

export function isDestination(operand: Operand): boolean {
  return operand.kind === "register"
    || operand.kind === "memory"
    || operand.kind === "indirectRegister"
    || operand.kind === "indirectMemory";
}

export function validateOperands(opcode: OpcodeName, operands: readonly Operand[]): string | null {
  const definition = OPCODE_BY_NAME.get(opcode);
  if (!definition) return `Неизвестная операция: ${opcode}`;

  if (operands.length < definition.minOperands) {
    return `${opcode} ожидает минимум ${definition.minOperands} операнд(а), получено ${operands.length}`;
  }
  if (definition.maxOperands !== null && operands.length > definition.maxOperands) {
    return `${opcode} ожидает ${definition.maxOperands} операнд(а), получено ${operands.length}`;
  }
  for (const index of definition.destinationIndexes) {
    if (!isDestination(operands[index])) {
      return `Операнд ${index + 1} команды ${opcode} должен быть регистром или ячейкой памяти`;
    }
  }
  return null;
}
