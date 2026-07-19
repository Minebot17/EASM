import type { SearchProgress, SuccessfulProgram } from "./search";
import type { ComparisonMode } from "./search";

export interface SearchPayload {
  maxPrograms: number;
  instructionsPerProgram: number;
  timeLimitMs: number;
  memorySize: number;
  maxStepsPerProgram: number;
  seed: string;
  allowedOpcodeIndexes: number[];
  cases: Array<{
    initialMemory: string[];
    expectedMemory: string[];
  }>;
  comparisonMode: ComparisonMode;
}

export type GeneratorRequest =
  | {
      type: "start";
      runId: number;
      workerId: number;
      startOrdinal: number;
      stride: number;
      payload: SearchPayload;
    }
  | { type: "cancel"; runId: number };

export type GeneratorResponse =
  | { type: "progress"; runId: number; workerId: number; progress: SearchProgress; matches: SuccessfulProgram[] }
  | { type: "complete"; runId: number; workerId: number; progress: SearchProgress; reason: "count" | "time" | "cancelled"; resultsTruncated: boolean }
  | { type: "error"; runId: number; workerId: number; error: string };
