import { OPCODE_BY_NAME, validateOperands } from "./opcodes";
import { EasmError, REGISTER_NAMES, type Instruction, type Operand, type Program, type RegisterName } from "./types";

interface RawInstruction {
  opcode: string;
  operands: string[];
  line: number;
}

const REGISTER_SET = new Set<string>(REGISTER_NAMES);
const LABEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseInteger(text: string): bigint | null {
  const normalized = text.replaceAll("_", "");
  if (!/^-?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|[0-9]+)$/.test(normalized)) {
    return null;
  }
  try {
    if (normalized.startsWith("-0x") || normalized.startsWith("-0X")) return -BigInt(normalized.slice(1));
    if (normalized.startsWith("-0b") || normalized.startsWith("-0B")) return -BigInt(normalized.slice(1));
    if (normalized.startsWith("-0o") || normalized.startsWith("-0O")) return -BigInt(normalized.slice(1));
    return BigInt(normalized);
  } catch {
    return null;
  }
}

function splitOperands(text: string, line: number): string[] {
  if (!text.trim()) return [];
  const result = text.split(",").map((part) => part.trim());
  if (result.some((part) => part.length === 0)) {
    throw new EasmError("Пустой операнд", { line, column: 1 });
  }
  return result;
}

function parseOperand(text: string, labels: Record<string, number>, line: number): Operand {
  const upper = text.toUpperCase();
  if (REGISTER_SET.has(upper)) {
    return { kind: "register", name: upper as RegisterName };
  }

  const indirectMemoryMatch = /^\[\s*\[\s*(\d[\d_]*)\s*\]\s*\]$/.exec(text);
  if (indirectMemoryMatch) {
    const pointerAddress = parseMemoryAddress(indirectMemoryMatch[1], text, line);
    return { kind: "indirectMemory", pointerAddress };
  }

  const indirectRegisterMatch = /^\[\s*([ABCD])\s*\]$/i.exec(text);
  if (indirectRegisterMatch) {
    return { kind: "indirectRegister", register: indirectRegisterMatch[1].toUpperCase() as RegisterName };
  }

  const memoryMatch = /^\[\s*(\d[\d_]*)\s*\]$/.exec(text);
  if (memoryMatch) {
    return { kind: "memory", address: parseMemoryAddress(memoryMatch[1], text, line) };
  }

  const integer = parseInteger(text);
  if (integer !== null) return { kind: "immediate", value: BigInt.asIntN(64, integer) };

  if (LABEL_PATTERN.test(text)) {
    const target = labels[text];
    if (target === undefined) throw new EasmError(`Неизвестная метка: ${text}`, { line, column: 1 });
    return { kind: "immediate", value: BigInt(target) };
  }

  throw new EasmError(`Некорректный операнд: ${text}`, { line, column: 1 });
}

function parseMemoryAddress(value: string, source: string, line: number): number {
  const addressValue = parseInteger(value);
  if (addressValue === null || addressValue < 0n || addressValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EasmError(`Некорректный адрес памяти: ${source}`, { line, column: 1 });
  }
  return Number(addressValue);
}

export function parseProgram(source: string): Program {
  const labels: Record<string, number> = Object.create(null) as Record<string, number>;
  const rawInstructions: RawInstruction[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let line = lines[index].replace(/;.*$/, "").trim();
    if (!line) continue;

    const labelMatch = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (labelMatch) {
      const label = labelMatch[1];
      if (labels[label] !== undefined) {
        throw new EasmError(`Метка объявлена повторно: ${label}`, { line: lineNumber, column: 1 });
      }
      labels[label] = rawInstructions.length;
      line = line.slice(labelMatch[0].length).trim();
      if (!line) continue;
    }

    const instructionMatch = /^(\S+)(?:\s+(.*))?$/.exec(line);
    if (!instructionMatch) throw new EasmError("Не удалось разобрать инструкцию", { line: lineNumber, column: 1 });
    rawInstructions.push({
      opcode: instructionMatch[1].toLowerCase(),
      operands: splitOperands(instructionMatch[2] ?? "", lineNumber),
      line: lineNumber,
    });
  }

  const instructions: Instruction[] = rawInstructions.map((raw, id) => {
    const definition = OPCODE_BY_NAME.get(raw.opcode as never);
    if (!definition) {
      throw new EasmError(`Неизвестная операция: ${raw.opcode}`, { line: raw.line, column: 1 });
    }
    const operands = raw.operands.map((operand) => parseOperand(operand, labels, raw.line));
    const validationError = validateOperands(definition.name, operands);
    if (validationError) throw new EasmError(validationError, { line: raw.line, column: 1 });
    return { id, opcode: definition.name, operands, sourceLine: raw.line };
  });

  return { instructions, labels };
}
