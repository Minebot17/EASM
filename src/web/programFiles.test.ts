import { describe, expect, it } from "vitest";
import { normalizeProgramFileName } from "./programFiles";

describe("program file names", () => {
  it("adds the easm extension", () => {
    expect(normalizeProgramFileName("experiment")).toBe("experiment.easm");
    expect(normalizeProgramFileName("program.EASM")).toBe("program.EASM");
  });

  it("removes characters forbidden in common file systems", () => {
    expect(normalizeProgramFileName("self:change?.easm")).toBe("self-change-.easm");
    expect(normalizeProgramFileName("   ")).toBe("program.easm");
  });
});
