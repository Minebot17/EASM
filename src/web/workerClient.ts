import type { VmSnapshot } from "../core";
import type { VmInitPayload, WorkerRequest, WorkerResponse } from "./workerProtocol";

type WorkerCommand =
  | { type: "init"; payload: VmInitPayload }
  | { type: "step" }
  | { type: "run" };

interface PendingRequest {
  resolve: (snapshot: VmSnapshot) => void;
  reject: (error: Error) => void;
}

export class EasmWorkerClient {
  private readonly worker = new Worker(new URL("./easm.worker.ts", import.meta.url), { type: "module" });
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private disposed = false;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      if (response.ok) pending.resolve(response.snapshot);
      else pending.reject(new Error(response.error));
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "Ошибка Web Worker");
      this.pending.forEach(({ reject }) => reject(error));
      this.pending.clear();
    };
  }

  init(payload: VmInitPayload): Promise<VmSnapshot> {
    return this.request({ type: "init", payload });
  }

  step(): Promise<VmSnapshot> {
    return this.request({ type: "step" });
  }

  run(): Promise<VmSnapshot> {
    return this.request({ type: "run" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.pending.forEach(({ reject }) => reject(new Error("Worker остановлен")));
    this.pending.clear();
  }

  private request(request: WorkerCommand): Promise<VmSnapshot> {
    if (this.disposed) return Promise.reject(new Error("Worker уже остановлен"));
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ ...request, requestId } as WorkerRequest);
    });
  }
}
