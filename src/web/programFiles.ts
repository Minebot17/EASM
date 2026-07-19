export interface ProgramFileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
  }>;
}

export interface OpenedProgramFile {
  name: string;
  source: string;
  handle: ProgramFileHandle;
}

export interface SavedProgramFile {
  name: string;
  handle: ProgramFileHandle | null;
}

interface FilePickerWindow extends Window {
  showOpenFilePicker?: (options: unknown) => Promise<ProgramFileHandle[]>;
  showSaveFilePicker?: (options: unknown) => Promise<ProgramFileHandle>;
}

const pickerOptions = {
  types: [{
    description: "Программа EASM",
    accept: { "text/plain": [".easm"] },
  }],
  excludeAcceptAllOption: false,
};

function pickerWindow(): FilePickerWindow {
  return window as FilePickerWindow;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function normalizeProgramFileName(name: string): string {
  const safe = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
  if (!safe) return "program.easm";
  return safe.toLowerCase().endsWith(".easm") ? safe : `${safe}.easm`;
}

export function supportsNativeOpen(): boolean {
  return typeof pickerWindow().showOpenFilePicker === "function";
}

export async function openProgramWithPicker(): Promise<OpenedProgramFile | null> {
  const openPicker = pickerWindow().showOpenFilePicker;
  if (!openPicker) return null;
  try {
    const [handle] = await openPicker({ ...pickerOptions, multiple: false });
    if (!handle) return null;
    const file = await handle.getFile();
    return { name: file.name, source: await file.text(), handle };
  } catch (error) {
    if (isAbort(error)) return null;
    throw error;
  }
}

export async function readProgramFile(file: File): Promise<{ name: string; source: string }> {
  return { name: file.name, source: await file.text() };
}

export async function saveProgramFile(
  source: string,
  suggestedName: string,
  existingHandle: ProgramFileHandle | null,
  saveAs: boolean,
): Promise<SavedProgramFile | null> {
  let handle = saveAs ? null : existingHandle;
  const name = normalizeProgramFileName(suggestedName);

  if (!handle) {
    const savePicker = pickerWindow().showSaveFilePicker;
    if (!savePicker) {
      downloadProgramFile(source, name);
      return { name, handle: null };
    }
    try {
      handle = await savePicker({ ...pickerOptions, suggestedName: name });
    } catch (error) {
      if (isAbort(error)) return null;
      throw error;
    }
  }

  const writable = await handle.createWritable();
  await writable.write(source);
  await writable.close();
  return { name: handle.name || name, handle };
}

function downloadProgramFile(source: string, name: string): void {
  const url = URL.createObjectURL(new Blob([source], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
