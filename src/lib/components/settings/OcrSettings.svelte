<script lang="ts">
  import { DefaultConfig } from "@/lib/configs";
  import { env } from "@/lib/env";
  import { probeArtifactsCached } from "@/lib/utils";
  import {
    ocrDownloadJob,
    getManagedDownloads,
    onManagedDownloadProgress,
    pauseManagedDownload,
    startManagedDownload,
    type ManagedDownloadSnapshot,
  } from "@/lib/download-client";
  import ModelSelect from "@/lib/components/ui/ModelSelect.svelte";
  import type { RowDownloadState } from "@/lib/components/ui/ModelSelect.svelte";
  import { Info } from "lucide-svelte";
  import { onMount, onDestroy } from "svelte";

  let {
    ocrMinConfidence = $bindable(DefaultConfig.ocrMinConfidence),
    scriptGate = $bindable(DefaultConfig.scriptGate),
    ocrEngine = $bindable(DefaultConfig.ocrEngine),
    sourceLang = DefaultConfig.sourceLang,
  }: {
    ocrMinConfidence: number;
    scriptGate: boolean;
    ocrEngine?: string;
    sourceLang?: string;
  } = $props();

  const ENGINES = [
    {
      id: "paddle",
      label: "PaddleOCR",
      size: "~90 MB",
      desc: "Fast, lightweight multilingual engine (default)",
    },
    {
      id: "ppocrv6-manga",
      label: "PP-OCRv6 Manga",
      size: "~21 MB",
      desc: "Japanese-only manga fine-tune — a little bit limited but smaller size",
    },
    {
      id: "manga-ocr",
      label: "Manga-OCR",
      size: "~460 MB",
      desc: "Flagship model for Japanese text & vertical writing",
    },
    {
      id: "pororo",
      label: "Pororo OCR",
      size: "~74 MB",
      desc: "Specialized Korean OCR (TPS-VGG-BiLSTM-CTC)",
    },
  ];

  let cached: Record<string, boolean> = $state({});
  let loadingId: string | null = $state(null);
  let progress: Record<string, number> = $state({});
  let dlById: Record<string, RowDownloadState> = $state({});
  let unsubProgress: (() => void) | null = null;

  const rowIdForKey = (key: string): string | null =>
    key.startsWith("ocr:") ? key.slice("ocr:".length) : null;

  /** Fold one manager snapshot into the single-button row state. */
  function applySnapshot(snap: ManagedDownloadSnapshot) {
    const rowId = rowIdForKey(snap.key);
    if (!rowId) return;
    if (snap.status === "downloading" || snap.status === "paused" || snap.status === "error") {
      dlById = { ...dlById, [rowId]: { status: snap.status, progress: snap.fraction } };
      loadingId = rowId;
      progress = { ...progress, [rowId]: snap.fraction };
    } else {
      const { [rowId]: _dropped, ...rest } = dlById;
      dlById = rest;
      if (loadingId === rowId) {
        loadingId = null;
        const { [rowId]: _p, ...prest } = progress;
        progress = prest;
      }
    }
    if (snap.status === "done") void probeAll();
  }

  async function refreshManaged() {
    const all = await getManagedDownloads();
    for (const snap of Object.values(all)) applySnapshot(snap);
    const live = new Set(
      Object.values(all)
        .filter((s) => s.status === "downloading" || s.status === "paused" || s.status === "error")
        .map((s) => rowIdForKey(s.key))
        .filter((v): v is string => v !== null),
    );
    dlById = Object.fromEntries(Object.entries(dlById).filter(([id]) => live.has(id)));
    if (loadingId && !live.has(loadingId)) {
      loadingId = null;
      progress = {};
    }
  }

  function ocrRepoPath(id: string): { repo: string; path: string }[] {
    // Returns one or more cache entries that must all exist for the engine to be "cached"
    if (id === "manga-ocr") return [{ repo: DefaultConfig.mangaOcrRepo, path: "encoder_model.onnx" }];
    if (id === "ppocrv6-manga") return [{ repo: env.ppocrv6MangaRepo, path: "ppocr-rec-v6-small-manga.onnx" }];
    if (id === "pororo") return [{ repo: env.pororoModelRepo, path: "brainocr.onnx" }];
    // paddle is language-dependent; check latin pack as representative (setup ships latin+chinese)
    return [{ repo: DefaultConfig.ocrRepo, path: DefaultConfig.ocrModelPath("latin") }];
  }

  async function probeAll() {
    // Routed through background: see DetectionSettings — same partition issue.
    const allParts = ENGINES.map((e) => ocrRepoPath(e.id));
    const results = await probeArtifactsCached(allParts.flat());
    const next: Record<string, boolean> = {};
    let offset = 0;
    ENGINES.forEach((e, i) => {
      const parts = allParts[i];
      const checks = results.slice(offset, offset + parts.length);
      offset += parts.length;
      next[e.id] = parts.length > 0 && checks.every(Boolean);
    });
    cached = next;
  }

  // Single-button Download ⇄ Pause / Resume, owned by the background
  // download manager — pausing here can resume in the setup wizard and
  // vice versa. The manager writes straight into the extension partition,
  // so no PREFETCH_MODEL mirror round-trip is needed. Full engine file
  // lists (same as setup) so a partial paused anywhere resumes anywhere.
  async function toggleDownload(id: string) {
    const st = dlById[id]?.status;
    const key = ocrDownloadJob(id).key;
    if (st === "downloading") {
      await pauseManagedDownload(key);
    } else {
      loadingId = id;
      progress = { ...progress, [id]: dlById[id]?.progress ?? 0 };
      await startManagedDownload(ocrDownloadJob(id));
      await probeAll();
    }
    await refreshManaged();
  }

  onMount(() => {
    probeAll();
    void refreshManaged();
    unsubProgress = onManagedDownloadProgress(applySnapshot);
  });

  onDestroy(() => {
    unsubProgress?.();
  });
  $effect(() => {
    ocrEngine;
    probeAll();
  });

  const engineOptions = $derived(ENGINES.map((e) => ({ id: e.id, label: e.label, size: e.size, desc: e.desc })));
</script>

<div class="space-y-1.5">
  <span class="kicker ml-0.5">
    Text recognition (OCR)
  </span>
  <div class="panel-card !p-2.5 space-y-3">
    <div class="flex flex-col space-y-1.5">
      <ModelSelect
        id="ocr-engine"
        label="OCR Engine"
        bind:value={ocrEngine}
        options={engineOptions}
        {cached}
        {loadingId}
        {progress}
        downloadState={dlById}
        onToggleDownload={toggleDownload}
      />
      {#if ocrEngine === "ppocrv6-manga" && sourceLang !== "Japanese"}
        <p class="text-[10px] text-amber-300 leading-snug border border-amber-500/20 bg-amber-950/20 rounded-[3px] px-2 py-1">
          PP-OCRv6 Manga is Japanese-only — results for {sourceLang} may be poor.
        </p>
      {/if}
      {#if ocrEngine === "manga-ocr" && sourceLang !== "Japanese"}
        <p class="text-[10px] text-amber-300 leading-snug border border-amber-500/20 bg-amber-950/20 rounded-[3px] px-2 py-1">
          Manga-OCR is Japanese-only — results for {sourceLang} may be poor.
        </p>
      {/if}
      {#if ocrEngine === "pororo" && sourceLang !== "Korean"}
        <p class="text-[10px] text-amber-300 leading-snug border border-amber-500/20 bg-amber-950/20 rounded-[3px] px-2 py-1">
          Pororo OCR is Korean-only — results for {sourceLang} may be poor.
        </p>
      {/if}
    </div>

    <div class="flex flex-col space-y-2.5 pt-2 border-t border-[var(--border-faint)]">
      <div class="flex justify-between items-center gap-2">
        <div>
          <span class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-dim)]">
            Language Gate
          </span>
          <p class="text-[11px] text-[var(--text-muted)] mt-0.5 leading-snug max-w-48">
            Skip boxes that aren't in the source language; marked boxes can be translated anyway.
          </p>
        </div>
        <label class="switch-cyber is-amber shrink-0">
          <input type="checkbox" bind:checked={scriptGate} />
          <span class="track"><span class="thumb"></span></span>
        </label>
      </div>

      <div class="flex justify-between items-center">
        <label for="ocr-min-confidence" class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-dim)]">
          Min Confidence
        </label>
        <span class="text-[10px] font-mono font-bold text-[var(--accent-amber)]">
          {Math.round(ocrMinConfidence * 100)}%
        </span>
      </div>
      <input
        id="ocr-min-confidence"
        type="range"
        min="0.1"
        max="1"
        step="0.05"
        bind:value={ocrMinConfidence}
        class="slider-cyber is-amber"
      />
      <p class="text-[11px] text-[var(--text-muted)] mt-1 leading-snug">
        Lower confidence reads more text but may include background noise or drawing artifacts.
      </p>

      <div class="flex gap-1.5 p-2 bg-[var(--bg-void)] border border-[var(--border-line)] rounded-lg text-[var(--text-muted)] text-[11px] leading-snug">
        <Info size={12} class="shrink-0 mt-0.5 text-[var(--accent-amber)]" />
        <p>
          <strong class="font-medium text-[var(--text-primary)]">Local &amp; API Mode only:</strong> Gemini mode runs no OCR at all — it sends the whole page image with numbered boxes drawn on it directly to Gemini.
        </p>
      </div>
    </div>
  </div>
</div>
