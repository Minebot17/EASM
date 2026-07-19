import { useEffect, useMemo, useRef, useState } from "react";
import {
  bitsToCells,
  cellsToBits,
  cellsToUtf8,
  integerListToCells,
  type VmSnapshot,
  utf8ToCells,
} from "../core";
import { EasmWorkerClient } from "./workerClient";
import type { VmInitPayload } from "./workerProtocol";
import {
  normalizeProgramFileName,
  openProgramWithPicker,
  readProgramFile,
  saveProgramFile,
  supportsNativeOpen,
  type ProgramFileHandle,
} from "./programFiles";

type InputMode = "text" | "bits" | "integers";
type OutputMode = "text" | "bits" | "integers";

const EXAMPLES: Record<string, string> = {
  "Арифметика": `; add принимает два источника и назначение
mov 40, A
mov 2, B
add A, B, C
mul C, 10, [0]
halt`,
  "Случайные числа": `; Одинаковый seed даёт одинаковый результат
rand A
rand [0]
xor A, [0], C
halt`,
  "Самовставка": `; Дескрипторы будущей команды mov 42, [10]
mov 2, [0]
mov 42, [1]
mov 1, [2]
mov 10, [3]
insert 19, 7, 0, 2
jmp 7
halt`,
  "Цикл": `mov 5, A
loop:
add [0], A, [0]
dec A, A
jnz A, loop
halt`,
};

interface ExperimentResult {
  input: string;
  status: string;
  steps: number;
  output: string;
  mutations: number;
}

function initialCells(mode: InputMode, input: string): bigint[] {
  if (mode === "text") return utf8ToCells(input);
  if (mode === "bits") return bitsToCells(input);
  return integerListToCells(input);
}

function compactCells(snapshot: VmSnapshot): bigint[] {
  const memory = snapshot.memory.map(BigInt);
  let end = memory.length;
  while (end > 1 && memory[end - 1] === 0n) end -= 1;
  return memory.slice(0, end);
}

function renderOutput(snapshot: VmSnapshot, mode: OutputMode): string {
  const cells = snapshot.memory.map(BigInt);
  if (mode === "text") return cellsToUtf8(cells);
  if (mode === "bits") return cellsToBits(cells.slice(0, 16), "\n");
  return compactCells(snapshot).map(String).join(", ");
}

function statusLabel(status: VmSnapshot["status"]): string {
  return ({ ready: "готова", running: "выполняется", halted: "завершена", error: "ошибка", limit: "лимит" })[status];
}

export function App() {
  const clientRef = useRef<EasmWorkerClient | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const getClient = (): EasmWorkerClient => {
    if (!clientRef.current) clientRef.current = new EasmWorkerClient();
    return clientRef.current;
  };

  const [source, setSource] = useState(EXAMPLES["Самовставка"]);
  const [programFileName, setProgramFileName] = useState("self-insert.easm");
  const [programFileHandle, setProgramFileHandle] = useState<ProgramFileHandle | null>(null);
  const [programDirty, setProgramDirty] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>("text");
  const [input, setInput] = useState("");
  const [outputMode, setOutputMode] = useState<OutputMode>("integers");
  const [memorySize, setMemorySize] = useState(64);
  const [maxSteps, setMaxSteps] = useState(10_000);
  const [seed, setSeed] = useState("1");
  const [snapshot, setSnapshot] = useState<VmSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeSignature, setActiveSignature] = useState("");
  const [experimentInputs, setExperimentInputs] = useState("alpha\nbeta\ngamma");
  const [experimentResults, setExperimentResults] = useState<ExperimentResult[]>([]);

  useEffect(() => {
    const client = getClient();
    return () => {
      if (clientRef.current === client) clientRef.current = null;
      client.dispose();
    };
  }, []);

  const signature = useMemo(
    () => JSON.stringify({ source, inputMode, input, memorySize, maxSteps, seed }),
    [source, inputMode, input, memorySize, maxSteps, seed],
  );

  const makePayload = (caseInput = input): VmInitPayload => ({
    source,
    initialMemory: initialCells(inputMode, caseInput).map(String),
    memorySize,
    maxSteps,
    seed,
  });

  const loadProgram = (nextSource: string, name: string, handle: ProgramFileHandle | null) => {
    setSource(nextSource);
    setProgramFileName(normalizeProgramFileName(name));
    setProgramFileHandle(handle);
    setProgramDirty(false);
    setSnapshot(null);
    setActiveSignature("");
    setExperimentResults([]);
  };

  const selectExample = (name: string) => {
    if (!name) return;
    loadProgram(EXAMPLES[name], `${name}.easm`, null);
  };

  const openProgram = async () => {
    setError("");
    if (!supportsNativeOpen()) {
      fileInputRef.current?.click();
      return;
    }
    setFileBusy(true);
    try {
      const opened = await openProgramWithPicker();
      if (opened) loadProgram(opened.source, opened.name, opened.handle);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFileBusy(false);
    }
  };

  const openFallbackFile = async (file: File | undefined) => {
    if (!file) return;
    setFileBusy(true);
    setError("");
    try {
      const opened = await readProgramFile(file);
      loadProgram(opened.source, opened.name, null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFileBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const saveProgram = async (saveAs: boolean) => {
    setFileBusy(true);
    setError("");
    try {
      const saved = await saveProgramFile(source, programFileName, programFileHandle, saveAs);
      if (saved) {
        setProgramFileName(saved.name);
        setProgramFileHandle(saved.handle);
        setProgramDirty(false);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFileBusy(false);
    }
  };

  const perform = async (action: "reset" | "step" | "run") => {
    setBusy(true);
    setError("");
    try {
      let result: VmSnapshot;
      if (action === "reset" || action === "run" || activeSignature !== signature) {
        result = await getClient().init(makePayload());
        setActiveSignature(signature);
      } else {
        result = snapshot!;
      }
      if (action === "step") result = await getClient().step();
      if (action === "run") result = await getClient().run();
      setSnapshot(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const runExperiments = async () => {
    const cases = experimentInputs.split(/\r?\n/).slice(0, 20);
    setBusy(true);
    setError("");
    setExperimentResults([]);
    try {
      const results: ExperimentResult[] = [];
      for (const caseInput of cases) {
        await getClient().init(makePayload(caseInput));
        const result = await getClient().run();
        results.push({
          input: caseInput,
          status: statusLabel(result.status),
          steps: result.steps,
          output: renderOutput(result, outputMode).slice(0, 160),
          mutations: result.mutations.length,
        });
      }
      setExperimentResults(results);
      setActiveSignature("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const visibleMemory = snapshot?.memory.slice(0, Math.min(snapshot.memory.length, 64)) ?? [];

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <div className="eyebrow">EVOLUTIONAL ASSEMBLY LAB</div>
          <h1>EASM Laboratory</h1>
          <p>Пишите код, меняющий собственные инструкции, и наблюдайте каждую мутацию VM.</p>
        </div>
        <div className="status-stack">
          <span className={`status status-${snapshot?.status ?? "idle"}`}>{snapshot ? statusLabel(snapshot.status) : "не запущена"}</span>
          <span>{snapshot ? `${snapshot.steps} шагов` : "seeded 64-bit VM"}</span>
          <a className="nav-link" href="/generator.html">Генератор программ →</a>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <section className="toolbar card">
        <label>Пример
          <select value="" onChange={(event) => selectExample(event.target.value)}>
            <option value="">Выберите…</option>
            {Object.keys(EXAMPLES).map((name) => <option key={name}>{name}</option>)}
          </select>
        </label>
        <div className="file-actions" aria-label="Файл программы">
          <button className="button ghost" disabled={fileBusy} onClick={openProgram}>Открыть</button>
          <button className="button ghost" disabled={fileBusy} onClick={() => saveProgram(false)}>Сохранить</button>
          <button className="button ghost" disabled={fileBusy} onClick={() => saveProgram(true)}>Сохранить как…</button>
          <input
            ref={fileInputRef}
            className="hidden-file-input"
            type="file"
            accept=".easm,text/plain"
            onChange={(event) => openFallbackFile(event.target.files?.[0])}
          />
        </div>
        <label>Память
          <input type="number" min="8" max="65536" value={memorySize} onChange={(event) => setMemorySize(Number(event.target.value))} />
        </label>
        <label>Лимит шагов
          <input type="number" min="1" max="10000000" value={maxSteps} onChange={(event) => setMaxSteps(Number(event.target.value))} />
        </label>
        <label>Seed rand
          <input value={seed} onChange={(event) => setSeed(event.target.value)} />
        </label>
        <div className="actions">
          <button className="button ghost" disabled={busy} onClick={() => perform("reset")}>Сброс</button>
          <button className="button ghost" disabled={busy} onClick={() => perform("step")}>Шаг</button>
          <button className="button primary" disabled={busy} onClick={() => perform("run")}>{busy ? "Работа…" : "Запуск"}</button>
        </div>
      </section>

      <section className="workspace-grid">
        <article className="card editor-card">
          <div className="card-title">
            <span>Программа</span>
            <small className={programDirty ? "file-name dirty" : "file-name"}>{programFileName}{programDirty ? " · не сохранено" : ""}</small>
          </div>
          <textarea className="code-editor" spellCheck={false} value={source} onChange={(event) => { setSource(event.target.value); setProgramDirty(true); }} />
        </article>

        <article className="card io-card">
          <div className="card-title"><span>Входная память</span><small>{initialCellsSafe(inputMode, input)} ячеек</small></div>
          <div className="segmented">
            {(["text", "bits", "integers"] as InputMode[]).map((mode) => (
              <button key={mode} className={inputMode === mode ? "active" : ""} onClick={() => setInputMode(mode)}>{mode}</button>
            ))}
          </div>
          <textarea className="io-editor" value={input} onChange={(event) => setInput(event.target.value)} placeholder={inputMode === "text" ? "UTF-8 текст" : inputMode === "bits" ? "010101…" : "1, -2, 3"} />
          <div className="card-title output-title"><span>Выход</span><small>UTF-8 использует младший байт каждой ячейки</small></div>
          <div className="segmented">
            {(["text", "bits", "integers"] as OutputMode[]).map((mode) => (
              <button key={mode} className={outputMode === mode ? "active" : ""} onClick={() => setOutputMode(mode)}>{mode}</button>
            ))}
          </div>
          <pre className="output">{snapshot ? renderOutput(snapshot, outputMode) : "—"}</pre>
        </article>
      </section>

      <section className="state-grid">
        <article className="card">
          <div className="card-title"><span>Регистры</span><small>{snapshot?.reason ?? "VM ожидает запуска"}</small></div>
          <div className="registers">
            {(["A", "B", "C", "D"] as const).map((name) => <div key={name}><strong>{name}</strong><code>{snapshot?.registers[name] ?? "0"}</code></div>)}
          </div>
        </article>

        <article className="card memory-card">
          <div className="card-title"><span>Память</span><small>первые {visibleMemory.length} ячеек</small></div>
          <div className="memory-grid">
            {visibleMemory.map((value, index) => <div className={value !== "0" ? "memory-cell changed" : "memory-cell"} key={index}><span>[{index}]</span><code>{value}</code></div>)}
          </div>
        </article>
      </section>

      <section className="workspace-grid lower-grid">
        <article className="card program-card">
          <div className="card-title"><span>Исполняемый код</span><small>{snapshot?.program.length ?? 0} инструкций</small></div>
          <div className="program-list">
            {snapshot?.program.map((instruction, index) => (
              <div key={instruction.id} className={`${snapshot.pc === index ? "current" : ""} ${instruction.generated ? "generated" : ""}`}>
                <span>{index.toString().padStart(3, "0")}</span><code>{instruction.text}</code><small>id:{instruction.id}</small>
              </div>
            )) ?? <div className="empty">Запустите или сбросьте VM</div>}
          </div>
        </article>

        <article className="card mutation-card">
          <div className="card-title"><span>Мутации</span><small>{snapshot?.mutations.length ?? 0} событий</small></div>
          <div className="event-list">
            {snapshot?.mutations.slice().reverse().map((mutation, index) => (
              <div className={`event event-${mutation.kind}`} key={`${mutation.step}-${index}`}>
                <strong>#{mutation.step} · {mutation.kind} @{mutation.index}</strong>
                {mutation.before && <code>− {mutation.before}</code>}
                {mutation.after && <code>+ {mutation.after}</code>}
              </div>
            )) ?? null}
            {!snapshot?.mutations.length && <div className="empty">Пока без изменений кода</div>}
          </div>
        </article>
      </section>

      <section className="workspace-grid lower-grid">
        <article className="card">
          <div className="card-title"><span>Трасса</span><small>последние 100 шагов</small></div>
          <div className="trace-list">
            {snapshot?.trace.slice(-100).reverse().map((event) => <div key={event.step}><span>#{event.step}</span><span>PC {event.pc}</span><code>{event.instruction}</code></div>)}
            {!snapshot?.trace.length && <div className="empty">Трасса появится после выполнения</div>}
          </div>
        </article>

        <article className="card experiment-card">
          <div className="card-title"><span>Пакетный эксперимент</span><small>до 20 входов, по одному на строку</small></div>
          <textarea className="experiment-input" value={experimentInputs} onChange={(event) => setExperimentInputs(event.target.value)} />
          <button className="button primary" disabled={busy} onClick={runExperiments}>Прогнать набор</button>
          <div className="experiment-results">
            {experimentResults.map((result, index) => <div key={index}><strong>{JSON.stringify(result.input)}</strong><span>{result.status} · {result.steps} шагов · {result.mutations} мутаций</span><code>{result.output || "∅"}</code></div>)}
          </div>
        </article>
      </section>

      <footer>Все числа VM нормализуются до signed int64. Shift count — младшие 6 бит. `rand` использует воспроизводимый SplitMix64.</footer>
    </main>
  );
}

function initialCellsSafe(mode: InputMode, input: string): string {
  try {
    return String(initialCells(mode, input).length);
  } catch {
    return "?";
  }
}
