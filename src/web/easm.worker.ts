/// <reference lib="webworker" />
import { EasmVm, parseProgram } from "../core";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";

let vm: EasmVm | null = null;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "init") {
      vm = new EasmVm(parseProgram(request.payload.source), {
        memorySize: request.payload.memorySize,
        maxSteps: request.payload.maxSteps,
        seed: BigInt(request.payload.seed),
        initialMemory: request.payload.initialMemory.map(BigInt),
      });
    } else if (!vm) {
      throw new Error("VM не инициализирована");
    } else if (request.type === "step") {
      vm.step();
    } else {
      vm.run();
    }

    const response: WorkerResponse = {
      requestId: request.requestId,
      ok: true,
      snapshot: vm!.snapshot(),
    };
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
