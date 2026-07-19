import { cloneInstruction, formatInstruction } from "./format";
import { OPCODE_BY_INDEX, validateOperands } from "./opcodes";
import {
  EasmError,
  REGISTER_NAMES,
  type Instruction,
  type MutationEvent,
  type Operand,
  type Program,
  type RegisterName,
  type TraceEvent,
  type VmOptions,
  type VmSnapshot,
  type VmStatus,
} from "./types";

const DEFAULT_MEMORY_SIZE = 256;
const DEFAULT_MAX_STEPS = 100_000;
const DEFAULT_TRACE_LIMIT = 2_000;
const UINT64_MASK = (1n << 64n) - 1n;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;

const wrap = (value: bigint): bigint => BigInt.asIntN(64, value);
const unsigned = (value: bigint): bigint => BigInt.asUintN(64, value);

interface ExecutionResult {
  jumpTo?: number;
  haltReason?: string;
}

export interface VmExecutionSummary {
  status: VmStatus;
  reason: string;
  steps: number;
}

export class EasmVm {
  readonly memory: BigInt64Array;
  readonly registers: Record<RegisterName, bigint> = { A: 0n, B: 0n, C: 0n, D: 0n };
  readonly mutations: MutationEvent[] = [];
  readonly trace: TraceEvent[] = [];
  readonly maxSteps: number;
  readonly traceLimit: number;
  readonly addressLimit: number;

  program: Instruction[];
  pc: number | null;
  steps = 0;
  status: VmStatus;
  reason: string;

  private nextInstructionId: number;
  private rngState: bigint;

  constructor(program: Program | readonly Instruction[], options: VmOptions = {}) {
    const instructions: readonly Instruction[] = "instructions" in program ? program.instructions : program;
    this.program = instructions.map(cloneInstruction);

    const memorySize = options.memorySize ?? DEFAULT_MEMORY_SIZE;
    if (!Number.isSafeInteger(memorySize) || memorySize <= 0) {
      throw new EasmError("Размер памяти должен быть положительным безопасным целым числом");
    }
    if ((options.initialMemory?.length ?? 0) > memorySize) {
      throw new EasmError(`Вход занимает ${options.initialMemory?.length} ячеек, размер памяти — ${memorySize}`);
    }
    this.memory = new BigInt64Array(memorySize);
    options.initialMemory?.forEach((value, index) => {
      this.memory[index] = wrap(value);
    });

    this.addressLimit = options.addressLimit ?? memorySize;
    if (!Number.isSafeInteger(this.addressLimit) || this.addressLimit <= 0 || this.addressLimit > memorySize) {
      throw new EasmError("Доступный диапазон адресов должен быть положительным и не превышать физический размер памяти");
    }

    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.traceLimit = options.traceLimit ?? DEFAULT_TRACE_LIMIT;
    if (!Number.isSafeInteger(this.maxSteps) || this.maxSteps <= 0) throw new EasmError("Лимит шагов должен быть положительным целым числом");
    if (!Number.isSafeInteger(this.traceLimit) || this.traceLimit < 0) throw new EasmError("Лимит трассы не может быть отрицательным");

    this.rngState = unsigned(options.seed ?? 1n);
    this.nextInstructionId = this.program.reduce((maximum, instruction) => Math.max(maximum, instruction.id + 1), 0);
    this.pc = this.program.length ? 0 : null;
    this.status = this.program.length ? "ready" : "halted";
    this.reason = this.program.length ? "Готово" : "Пустая программа";
  }

  step(): VmSnapshot {
    this.advance();
    return this.snapshot();
  }

  run(): VmSnapshot {
    while (this.status === "ready" || this.status === "running") this.advance();
    return this.snapshot();
  }

  runFast(): VmExecutionSummary {
    while (this.status === "ready" || this.status === "running") this.advance();
    return { status: this.status, reason: this.reason, steps: this.steps };
  }

  snapshot(): VmSnapshot {
    return {
      status: this.status,
      reason: this.reason,
      pc: this.pc,
      steps: this.steps,
      registers: Object.fromEntries(REGISTER_NAMES.map((name) => [name, this.registers[name].toString()])) as Record<RegisterName, string>,
      memory: Array.from(this.memory, String),
      program: this.program.map((instruction) => ({
        id: instruction.id,
        text: formatInstruction(instruction),
        generated: Boolean(instruction.generated),
      })),
      mutations: this.mutations.map((event) => ({ ...event })),
      trace: this.trace.map((event) => ({ ...event })),
    };
  }

  private advance(): void {
    if (this.status === "halted" || this.status === "error" || this.status === "limit") return;
    if (this.pc === null || !this.program[this.pc]) {
      this.finish("halted", "Достигнут конец программы");
      return;
    }
    if (this.steps >= this.maxSteps) {
      this.finish("limit", `Достигнут лимит ${this.maxSteps} шагов`);
      return;
    }

    const currentPc = this.pc;
    const instruction = this.program[currentPc];
    const mutatesProgram = instruction.opcode === "insert" || instruction.opcode === "delete" || instruction.opcode === "change";
    const oldSuccessorIds = mutatesProgram
      ? this.program.slice(currentPc + 1).map((candidate) => candidate.id)
      : null;
    this.steps += 1;
    this.status = "running";
    this.reason = "Выполнение";
    if (this.traceLimit > 0) {
      this.pushTrace({
        step: this.steps,
        pc: currentPc,
        instructionId: instruction.id,
        instruction: formatInstruction(instruction),
      });
    }

    try {
      const result = this.execute(instruction);
      if (result.haltReason) {
        this.finish("halted", result.haltReason);
      } else if (result.jumpTo !== undefined) {
        this.pc = result.jumpTo;
        this.status = "ready";
        this.reason = "Остановлено между шагами";
      } else {
        const nextPc = oldSuccessorIds === null
          ? (currentPc + 1 < this.program.length ? currentPc + 1 : null)
          : this.findFirstSurvivingInstruction(oldSuccessorIds);
        if (nextPc === null) {
          this.finish("halted", "Достигнут конец прежней последовательности программы");
        } else {
          this.pc = nextPc;
          this.status = "ready";
          this.reason = "Остановлено между шагами";
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finish("error", `Шаг ${this.steps}, PC ${currentPc}: ${message}`);
    }
  }

  private execute(instruction: Instruction): ExecutionResult {
    const operands = instruction.operands;
    const value = (index: number): bigint => this.read(operands[index]);
    const write = (index: number, result: bigint): void => this.write(operands[index], result);
    const binary = (operation: (left: bigint, right: bigint) => bigint): ExecutionResult => {
      write(2, operation(value(0), value(1)));
      return {};
    };
    const comparison = (predicate: (left: bigint, right: bigint) => boolean): ExecutionResult =>
      binary((left, right) => predicate(left, right) ? 1n : 0n);

    switch (instruction.opcode) {
      case "add": return binary((left, right) => wrap(left + right));
      case "sub": return binary((left, right) => wrap(left - right));
      case "mul": return binary((left, right) => wrap(left * right));
      case "div": {
        const divisor = value(1);
        if (divisor === 0n) throw new EasmError("Деление на ноль");
        const dividend = value(0);
        write(2, wrap(dividend / divisor));
        write(3, wrap(dividend % divisor));
        return {};
      }
      case "mod": return binary((left, right) => {
        if (right === 0n) throw new EasmError("Деление на ноль");
        return wrap(left % right);
      });
      case "and": return binary((left, right) => wrap(left & right));
      case "or": return binary((left, right) => wrap(left | right));
      case "xor": return binary((left, right) => wrap(left ^ right));
      case "shl": return binary((left, right) => wrap(left << this.shiftCount(right)));
      case "shr": return binary((left, right) => wrap(left >> this.shiftCount(right)));
      case "ushr": return binary((left, right) => wrap(unsigned(left) >> this.shiftCount(right)));
      case "rol": return binary((left, right) => this.rotateLeft(left, right));
      case "ror": return binary((left, right) => this.rotateRight(left, right));
      case "eq": return comparison((left, right) => left === right);
      case "ne": return comparison((left, right) => left !== right);
      case "lt": return comparison((left, right) => left < right);
      case "le": return comparison((left, right) => left <= right);
      case "gt": return comparison((left, right) => left > right);
      case "ge": return comparison((left, right) => left >= right);
      case "mov": write(1, value(0)); return {};
      case "neg": write(1, wrap(-value(0))); return {};
      case "not": write(1, wrap(~value(0))); return {};
      case "inc": write(1, wrap(value(0) + 1n)); return {};
      case "dec": write(1, wrap(value(0) - 1n)); return {};
      case "rand": write(0, this.nextRandom()); return {};
      case "jmp": return { jumpTo: this.instructionIndex(value(0), false) };
      case "jz": return value(0) === 0n ? { jumpTo: this.instructionIndex(value(1), false) } : {};
      case "jnz": return value(0) !== 0n ? { jumpTo: this.instructionIndex(value(1), false) } : {};
      case "nop": return {};
      case "halt": return { haltReason: "Выполнена команда halt" };
      case "insert": this.executeInsert(instruction); return {};
      case "delete": this.executeDelete(instruction); return {};
      case "change": this.executeChange(instruction); return {};
    }
  }

  private executeInsert(instruction: Instruction): void {
    const opcodeIndex = this.safeNumber(this.read(instruction.operands[0]), "индекс opcode");
    const definition = OPCODE_BY_INDEX.get(opcodeIndex);
    if (!definition) throw new EasmError(`Неизвестный индекс opcode: ${opcodeIndex}`);
    const insertionIndex = this.instructionIndex(this.read(instruction.operands[1]), true);
    const operands = instruction.operands.slice(2).map((descriptor) => this.decodeOperandDescriptor(descriptor));
    const validationError = validateOperands(definition.name, operands);
    if (validationError) throw new EasmError(`Нельзя вставить инструкцию: ${validationError}`);

    const inserted: Instruction = {
      id: this.nextInstructionId,
      opcode: definition.name,
      operands,
      generated: true,
    };
    this.nextInstructionId += 1;
    this.program.splice(insertionIndex, 0, inserted);
    this.mutations.push({
      step: this.steps,
      kind: "insert",
      index: insertionIndex,
      after: formatInstruction(inserted),
    });
  }

  private executeDelete(instruction: Instruction): void {
    const index = this.instructionIndex(this.read(instruction.operands[0]), false);
    const [deleted] = this.program.splice(index, 1);
    this.mutations.push({
      step: this.steps,
      kind: "delete",
      index,
      before: formatInstruction(deleted),
    });
  }

  private executeChange(instruction: Instruction): void {
    const index = this.instructionIndex(this.read(instruction.operands[0]), false);
    const target = this.program[index];
    const operands = instruction.operands.slice(1).map((descriptor) => this.decodeOperandDescriptor(descriptor));
    const validationError = validateOperands(target.opcode, operands);
    if (validationError) throw new EasmError(`Нельзя изменить инструкцию: ${validationError}`);
    const before = formatInstruction(target);
    const replacement: Instruction = { ...target, operands, generated: true };
    this.program[index] = replacement;
    this.mutations.push({
      step: this.steps,
      kind: "change",
      index,
      before,
      after: formatInstruction(replacement),
    });
  }

  private decodeOperandDescriptor(pointerOperand: Operand): Operand {
    const pointer = this.physicalMemoryIndex(this.read(pointerOperand));
    if (pointer + 1 >= this.memory.length) throw new EasmError(`Дескриптор по адресу ${pointer} выходит за границу памяти`);
    const kind = this.memory[pointer];
    const payload = this.memory[pointer + 1];

    if (kind === 0n) {
      const registerIndex = this.safeNumber(payload, "номер регистра");
      const name = REGISTER_NAMES[registerIndex];
      if (!name) throw new EasmError(`Неизвестный номер регистра в дескрипторе: ${registerIndex}`);
      return { kind: "register", name };
    }
    if (kind === 1n) return { kind: "memory", address: this.memoryIndex(payload) };
    if (kind === 2n) return { kind: "immediate", value: wrap(payload) };
    if (kind === 3n) {
      const registerIndex = this.safeNumber(payload, "номер регистра косвенного адреса");
      const register = REGISTER_NAMES[registerIndex];
      if (!register) throw new EasmError(`Неизвестный номер регистра в косвенном дескрипторе: ${registerIndex}`);
      return { kind: "indirectRegister", register };
    }
    if (kind === 4n) return { kind: "indirectMemory", pointerAddress: this.memoryIndex(payload) };
    throw new EasmError(`Неизвестный тип операнда в дескрипторе: ${kind}`);
  }

  private read(operand: Operand | undefined): bigint {
    if (!operand) throw new EasmError("Отсутствует операнд");
    switch (operand.kind) {
      case "immediate": return wrap(operand.value);
      case "register": return this.registers[operand.name];
      case "memory": return this.memory[this.checkedMemoryAddress(operand.address)];
      case "indirectRegister": return this.memory[this.memoryIndex(this.registers[operand.register])];
      case "indirectMemory": return this.memory[this.memoryIndex(this.memory[this.checkedMemoryAddress(operand.pointerAddress)])];
    }
  }

  private write(operand: Operand | undefined, value: bigint): void {
    if (!operand) throw new EasmError("Отсутствует операнд назначения");
    const result = wrap(value);
    if (operand.kind === "register") {
      this.registers[operand.name] = result;
      return;
    }
    if (operand.kind === "memory") {
      this.memory[this.checkedMemoryAddress(operand.address)] = result;
      return;
    }
    if (operand.kind === "indirectRegister") {
      this.memory[this.memoryIndex(this.registers[operand.register])] = result;
      return;
    }
    if (operand.kind === "indirectMemory") {
      this.memory[this.memoryIndex(this.memory[this.checkedMemoryAddress(operand.pointerAddress)])] = result;
      return;
    }
    throw new EasmError("Нельзя записать результат в константу");
  }

  private checkedMemoryAddress(address: number): number {
    if (!Number.isSafeInteger(address) || address < 0 || address >= this.addressLimit) {
      throw new EasmError(`Адрес памяти вне диапазона: ${address}`);
    }
    return address;
  }

  private memoryIndex(value: bigint): number {
    return this.checkedMemoryAddress(this.safeNumber(value, "адрес памяти"));
  }

  private physicalMemoryIndex(value: bigint): number {
    const address = this.safeNumber(value, "физический адрес памяти");
    if (address < 0 || address >= this.memory.length) {
      throw new EasmError(`Физический адрес памяти вне диапазона: ${address}`);
    }
    return address;
  }

  private instructionIndex(value: bigint, allowEnd: boolean): number {
    const index = this.safeNumber(value, "индекс инструкции");
    const maximum = allowEnd ? this.program.length : this.program.length - 1;
    if (index < 0 || index > maximum) throw new EasmError(`Индекс инструкции вне диапазона: ${index}`);
    return index;
  }

  private safeNumber(value: bigint, label: string): number {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new EasmError(`${label} не помещается в безопасное целое JavaScript: ${value}`);
    }
    return Number(value);
  }

  private shiftCount(value: bigint): bigint {
    return unsigned(value) & 63n;
  }

  private rotateLeft(value: bigint, amount: bigint): bigint {
    const count = this.shiftCount(amount);
    if (count === 0n) return wrap(value);
    const bits = unsigned(value);
    return wrap(((bits << count) | (bits >> (64n - count))) & UINT64_MASK);
  }

  private rotateRight(value: bigint, amount: bigint): bigint {
    const count = this.shiftCount(amount);
    if (count === 0n) return wrap(value);
    const bits = unsigned(value);
    return wrap(((bits >> count) | (bits << (64n - count))) & UINT64_MASK);
  }

  private nextRandom(): bigint {
    this.rngState = unsigned(this.rngState + GOLDEN_GAMMA);
    let mixed = this.rngState;
    mixed = unsigned((mixed ^ (mixed >> 30n)) * 0xbf58476d1ce4e5b9n);
    mixed = unsigned((mixed ^ (mixed >> 27n)) * 0x94d049bb133111ebn);
    mixed ^= mixed >> 31n;
    return wrap(mixed);
  }

  private findFirstSurvivingInstruction(ids: readonly number[]): number | null {
    for (const id of ids) {
      const index = this.program.findIndex((instruction) => instruction.id === id);
      if (index >= 0) return index;
    }
    return null;
  }

  private pushTrace(event: TraceEvent): void {
    if (this.traceLimit === 0) return;
    this.trace.push(event);
    if (this.trace.length > this.traceLimit) this.trace.splice(0, this.trace.length - this.traceLimit);
  }

  private finish(status: VmStatus, reason: string): void {
    this.status = status;
    this.reason = reason;
    if (status !== "ready" && status !== "running") this.pc = null;
  }
}
