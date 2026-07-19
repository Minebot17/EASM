import { useEffect, useRef, useState } from "react";
import { bitsToCells, integerListToCells, utf8ToCells } from "../core";
import type { GeneratorRequest, GeneratorResponse, SearchPayload } from "./protocol";
import type { SearchProgress, SuccessfulProgram } from "./search";
import type { ComparisonMode } from "./search";

type DataFormat = "text" | "bits" | "integers";
type GeneratorCase = { id: number; input: string; expected: string };

const EMPTY_PROGRESS: SearchProgress = { generated: 0, successful: 0, errors: 0, limits: 0, elapsedMs: 0 };

function encodeInput(format: DataFormat, value: string): bigint[] {
  if (format === "text") return utf8ToCells(value);
  if (format === "bits") return bitsToCells(value);
  return integerListToCells(value);
}

function clampInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}: допустимый диапазон ${minimum}…${maximum}`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} должно быть положительным целым числом`);
  }
  return value;
}

function completionLabel(reason: "count" | "time" | "cancelled" | "idle"): string {
  if (reason === "count") return "Достигнут лимит программ";
  if (reason === "time") return "Достигнут лимит времени";
  if (reason === "cancelled") return "Остановлено пользователем";
  return "Готово к поиску";
}

export function GeneratorApp() {
  const workersRef = useRef<Worker[]>([]);
  const workerProgressRef = useRef(new Map<number, SearchProgress>());
  const completedWorkersRef = useRef(new Set<number>());
  const workerReasonsRef = useRef(new Map<number, "count" | "time" | "cancelled">());
  const activeWorkerCountRef = useRef(0);
  const storedResultsRef = useRef<SuccessfulProgram[]>([]);
  const runIdRef = useRef(0);
  const nextCaseIdRef = useRef(2);
  const [format, setFormat] = useState<DataFormat>("integers");
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>("ignoreZeros");
  const [cases, setCases] = useState<GeneratorCase[]>([{ id: 1, input: "0", expected: "1" }]);
  const [maxPrograms, setMaxPrograms] = useState(5_000);
  const [instructionsPerProgram, setInstructionsPerProgram] = useState(4);
  const [timeLimitSeconds, setTimeLimitSeconds] = useState(5);
  const [memorySize, setMemorySize] = useState(64);
  const [workerCount, setWorkerCount] = useState(() => {
    const logicalProcessors = typeof navigator === "undefined" ? 4 : (navigator.hardwareConcurrency || 4);
    return Math.max(1, Math.min(8, logicalProcessors - 1));
  });
  const [seed, setSeed] = useState("1");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SearchProgress>(EMPTY_PROGRESS);
  const [results, setResults] = useState<SuccessfulProgram[]>([]);
  const [resultsTruncated, setResultsTruncated] = useState(false);
  const [stopReason, setStopReason] = useState<"count" | "time" | "cancelled" | "idle">("idle");
  const [error, setError] = useState("");

  const terminateWorkers = () => {
    workersRef.current.forEach((worker) => worker.terminate());
    workersRef.current = [];
  };

  const aggregateProgress = (): SearchProgress => {
    const values = [...workerProgressRef.current.values()];
    return values.reduce<SearchProgress>((total, current) => ({
      generated: total.generated + current.generated,
      successful: total.successful + current.successful,
      errors: total.errors + current.errors,
      limits: total.limits + current.limits,
      elapsedMs: Math.max(total.elapsedMs, current.elapsedMs),
    }), { ...EMPTY_PROGRESS });
  };

  const handleResponse = (response: GeneratorResponse) => {
    if (response.runId !== runIdRef.current) return;
    if (response.type === "error") {
      setError(response.error);
      setRunning(false);
      terminateWorkers();
      return;
    }

    workerProgressRef.current.set(response.workerId, response.progress);
    setProgress(aggregateProgress());
    if (response.type === "progress" && response.matches.length) {
      const merged = [...storedResultsRef.current, ...response.matches].sort((left, right) => left.ordinal - right.ordinal);
      if (merged.length > 500) setResultsTruncated(true);
      storedResultsRef.current = merged.slice(0, 500);
      setResults(storedResultsRef.current);
    }
    if (response.type === "complete") {
      completedWorkersRef.current.add(response.workerId);
      workerReasonsRef.current.set(response.workerId, response.reason);
      if (response.resultsTruncated) setResultsTruncated(true);
      if (completedWorkersRef.current.size === activeWorkerCountRef.current) {
        const reasons = [...workerReasonsRef.current.values()];
        const reason = reasons.includes("cancelled") ? "cancelled" : reasons.includes("time") ? "time" : "count";
        setRunning(false);
        setStopReason(reason);
        terminateWorkers();
      }
    }
  };

  useEffect(() => {
    return terminateWorkers;
  }, []);

  const updateCase = (id: number, field: "input" | "expected", value: string) => {
    setCases((current) => current.map((testCase) => testCase.id === id ? { ...testCase, [field]: value } : testCase));
  };

  const addCase = () => {
    const id = nextCaseIdRef.current;
    nextCaseIdRef.current += 1;
    setCases((current) => [...current, { id, input: "", expected: "" }]);
  };

  const removeCase = (id: number) => {
    setCases((current) => current.filter((testCase) => testCase.id !== id));
  };

  const startSearch = () => {
    setError("");
    try {
      if (!cases.length) throw new Error("Добавьте хотя бы одно условие");
      const encodedCases = cases.map((testCase, index) => {
        const initialMemory = encodeInput(format, testCase.input);
        const expectedMemory = encodeInput(format, testCase.expected);
        if (initialMemory.length > 65_536 || expectedMemory.length > 65_536) {
          throw new Error(`Условие ${index + 1}: вход или ожидаемый выход превышает 65536 ячеек`);
        }
        return { initialMemory, expectedMemory };
      });
      const validatedMaxPrograms = positiveInteger(maxPrograms, "Количество программ");
      const validatedInstructions = clampInteger(instructionsPerProgram, 1, 64, "Количество инструкций");
      const validatedMemorySize = clampInteger(memorySize, 1, 65_536, "Количество ячеек памяти");
      const validatedWorkerCount = clampInteger(workerCount, 1, 64, "Количество потоков");
      if (!Number.isFinite(timeLimitSeconds) || timeLimitSeconds < 0.1 || timeLimitSeconds > 300) {
        throw new Error("Время поиска: допустимый диапазон 0.1…300 секунд");
      }
      const oversizedCase = encodedCases.findIndex((testCase) =>
        testCase.initialMemory.length > validatedMemorySize || testCase.expectedMemory.length > validatedMemorySize);
      if (oversizedCase >= 0) {
        throw new Error(`Условие ${oversizedCase + 1}: вход и ожидаемый выход должны помещаться в заданную память`);
      }
      BigInt(seed);

      const payload: SearchPayload = {
        maxPrograms: validatedMaxPrograms,
        instructionsPerProgram: validatedInstructions,
        timeLimitMs: timeLimitSeconds * 1_000,
        memorySize: validatedMemorySize,
        maxStepsPerProgram: Math.min(2_000, Math.max(100, validatedInstructions * 25)),
        seed,
        cases: encodedCases.map((testCase) => ({
          initialMemory: testCase.initialMemory.map(String),
          expectedMemory: testCase.expectedMemory.map(String),
        })),
        comparisonMode,
      };
      runIdRef.current += 1;
      const startedRunId = runIdRef.current;
      terminateWorkers();
      const actualWorkerCount = Math.min(validatedWorkerCount, validatedMaxPrograms);
      activeWorkerCountRef.current = actualWorkerCount;
      workerProgressRef.current = new Map(
        Array.from({ length: actualWorkerCount }, (_, workerId) => [workerId, { ...EMPTY_PROGRESS }]),
      );
      completedWorkersRef.current = new Set();
      workerReasonsRef.current = new Map();
      setProgress(EMPTY_PROGRESS);
      storedResultsRef.current = [];
      setResults([]);
      setResultsTruncated(false);
      setStopReason("idle");
      setRunning(true);
      workersRef.current = Array.from({ length: actualWorkerCount }, (_, workerId) => {
        const worker = new Worker(new URL("./generator.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<GeneratorResponse>) => handleResponse(event.data);
        worker.onerror = (event) => {
          if (runIdRef.current !== startedRunId) return;
          setError(event.message || `Ошибка worker #${workerId + 1}`);
          setRunning(false);
          terminateWorkers();
        };
        const request: GeneratorRequest = {
          type: "start",
          runId: startedRunId,
          workerId,
          startOrdinal: workerId + 1,
          stride: actualWorkerCount,
          payload,
        };
        worker.postMessage(request);
        return worker;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const cancelSearch = () => {
    const request: GeneratorRequest = { type: "cancel", runId: runIdRef.current };
    workersRef.current.forEach((worker) => worker.postMessage(request));
  };

  const countProgress = maxPrograms > 0 ? progress.generated / maxPrograms : 0;
  const timeProgress = timeLimitSeconds > 0 ? progress.elapsedMs / (timeLimitSeconds * 1_000) : 0;
  const progressPercent = Math.min(100, Math.max(countProgress, timeProgress) * 100);

  return (
    <main className="app-shell generator-shell">
      <header className="hero generator-hero">
        <div>
          <div className="eyebrow">RANDOM PROGRAM SEARCH</div>
          <h1>Генератор программ</h1>
          <p>Создаёт случайный EASM-код и оставляет программы с совпадающими значимыми значениями выходной памяти.</p>
        </div>
        <a className="nav-link" href="/">← Лаборатория</a>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <section className="card generator-config">
        <div className="generator-section-title">
          <div><span>Критерий результата</span><small>Один формат применяется ко входу и ожидаемому выходу</small></div>
          <div className="segmented generator-format">
            {(["text", "bits", "integers"] as DataFormat[]).map((item) => (
              <button disabled={running} key={item} className={format === item ? "active" : ""} onClick={() => setFormat(item)}>{item}</button>
            ))}
          </div>
        </div>
        <div className="generator-cases">
          {cases.map((testCase, index) => (
            <div className="generator-case" key={testCase.id}>
              <div className="case-heading">
                <strong>Условие #{index + 1}</strong>
                <button className="button ghost case-remove" disabled={running || cases.length === 1} onClick={() => removeCase(testCase.id)}>Удалить</button>
              </div>
              <div className="criteria-grid">
                <label>Входные данные
                  <textarea disabled={running} value={testCase.input} onChange={(event) => updateCase(testCase.id, "input", event.target.value)} placeholder="Начальное содержимое памяти" />
                </label>
                <div className="transform-arrow">→</div>
                <label>Ожидаемый выход
                  <textarea disabled={running} value={testCase.expected} onChange={(event) => updateCase(testCase.id, "expected", event.target.value)} placeholder="Требуемое содержимое памяти" />
                </label>
              </div>
            </div>
          ))}
          <button className="button ghost add-case" disabled={running} onClick={addCase}>+ Добавить условие</button>
        </div>

        <div className="comparison-row">
          <span>Сравнение результата</span>
          <div className="segmented">
            <button disabled={running} className={comparisonMode === "exact" ? "active" : ""} onClick={() => setComparisonMode("exact")}>Учитывать нули</button>
            <button disabled={running} className={comparisonMode === "ignoreZeros" ? "active" : ""} onClick={() => setComparisonMode("ignoreZeros")}>Игнорировать нули</button>
          </div>
          <small>{comparisonMode === "exact" ? "Совпадают значения и их позиции." : "Нули удаляются, значимые значения сравниваются по порядку."}</small>
        </div>

        <div className="limits-grid">
          <label>Максимум программ
            <input disabled={running} type="number" min="1" value={maxPrograms} onChange={(event) => setMaxPrograms(Number(event.target.value))} />
          </label>
          <label>Инструкций в программе
            <input disabled={running} type="number" min="1" max="64" value={instructionsPerProgram} onChange={(event) => setInstructionsPerProgram(Number(event.target.value))} />
          </label>
          <label>Ячеек доступной памяти
            <input disabled={running} type="number" min="1" max="65536" value={memorySize} onChange={(event) => setMemorySize(Number(event.target.value))} />
          </label>
          <label>Потоков Web Worker
            <input disabled={running} type="number" min="1" max="64" value={workerCount} onChange={(event) => setWorkerCount(Number(event.target.value))} />
          </label>
          <label>Лимит времени, секунд
            <input disabled={running} type="number" min="0.1" max="300" step="0.1" value={timeLimitSeconds} onChange={(event) => setTimeLimitSeconds(Number(event.target.value))} />
          </label>
          <label>Seed генератора
            <input disabled={running} value={seed} onChange={(event) => setSeed(event.target.value)} />
          </label>
        </div>

        <div className="generator-actions">
          <button className="button primary generator-start" disabled={running} onClick={startSearch}>Запустить генерацию и фильтрацию</button>
          <button className="button ghost" disabled={!running} onClick={cancelSearch}>Остановить</button>
          <span>Поиск идёт в {workerCount} поток(ах). Адресация памяти: примерно ⅓ `[15]`, ⅓ `[A]`, ⅓ `[[15]]`.</span>
        </div>
      </section>

      <section className="card progress-card">
        <div className="progress-header">
          <strong>{running ? "Поиск выполняется" : completionLabel(stopReason)}</strong>
          <span>{progress.elapsedMs.toFixed(0)} мс</span>
        </div>
        <div className="progress-track"><div style={{ width: `${progressPercent}%` }} /></div>
        <div className="metric-grid">
          <div><span>Сгенерировано</span><strong>{progress.generated.toLocaleString("ru-RU")}</strong></div>
          <div><span>Успешных</span><strong className="success-number">{progress.successful.toLocaleString("ru-RU")}</strong></div>
          <div><span>Runtime errors</span><strong>{progress.errors.toLocaleString("ru-RU")}</strong></div>
          <div><span>Лимит шагов</span><strong>{progress.limits.toLocaleString("ru-RU")}</strong></div>
        </div>
      </section>

      <section className="results-section">
        <div className="results-heading">
          <div><h2>Успешные программы</h2><p>Показан исходный случайный код; при самомодификации также доступен итоговый код.</p></div>
          <span>{results.length}{resultsTruncated ? "+" : ""} вариантов</span>
        </div>
        {resultsTruncated && <div className="notice">Найдено больше 500 вариантов. Для устойчивости интерфейса показаны первые 500.</div>}
        <div className="result-list">
          {results.map((result) => (
            <details className="card result-card" key={result.ordinal}>
              <summary>
                <span>Кандидат #{result.ordinal}</span>
                <small>{result.runs.length} прогонов · {result.steps} шагов · {result.mutations} мутаций</small>
              </summary>
              <div className="result-code-grid">
                <div><strong>Сгенерированный код</strong><pre>{result.source}</pre></div>
                {result.runs.map((run) => run.finalSource !== result.source && (
                  <div key={run.caseIndex}><strong>Код после условия #{run.caseIndex + 1} · {run.steps} шагов</strong><pre>{run.finalSource}</pre></div>
                ))}
              </div>
            </details>
          ))}
          {!results.length && <div className="card generator-empty">{running ? "Первые совпадения появятся здесь…" : "Запустите поиск. Для сложных преобразований увеличьте число программ или время."}</div>}
        </div>
      </section>

      <footer>{comparisonMode === "exact" ? "Режим учитывает значения и позиции нулевых ячеек." : "Режим игнорирует нули и сравнивает остальные значения по порядку."} Программы с runtime error или лимитом шагов отбрасываются.</footer>
    </main>
  );
}
