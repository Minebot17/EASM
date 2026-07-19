import { EasmError } from "./types";

const WORD_BITS = 64;

export function bitsToCells(input: string): bigint[] {
  const bits = input.replace(/[\s_]/g, "");
  if (!/^[01]*$/.test(bits)) throw new EasmError("Битовый ввод может содержать только 0, 1, пробелы и подчёркивания");

  const cells: bigint[] = [];
  for (let offset = 0; offset < bits.length; offset += WORD_BITS) {
    const chunk = bits.slice(offset, offset + WORD_BITS);
    cells.push(BigInt.asIntN(64, BigInt(`0b${chunk}`)));
  }
  return cells;
}

export function cellsToBits(cells: readonly bigint[], separator = " "): string {
  return cells
    .map((cell) => BigInt.asUintN(64, cell).toString(2).padStart(WORD_BITS, "0"))
    .join(separator);
}

export function utf8ToCells(input: string): bigint[] {
  return Array.from(new TextEncoder().encode(input), (byte) => BigInt(byte));
}

export function cellsToUtf8(cells: readonly bigint[], trimTrailingZeroCells = true): string {
  let end = cells.length;
  if (trimTrailingZeroCells) {
    while (end > 0 && cells[end - 1] === 0n) end -= 1;
  }
  const bytes = Uint8Array.from(cells.slice(0, end), (cell) => Number(BigInt.asUintN(64, cell) & 0xffn));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function integerListToCells(input: string): bigint[] {
  if (!input.trim()) return [];
  return input.split(/[\s,]+/).filter(Boolean).map((token) => {
    try {
      return BigInt.asIntN(64, BigInt(token.replaceAll("_", "")));
    } catch {
      throw new EasmError(`Некорректное целое число во входе: ${token}`);
    }
  });
}

export function cellsToIntegerList(cells: readonly bigint[]): string {
  return cells.map(String).join(", ");
}
