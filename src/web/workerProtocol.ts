import type { VmSnapshot } from "../core";

export interface VmInitPayload {
  source: string;
  initialMemory: string[];
  memorySize: number;
  maxSteps: number;
  seed: string;
}

export type WorkerRequest =
  | { requestId: number; type: "init"; payload: VmInitPayload }
  | { requestId: number; type: "step" }
  | { requestId: number; type: "run" };

export type WorkerResponse =
  | { requestId: number; ok: true; snapshot: VmSnapshot }
  | { requestId: number; ok: false; error: string };
