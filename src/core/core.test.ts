import { describe, expect, it } from "vitest";
import { bitsToCells, cellsToBits, cellsToUtf8, utf8ToCells } from "./codecs";
import { OPCODES } from "./opcodes";
import { parseProgram } from "./parser";
import { EasmVm } from "./vm";

const run = (source: string, initialMemory: bigint[] = [], seed = 1n) =>
  new EasmVm(parseProgram(source), { memorySize: 64, initialMemory, seed, maxSteps: 100 }).run();

describe("parser and arithmetic", () => {
  it("keeps opcode indexes stable, including rand and mutations", () => {
    expect(OPCODES.every((opcode, index) => opcode.index === index)).toBe(true);
    expect(OPCODES[24].name).toBe("rand");
    expect(OPCODES.slice(30).map((opcode) => opcode.name)).toEqual(["insert", "delete", "change"]);
  });

  it("resolves labels and performs generalized 64-bit operations", () => {
    const snapshot = run(`
      mov 9223372036854775807, A
      add A, 1, C
      eq C, -9223372036854775808, D
      jnz D, done
      mov 99, A
    done:
      halt
    `);
    expect(snapshot.status).toBe("halted");
    expect(snapshot.registers.C).toBe("-9223372036854775808");
    expect(snapshot.registers.D).toBe("1");
    expect(snapshot.registers.A).toBe("9223372036854775807");
  });

  it("returns quotient and remainder", () => {
    const snapshot = run("div -17, 5, C, D\nhalt");
    expect(snapshot.registers.C).toBe("-3");
    expect(snapshot.registers.D).toBe("-2");
  });

  it.each([
    ["sub", "9", "4", "5"],
    ["mul", "-7", "6", "-42"],
    ["mod", "17", "5", "2"],
    ["and", "6", "3", "2"],
    ["or", "4", "3", "7"],
    ["xor", "7", "3", "4"],
    ["shl", "1", "63", "-9223372036854775808"],
    ["shr", "-2", "1", "-1"],
    ["ushr", "-1", "1", "9223372036854775807"],
    ["rol", "1", "1", "2"],
    ["ror", "1", "1", "-9223372036854775808"],
    ["eq", "5", "5", "1"],
    ["ne", "5", "5", "0"],
    ["lt", "-1", "1", "1"],
    ["le", "1", "1", "1"],
    ["gt", "2", "3", "0"],
    ["ge", "3", "3", "1"],
  ])("executes %s", (opcode, left, right, expected) => {
    const snapshot = run(`${opcode} ${left}, ${right}, C\nhalt`);
    expect(snapshot.registers.C).toBe(expected);
  });

  it("supports all unary operations and memory destinations", () => {
    const snapshot = run("neg 7, [0]\nnot 0, [1]\ninc 9, [2]\ndec -9, [3]\nhalt");
    expect(snapshot.memory.slice(0, 4)).toEqual(["-7", "-1", "10", "-10"]);
  });

  it("reads and writes memory through register and memory-cell pointers", () => {
    const snapshot = run(`
      mov 3, A
      mov 42, [A]
      mov 4, [0]
      mov 99, [[0]]
      mov [A], B
      mov [[0]], C
      halt
    `);
    expect(snapshot.memory[3]).toBe("42");
    expect(snapshot.memory[4]).toBe("99");
    expect(snapshot.registers.B).toBe("42");
    expect(snapshot.registers.C).toBe("99");
    expect(snapshot.program[1].text).toBe("mov 42, [A]");
    expect(snapshot.program[3].text).toBe("mov 99, [[0]]");
  });

  it("reports an error for an indirect address outside memory", () => {
    const snapshot = run("mov 1000, A\nmov 1, [A]\nhalt");
    expect(snapshot.status).toBe("error");
    expect(snapshot.reason).toContain("Адрес памяти вне диапазона");
  });
});

describe("codecs", () => {
  it("packs each group of 64 input bits into one cell", () => {
    const bits = `${"1".repeat(64)} 00000010`;
    const cells = bitsToCells(bits);
    expect(cells).toEqual([-1n, 2n]);
    expect(cellsToBits(cells).split(" ")[1].endsWith("10")).toBe(true);
  });

  it("uses one UTF-8 byte per cell", () => {
    const cells = utf8ToCells("Привет");
    expect(cells.length).toBeGreaterThan("Привет".length);
    expect(cellsToUtf8([...cells, 0n, 0n])).toBe("Привет");
  });
});

describe("rand", () => {
  it("is reproducible for a seed and can write registers and memory", () => {
    const source = "rand A\nrand [0]\nhalt";
    const first = run(source, [], 123n);
    const second = run(source, [], 123n);
    const other = run(source, [], 124n);
    expect(first.registers.A).toBe(second.registers.A);
    expect(first.memory[0]).toBe(second.memory[0]);
    expect(first.registers.A).not.toBe(other.registers.A);
  });
});

describe("self modification", () => {
  it("skips an instruction inserted immediately before the old successor", () => {
    const vm = new EasmVm(parseProgram("insert 28, 1\nmov 7, A\nhalt"), { memorySize: 16, maxSteps: 20 });
    const afterInsert = vm.step();
    expect(afterInsert.pc).toBe(2);
    const afterMov = vm.step();
    expect(afterMov.registers.A).toBe("7");
    expect(afterMov.pc).toBe(3);
  });

  it("continues with the first surviving old successor after delete", () => {
    const snapshot = run("delete 1\nmov 1, A\nmov 2, B\nhalt");
    expect(snapshot.registers.A).toBe("0");
    expect(snapshot.registers.B).toBe("2");
    expect(snapshot.mutations[0].kind).toBe("delete");
  });

  it("decodes descriptor pairs and executes changed operands", () => {
    const initialMemory = [2n, 9n, 0n, 0n];
    const snapshot = run("change 1, 0, 2\nmov 1, A\nhalt", initialMemory);
    expect(snapshot.registers.A).toBe("9");
    expect(snapshot.program[1].text).toBe("mov 9, A");
  });

  it("decodes indirect operand descriptor kinds", () => {
    const initialMemory = [3n, 0n, 4n, 5n, 0n, 10n];
    const snapshot = run("change 1, 0, 2\nmov 0, A\nhalt", initialMemory);
    expect(snapshot.program[1].text).toBe("mov [A], [[5]]");
    expect(snapshot.memory[10]).toBe("3");
  });

  it("inserts and executes an instruction reached by jump", () => {
    const snapshot = run(`
      mov 2, [0]
      mov 42, [1]
      mov 1, [2]
      mov 10, [3]
      insert 19, 7, 0, 2
      jmp 7
      halt
    `);
    expect(snapshot.memory[10]).toBe("42");
    expect(snapshot.program[7].text).toBe("mov 42, [10]");
  });
});
