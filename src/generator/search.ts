import {
  EasmVm,
  OPCODES,
  formatInstruction,
  type Instruction,
  type OpcodeDefinition,
  type Operand,
  type Program,
  type RegisterName,
} from "../core";

const UINT64_MASK = (1n << 64n) - 1n;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;
const REGISTER_NAMES: readonly RegisterName[] = ["A", "B", "C", "D"];
const BINARY_OPCODES = new Set(["add", "sub", "mul", "mod", "and", "or", "xor", "shl", "shr", "ushr", "rol", "ror", "eq", "ne", "lt", "le", "gt", "ge"]);
const UNARY_OPCODES = new Set(["neg", "not", "inc", "dec"]);
const RANDOM_OPCODES = OPCODES.filter((opcode) => opcode.name !== "nop" && opcode.name !== "halt");
const NON_RECURSIVE_INSERT_TARGETS = RANDOM_OPCODES.filter((opcode) => opcode.name !== "insert" && opcode.name !== "change");
const NON_SHIFTING_OPCODES = RANDOM_OPCODES.filter((opcode) => opcode.name !== "insert" && opcode.name !== "delete");

export interface SearchConfig {
  maxPrograms: number;
  instructionsPerProgram: number;
  timeLimitMs: number;
  memorySize: number;
  maxStepsPerProgram: number;
  seed: bigint;
  initialMemory: bigint[];
  expectedMemory: bigint[];
  comparisonMode: ComparisonMode;
}

export type ComparisonMode = "exact" | "ignoreZeros";

export interface SuccessfulProgram {
  ordinal: number;
  source: string;
  finalSource: string;
  steps: number;
  mutations: number;
}

export interface SearchProgress {
  generated: number;
  successful: number;
  errors: number;
  limits: number;
  elapsedMs: number;
}

export interface GeneratedCandidate {
  program: Program;
  initialMemory: bigint[];
}

export class RandomSource {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = BigInt.asUintN(64, seed);
  }

  nextUint64(): bigint {
    this.state = BigInt.asUintN(64, this.state + GOLDEN_GAMMA);
    let mixed = this.state;
    mixed = BigInt.asUintN(64, (mixed ^ (mixed >> 30n)) * 0xbf58476d1ce4e5b9n);
    mixed = BigInt.asUintN(64, (mixed ^ (mixed >> 27n)) * 0x94d049bb133111ebn);
    return BigInt.asUintN(64, mixed ^ (mixed >> 31n));
  }

  int(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new Error("Верхняя граница random должна быть положительной");
    return Number(this.nextUint64() % BigInt(maxExclusive));
  }
}

class DescriptorAllocator {
  readonly cells: bigint[] = [];

  constructor(private readonly baseAddress: number) {}

  allocate(operand: Operand): Operand {
    const pointer = this.baseAddress + this.cells.length;
    const [kind, payload] = encodeDescriptor(operand);
    this.cells.push(kind, payload);
    return immediate(pointer);
  }
}

function encodeDescriptor(operand: Operand): [bigint, bigint] {
  switch (operand.kind) {
    case "register":
      return [0n, BigInt(REGISTER_NAMES.indexOf(operand.name))];
    case "memory":
      return [1n, BigInt(operand.address)];
    case "immediate":
      return [2n, operand.value];
    case "indirectRegister":
      return [3n, BigInt(REGISTER_NAMES.indexOf(operand.register))];
    case "indirectMemory":
      return [4n, BigInt(operand.pointerAddress)];
  }
}

function immediate(value: bigint | number): Operand {
  return { kind: "immediate", value: BigInt.asIntN(64, BigInt(value)) };
}

function randomConstant(random: RandomSource): bigint {
  if (random.int(100) < 85) return BigInt(random.int(512) - 256);
  return BigInt.asIntN(64, random.nextUint64() & UINT64_MASK);
}

function randomMemoryOperand(random: RandomSource, memorySize: number): Operand {
  switch (random.int(3)) {
    case 0:
      return { kind: "memory", address: random.int(memorySize) };
    case 1:
      return { kind: "indirectRegister", register: REGISTER_NAMES[random.int(REGISTER_NAMES.length)] };
    default:
      return { kind: "indirectMemory", pointerAddress: random.int(memorySize) };
  }
}

function randomSourceOperand(random: RandomSource, memorySize: number): Operand {
  switch (random.int(3)) {
    case 0:
      return { kind: "register", name: REGISTER_NAMES[random.int(REGISTER_NAMES.length)] };
    case 1:
      return randomMemoryOperand(random, memorySize);
    default:
      return immediate(randomConstant(random));
  }
}

function randomDestination(random: RandomSource, memorySize: number): Operand {
  return random.int(2) === 0
    ? { kind: "register", name: REGISTER_NAMES[random.int(REGISTER_NAMES.length)] }
    : randomMemoryOperand(random, memorySize);
}

function randomOperandsForDefinition(
  definition: OpcodeDefinition,
  plannedDefinitions: readonly OpcodeDefinition[],
  random: RandomSource,
  memorySize: number,
  descriptors: DescriptorAllocator,
  allowNestedSelfModification: boolean,
): Operand[] {
  const source = () => randomSourceOperand(random, memorySize);
  const destination = () => randomDestination(random, memorySize);

  if (BINARY_OPCODES.has(definition.name)) return [source(), source(), destination()];
  if (definition.name === "div") return [source(), source(), destination(), destination()];
  if (definition.name === "mov" || UNARY_OPCODES.has(definition.name)) return [source(), destination()];
  if (definition.name === "rand") return [destination()];
  if (definition.name === "jmp") return [immediate(random.int(plannedDefinitions.length))];
  if (definition.name === "jz" || definition.name === "jnz") {
    return [source(), immediate(random.int(plannedDefinitions.length))];
  }
  if (definition.name === "delete") return [immediate(random.int(plannedDefinitions.length))];

  if (definition.name === "insert") {
    const availableTargets = allowNestedSelfModification ? RANDOM_OPCODES : NON_RECURSIVE_INSERT_TARGETS;
    const insertedDefinition = availableTargets[random.int(availableTargets.length)];
    const insertedOperands = randomOperandsForDefinition(
      insertedDefinition,
      plannedDefinitions,
      random,
      memorySize,
      descriptors,
      false,
    );
    return [
      immediate(insertedDefinition.index),
      immediate(random.int(plannedDefinitions.length)),
      ...insertedOperands.map((operand) => descriptors.allocate(operand)),
    ];
  }

  if (definition.name === "change") {
    const target = random.int(plannedDefinitions.length);
    const targetDefinition = plannedDefinitions[target];
    const replacementOperands = !allowNestedSelfModification && targetDefinition.name === "change"
      ? [immediate(random.int(plannedDefinitions.length))]
      : randomOperandsForDefinition(
          targetDefinition,
          plannedDefinitions,
          random,
          memorySize,
          descriptors,
          false,
        );
    return [immediate(target), ...replacementOperands.map((operand) => descriptors.allocate(operand))];
  }

  return [];
}

function buildRandomProgram(
  instructionCount: number,
  memorySize: number,
  random: RandomSource,
  descriptors: DescriptorAllocator,
): Program {
  const rawDefinitions = Array.from({ length: instructionCount }, () => RANDOM_OPCODES[random.int(RANDOM_OPCODES.length)]);
  // A numeric change target is only type-safe while instruction indexes stay stable.
  // If this candidate contains change, replace index-shifting mutations with other
  // randomly selected opcodes. Programs without change may still freely insert/delete.
  const containsChange = rawDefinitions.some((definition) => definition.name === "change");
  const plannedDefinitions = containsChange
    ? rawDefinitions.map((definition) => definition.name === "insert" || definition.name === "delete"
      ? NON_SHIFTING_OPCODES[random.int(NON_SHIFTING_OPCODES.length)]
      : definition)
    : rawDefinitions;
  const instructions: Instruction[] = plannedDefinitions.map((definition, id) => ({
    id,
    opcode: definition.name,
    operands: randomOperandsForDefinition(definition, plannedDefinitions, random, memorySize, descriptors, true),
    generated: true,
  }));
  return { instructions, labels: {} };
}

export function seedForCandidate(baseSeed: bigint, ordinal: number): bigint {
  return BigInt.asUintN(64, baseSeed + GOLDEN_GAMMA * BigInt(ordinal));
}

export function generateRandomCandidate(config: SearchConfig, ordinal: number): GeneratedCandidate {
  const random = new RandomSource(seedForCandidate(config.seed, ordinal));
  const descriptors = new DescriptorAllocator(config.memorySize);
  const program = buildRandomProgram(config.instructionsPerProgram, config.memorySize, random, descriptors);
  const initialMemory = Array.from({ length: config.memorySize + descriptors.cells.length }, (_, index) => {
    if (index < config.initialMemory.length) return BigInt.asIntN(64, config.initialMemory[index]);
    if (index >= config.memorySize) return descriptors.cells[index - config.memorySize];
    return 0n;
  });
  return { program, initialMemory };
}

export function generateRandomProgram(
  instructionCount: number,
  memorySize: number,
  random: RandomSource,
): Program {
  return buildRandomProgram(instructionCount, memorySize, random, new DescriptorAllocator(memorySize));
}

export function memoryMatches(
  memory: readonly bigint[],
  expected: readonly bigint[],
  comparisonMode: ComparisonMode,
): boolean {
  if (comparisonMode === "exact") {
    if (expected.length > memory.length) return false;
    return memory.every((value, index) => value === (index < expected.length ? BigInt.asIntN(64, expected[index]) : 0n));
  }
  const meaningfulMemory = memory.filter((value) => value !== 0n);
  const meaningfulExpected = expected
    .map((value) => BigInt.asIntN(64, value))
    .filter((value) => value !== 0n);
  if (meaningfulMemory.length !== meaningfulExpected.length) return false;
  return meaningfulMemory.every((value, index) => value === meaningfulExpected[index]);
}

export function evaluateRandomProgram(
  candidate: GeneratedCandidate,
  config: SearchConfig,
  ordinal: number,
): { status: "success" | "failed" | "error" | "limit"; result?: SuccessfulProgram; reason?: string } {
  const vm = new EasmVm(candidate.program, {
    memorySize: candidate.initialMemory.length,
    addressLimit: config.memorySize,
    initialMemory: candidate.initialMemory,
    maxSteps: config.maxStepsPerProgram,
    seed: seedForCandidate(config.seed ^ 0xd1b54a32d192ed03n, ordinal),
    traceLimit: 0,
  });
  const execution = vm.runFast();
  if (execution.status === "error") return { status: "error", reason: execution.reason };
  if (execution.status === "limit") return { status: "limit", reason: execution.reason };
  const outputMemory = Array.from(vm.memory.slice(0, config.memorySize));
  if (execution.status !== "halted" || !memoryMatches(outputMemory, config.expectedMemory, config.comparisonMode)) {
    return { status: "failed" };
  }

  const source = candidate.program.instructions.map(formatInstruction).join("\n");
  return {
    status: "success",
    result: {
      ordinal,
      source,
      finalSource: vm.program.map(formatInstruction).join("\n"),
      steps: execution.steps,
      mutations: vm.mutations.length,
    },
  };
}
