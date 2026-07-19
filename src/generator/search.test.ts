import { describe, expect, it } from "vitest";
import { OPCODES, formatInstruction, parseProgram, validateOperands } from "../core";
import {
  RandomSource,
  evaluateRandomProgram,
  generateRandomCandidate,
  generateRandomProgram,
  memoryMatches,
  type SearchConfig,
} from "./search";

const TEST_CONFIG: SearchConfig = {
  maxPrograms: 1_000,
  instructionsPerProgram: 24,
  timeLimitMs: 1_000,
  memorySize: 12,
  maxStepsPerProgram: 200,
  seed: 123n,
  initialMemory: [3n, 1n, 2n],
  expectedMemory: [99n],
  comparisonMode: "exact",
};

function sourceOf(ordinal: number): string {
  return generateRandomCandidate(TEST_CONFIG, ordinal).program.instructions.map(formatInstruction).join("\n");
}

describe("generator filtering", () => {
  it("ignores zero cells but preserves the order of meaningful values", () => {
    expect(memoryMatches([0n, 1n, 0n, 2n, 0n], [1n, 2n], "ignoreZeros")).toBe(true);
    expect(memoryMatches([1n, 2n], [0n, 1n, 0n, 2n, 0n], "ignoreZeros")).toBe(true);
    expect(memoryMatches([1n, 3n, 2n], [1n, 2n], "ignoreZeros")).toBe(false);
    expect(memoryMatches([2n, 1n], [1n, 2n], "ignoreZeros")).toBe(false);
  });

  it("can compare with zero positions included", () => {
    expect(memoryMatches([1n, 0n, 2n, 0n], [1n, 0n, 2n], "exact")).toBe(true);
    expect(memoryMatches([1n, 0n, 2n], [1n, 2n], "exact")).toBe(false);
    expect(memoryMatches([1n, 2n, 0n], [1n, 2n, 3n], "exact")).toBe(false);
  });

  it("generates reproducible, syntactically valid programs", () => {
    const first = generateRandomProgram(32, 4, new RandomSource(123n));
    const second = generateRandomProgram(32, 4, new RandomSource(123n));
    expect(first).toEqual(second);
    first.instructions.forEach((instruction) => {
      expect(validateOperands(instruction.opcode, instruction.operands)).toBeNull();
      expect(OPCODES.some((opcode) => opcode.name === instruction.opcode)).toBe(true);
    });
  });

  it("produces source that the public parser accepts", () => {
    const program = generateRandomProgram(20, 8, new RandomSource(77n));
    const source = program.instructions.map(formatInstruction).join("\n");
    expect(parseProgram(source).instructions).toHaveLength(20);
  });

  it("does not generate nop or halt in programs and insert targets", () => {
    const random = new RandomSource(456n);
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const program = generateRandomProgram(32, 8, random);
      program.instructions.forEach((instruction) => {
        expect(["nop", "halt"]).not.toContain(instruction.opcode);
        if (instruction.opcode === "insert") {
          const opcodeIndex = instruction.operands[0];
          expect(opcodeIndex.kind).toBe("immediate");
          if (opcodeIndex.kind === "immediate") expect([28n, 29n]).not.toContain(opcodeIndex.value);
        }
      });
    }
  });

  it("splits random memory operands across all three addressing modes", () => {
    let directPointers = 0;
    let registerPointers = 0;
    let memoryPointers = 0;
    const random = new RandomSource(999n);
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const program = generateRandomProgram(16, 8, random);
      program.instructions.flatMap((instruction) => instruction.operands).forEach((operand) => {
        if (operand.kind === "memory") directPointers += 1;
        if (operand.kind === "indirectRegister") registerPointers += 1;
        if (operand.kind === "indirectMemory") memoryPointers += 1;
      });
    }
    const counts = [directPointers, registerPointers, memoryPointers];
    const total = counts.reduce((sum, count) => sum + count, 0);
    counts.forEach((count) => expect(count).toBeGreaterThan(400));
    expect((Math.max(...counts) - Math.min(...counts)) / total).toBeLessThan(0.05);
  });

  it("keeps candidate seeds deterministic across interleaved worker partitions", () => {
    const sequential = Array.from({ length: 40 }, (_, index) => ({ ordinal: index + 1, source: sourceOf(index + 1) }));
    const interleaved = [0, 1, 2, 3]
      .flatMap((workerId) => {
        const candidates: Array<{ ordinal: number; source: string }> = [];
        for (let ordinal = workerId + 1; ordinal <= 40; ordinal += 4) {
          candidates.push({ ordinal, source: sourceOf(ordinal) });
        }
        return candidates;
      })
      .sort((left, right) => left.ordinal - right.ordinal);
    expect(interleaved).toEqual(sequential);
  });

  it("bounds code targets, memory syntax and protected descriptors", () => {
    for (let ordinal = 1; ordinal <= 200; ordinal += 1) {
      const candidate = generateRandomCandidate(TEST_CONFIG, ordinal);
      const instructions = candidate.program.instructions;
      instructions.forEach((instruction) => {
        instruction.operands.forEach((operand) => {
          if (operand.kind === "memory") expect(operand.address).toBeLessThan(TEST_CONFIG.memorySize);
          if (operand.kind === "indirectMemory") expect(operand.pointerAddress).toBeLessThan(TEST_CONFIG.memorySize);
        });
        const targetIndex = instruction.opcode === "jz" || instruction.opcode === "jnz" ? 1 : 0;
        if (["jmp", "jz", "jnz", "delete", "change"].includes(instruction.opcode)) {
          const target = instruction.operands[targetIndex];
          expect(target.kind).toBe("immediate");
          if (target.kind === "immediate") {
            expect(target.value).toBeGreaterThanOrEqual(0n);
            expect(target.value).toBeLessThan(BigInt(instructions.length));
          }
        }
        if (instruction.opcode === "insert") {
          const insertionIndex = instruction.operands[1];
          expect(insertionIndex.kind).toBe("immediate");
          if (insertionIndex.kind === "immediate") expect(insertionIndex.value).toBeLessThan(BigInt(instructions.length));
        }
      });

      const descriptors = candidate.initialMemory.slice(TEST_CONFIG.memorySize);
      expect(descriptors.length % 2).toBe(0);
      for (let index = 0; index < descriptors.length; index += 2) {
        const kind = descriptors[index];
        const payload = descriptors[index + 1];
        expect(kind).toBeGreaterThanOrEqual(0n);
        expect(kind).toBeLessThanOrEqual(4n);
        if (kind === 0n || kind === 3n) {
          expect(payload).toBeGreaterThanOrEqual(0n);
          expect(payload).toBeLessThan(4n);
        }
        if (kind === 1n || kind === 4n) {
          expect(payload).toBeGreaterThanOrEqual(0n);
          expect(payload).toBeLessThan(BigInt(TEST_CONFIG.memorySize));
        }
      }
    }
  });

  it("never creates constant or otherwise invalid destinations", () => {
    const forbidden = ["должен быть регистром или ячейкой памяти", "Нельзя записать результат в константу"];
    for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
      const evaluation = evaluateRandomProgram(generateRandomCandidate(TEST_CONFIG, ordinal), TEST_CONFIG, ordinal);
      if (evaluation.status === "error") {
        forbidden.forEach((fragment) => expect(evaluation.reason).not.toContain(fragment));
      }
    }
  });
});
