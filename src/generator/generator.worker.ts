/// <reference lib="webworker" />
import { evaluateRandomProgram, generateRandomCandidate, type SearchConfig, type SearchProgress, type SuccessfulProgram } from "./search";
import type { GeneratorRequest, GeneratorResponse, SearchPayload } from "./protocol";

const MAX_STORED_RESULTS = 500;
let activeRunId = 0;
let cancelledRunId = 0;

function post(response: GeneratorResponse): void {
  self.postMessage(response);
}

function configFromPayload(payload: SearchPayload): SearchConfig {
  return {
    ...payload,
    seed: BigInt(payload.seed),
    initialMemory: payload.initialMemory.map(BigInt),
    expectedMemory: payload.expectedMemory.map(BigInt),
  };
}

async function startSearch(
  runId: number,
  workerId: number,
  startOrdinal: number,
  stride: number,
  payload: SearchPayload,
): Promise<void> {
  activeRunId = runId;
  cancelledRunId = 0;
  const config = configFromPayload(payload);
  const startedAt = performance.now();
  const deadline = startedAt + config.timeLimitMs;
  const progress: SearchProgress = { generated: 0, successful: 0, errors: 0, limits: 0, elapsedMs: 0 };
  let pendingMatches: SuccessfulProgram[] = [];
  let storedResults = 0;
  let reason: "count" | "time" | "cancelled" = "count";

  for (let ordinal = startOrdinal; ordinal <= config.maxPrograms; ordinal += stride) {
    if (activeRunId !== runId || cancelledRunId === runId) {
      reason = "cancelled";
      break;
    }
    if (performance.now() >= deadline) {
      reason = "time";
      break;
    }

    const candidate = generateRandomCandidate(config, ordinal);
    const evaluation = evaluateRandomProgram(candidate, config, ordinal);
    progress.generated += 1;
    if (evaluation.status === "error") progress.errors += 1;
    if (evaluation.status === "limit") progress.limits += 1;
    if (evaluation.status === "success" && evaluation.result) {
      progress.successful += 1;
      if (storedResults < MAX_STORED_RESULTS) {
        pendingMatches.push(evaluation.result);
        storedResults += 1;
      }
    }

    if (progress.generated % 50 === 0) {
      progress.elapsedMs = performance.now() - startedAt;
      post({ type: "progress", runId, workerId, progress: { ...progress }, matches: pendingMatches });
      pendingMatches = [];
      await new Promise<void>((resolve) => self.setTimeout(resolve, 0));
    }
  }

  progress.elapsedMs = performance.now() - startedAt;
  if (pendingMatches.length) post({ type: "progress", runId, workerId, progress: { ...progress }, matches: pendingMatches });
  post({
    type: "complete",
    runId,
    workerId,
    progress,
    reason,
    resultsTruncated: progress.successful > MAX_STORED_RESULTS,
  });
}

self.onmessage = (event: MessageEvent<GeneratorRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    cancelledRunId = request.runId;
    return;
  }
  startSearch(request.runId, request.workerId, request.startOrdinal, request.stride, request.payload).catch((error: unknown) => {
    post({ type: "error", runId: request.runId, workerId: request.workerId, error: error instanceof Error ? error.message : String(error) });
  });
};
