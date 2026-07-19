#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  EasmVm,
  bitsToCells,
  cellsToBits,
  cellsToUtf8,
  integerListToCells,
  parseProgram,
  utf8ToCells,
} from "./core";

interface CliOptions {
  file?: string;
  inputText?: string;
  inputBits?: string;
  inputIntegers?: string;
  memorySize: number;
  maxSteps: number;
  seed: bigint;
  json: boolean;
}

function usage(): string {
  return `EASM CLI

Использование:
  npx tsx src/cli.ts <program.easm> [options]

Опции:
  --input-text <text>       UTF-8: один байт на одну ячейку
  --input-bits <bits>       Каждые 64 бита помещаются в одну ячейку
  --input-integers <list>   Целые числа через пробел или запятую
  --memory <cells>          Размер памяти (по умолчанию 256)
  --steps <count>           Лимит шагов (по умолчанию 100000)
  --seed <integer>          Seed для rand (по умолчанию 1)
  --json                    Вывести полный snapshot как JSON
  --help                    Показать справку`;
}

function parseArguments(args: string[]): CliOptions {
  const result: CliOptions = { memorySize: 256, maxSteps: 100_000, seed: 1n, json: false };
  const nextValue = (index: number, name: string): string => {
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Для ${name} требуется значение`);
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    } else if (argument === "--json") {
      result.json = true;
    } else if (argument === "--input-text") {
      result.inputText = nextValue(index, argument);
      index += 1;
    } else if (argument === "--input-bits") {
      result.inputBits = nextValue(index, argument);
      index += 1;
    } else if (argument === "--input-integers") {
      result.inputIntegers = nextValue(index, argument);
      index += 1;
    } else if (argument === "--memory") {
      result.memorySize = Number(nextValue(index, argument));
      index += 1;
    } else if (argument === "--steps") {
      result.maxSteps = Number(nextValue(index, argument));
      index += 1;
    } else if (argument === "--seed") {
      result.seed = BigInt(nextValue(index, argument));
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Неизвестная опция: ${argument}`);
    } else if (!result.file) {
      result.file = argument;
    } else {
      throw new Error(`Лишний аргумент: ${argument}`);
    }
  }
  if (!result.file) throw new Error("Не указан файл программы");
  const inputKinds = [result.inputText, result.inputBits, result.inputIntegers].filter((value) => value !== undefined);
  if (inputKinds.length > 1) throw new Error("Укажите только один формат входа");
  return result;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const source = await readFile(resolve(options.file!), "utf8");
  const initialMemory = options.inputText !== undefined
    ? utf8ToCells(options.inputText)
    : options.inputBits !== undefined
      ? bitsToCells(options.inputBits)
      : integerListToCells(options.inputIntegers ?? "");
  const vm = new EasmVm(parseProgram(source), {
    memorySize: options.memorySize,
    maxSteps: options.maxSteps,
    seed: options.seed,
    initialMemory,
  });
  const snapshot = vm.run();

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  const memory = snapshot.memory.map(BigInt);
  console.log(`Статус: ${snapshot.status}`);
  console.log(`Причина: ${snapshot.reason}`);
  console.log(`Шагов: ${snapshot.steps}`);
  console.log(`Регистры: A=${snapshot.registers.A} B=${snapshot.registers.B} C=${snapshot.registers.C} D=${snapshot.registers.D}`);
  console.log(`UTF-8: ${JSON.stringify(cellsToUtf8(memory))}`);
  console.log(`Биты первых 4 ячеек: ${cellsToBits(memory.slice(0, 4))}`);
  console.log("Итоговый код:");
  snapshot.program.forEach((instruction, index) => console.log(`${index.toString().padStart(4, "0")}  ${instruction.text}`));
  if (snapshot.mutations.length) {
    console.log("Мутации:");
    snapshot.mutations.forEach((mutation) => console.log(`  #${mutation.step} ${mutation.kind} @${mutation.index}: ${mutation.before ?? "∅"} -> ${mutation.after ?? "∅"}`));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
