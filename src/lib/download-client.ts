import { DefaultConfig } from "./configs";
import { env } from "./env";

/**
 * Thin client for the background-owned resumable download manager.
 *
 * All ONNX weight downloads (setup wizard, popup Config, sidebar Vision)
 * go through the service worker so Pause in one UI can Resume in another:
 * partial chunks live in the worker heap, keyed by resolved URL, and every
 * UI subscribes to the same `MODEL_DOWNLOAD_PROGRESS` broadcasts.
 * Newly opened UIs (popup remounts on every open) re-query
 * `GET_ACTIVE_DOWNLOADS` to render the correct Download/Pause/Resume state.
 */

export type ManagedDownloadStatus = "idle" | "downloading" | "paused" | "done" | "error";

export interface ManagedDownloadFile {
  repo: string;
  path: string;
  /** Short UI label, e.g. "Encoder" / "Latin pack 1/4". */
  label?: string;
}

export interface ManagedDownloadSnapshot {
  key: string;
  status: ManagedDownloadStatus;
  /** 0..1 across the whole file list. */
  fraction: number;
  loaded: number;
  total: number;
  fileIndex: number;
  fileCount: number;
  /** Label of the file currently streaming (or last touched). */
  fileLabel: string;
  error: string | null;
}

export interface ManagedDownloadJob {
  key: string;
  files: ManagedDownloadFile[];
}

function gateFiles(): ManagedDownloadFile[] {
  return [
    { repo: DefaultConfig.gateRepo, path: DefaultConfig.gateModelPath, label: "Language Gate model" },
    { repo: DefaultConfig.gateRepo, path: DefaultConfig.gateLabelsPath, label: "Language Gate labels" },
  ];
}

/** Canonical detection job — same file the setup wizard fetches. */
export function detectionDownloadJob(modelId: string): ManagedDownloadJob {
  if (modelId === "comic-text-detector") {
    return {
      key: "detection:comic-text-detector",
      files: [{ repo: "direct-model-cache", path: DefaultConfig.comicTextDetectorUrl, label: "Detector weights" }],
    };
  }
  return {
    key: "detection:comic-bubble",
    files: [{ repo: DefaultConfig.rtdetrModelRepo, path: "detector-v4-s_int8.onnx", label: "Detector weights" }],
  };
}

/** Canonical OCR job — full engine file list (identical to the setup sequence). */
export function ocrDownloadJob(engineId: string): ManagedDownloadJob {
  const gate = gateFiles();
  if (engineId === "manga-ocr") {
    return {
      key: "ocr:manga-ocr",
      files: [
        { repo: DefaultConfig.mangaOcrRepo, path: "encoder_model.onnx", label: "Encoder" },
        { repo: DefaultConfig.mangaOcrRepo, path: "decoder_model.onnx", label: "Decoder" },
        { repo: DefaultConfig.mangaOcrRepo, path: "vocab.txt", label: "Vocab" },
        ...gate,
      ],
    };
  }
  if (engineId === "ppocrv6-manga") {
    return {
      key: "ocr:ppocrv6-manga",
      files: [
        { repo: env.ppocrv6MangaRepo, path: "ppocr-rec-v6-small-manga.onnx", label: "PP-OCRv6 weights" },
        ...gate,
      ],
    };
  }
  if (engineId === "pororo") {
    return {
      key: "ocr:pororo",
      files: [
        { repo: env.pororoModelRepo, path: "brainocr.onnx", label: "Pororo weights" },
        { repo: env.pororoModelRepo, path: "ocr-opt.txt", label: "Vocab" },
        ...gate,
      ],
    };
  }
  return {
    key: "ocr:paddle",
    files: [
      { repo: DefaultConfig.ocrRepo, path: DefaultConfig.ocrModelPath("latin"), label: "Latin pack 1/4" },
      { repo: DefaultConfig.ocrRepo, path: DefaultConfig.ocrDictPath("latin"), label: "Latin pack 2/4" },
      { repo: DefaultConfig.ocrRepo, path: DefaultConfig.ocrModelPath("chinese"), label: "Chinese pack 3/4" },
      { repo: DefaultConfig.ocrRepo, path: DefaultConfig.ocrDictPath("chinese"), label: "Chinese pack 4/4" },
      ...gate,
    ],
  };
}

/** Canonical LaMa job — single ~207 MB file. */
export function lamaDownloadJob(): ManagedDownloadJob {
  return {
    key: "inpaint:lama",
    files: [{ repo: DefaultConfig.lamaRepo, path: DefaultConfig.lamaModelPath, label: "LaMa weights" }],
  };
}

async function send(type: string, data?: unknown): Promise<any> {
  return browser.runtime.sendMessage({ type, data });
}

/**
 * Start — or resume, when this job (or its files) already has a partial.
 * Latest click wins: starting a different job auto-pauses the active one
 * (its partial is kept and resumable).
 */
export async function startManagedDownload(job: ManagedDownloadJob): Promise<ManagedDownloadSnapshot | null> {
  const res = await send("DOWNLOAD_START", job);
  return (res?.snapshot as ManagedDownloadSnapshot) ?? null;
}

export async function pauseManagedDownload(key: string): Promise<void> {
  await send("DOWNLOAD_PAUSE", { key }).catch(() => {});
}

/** Abort + discard retained partials. Completed cache entries are kept. */
export async function discardManagedDownload(key: string): Promise<void> {
  await send("DOWNLOAD_DISCARD", { key }).catch(() => {});
}

/** Snapshot of every known job — call on UI open to sync button state. */
export async function getManagedDownloads(): Promise<Record<string, ManagedDownloadSnapshot>> {
  try {
    const res = await send("GET_ACTIVE_DOWNLOADS");
    if (res?.downloads) return res.downloads as Record<string, ManagedDownloadSnapshot>;
  } catch {
    // background unreachable — treat everything as idle
  }
  return {};
}

/**
 * Subscribe to `MODEL_DOWNLOAD_PROGRESS` broadcasts. Returns an unsubscribe
 * function — call it on component destroy.
 */
export function onManagedDownloadProgress(
  cb: (snap: ManagedDownloadSnapshot) => void,
): () => void {
  const listener = (msg: any) => {
    if (msg?.type === "MODEL_DOWNLOAD_PROGRESS" && msg?.payload?.key) {
      cb(msg.payload as ManagedDownloadSnapshot);
    }
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
