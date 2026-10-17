<script lang="ts">
  import { DefaultConfig, normalizeDetectionModel } from "@/lib/configs";
  import { UNKNOWN_DETECTION_MODEL_MESSAGE } from "@/lib/detections/main";
  import { probeArtifactsCached } from "@/lib/utils";
  import {
    detectionDownloadJob,
    getManagedDownloads,
    onManagedDownloadProgress,
    pauseManagedDownload,
    startManagedDownload,
    type ManagedDownloadSnapshot,
  } from "@/lib/download-client";
  import ModelSelect from "@/lib/components/ui/ModelSelect.svelte";
  import type { RowDownloadState } from "@/lib/components/ui/ModelSelect.svelte";
  import { onMount, onDestroy } from "svelte";

  let {
    detectionModel = $bindable(DefaultConfig.detectionModels[0].id),
    detectionMinConfidence = $bindable(0.5),
    skipBboxRefining = $bindable(false),
    isFetchingDetection = false,
  }: {
    detectionModel: string;
    detectionMinConfidence: number;
    skipBboxRefining?: boolean;
    isFetchingDetection?: boolean;
  } = $props();

  let cached: Record<string, boolean> = $state({});
  let loadingId: string | null = $state(null);
  let progress: Record<string, number> = $state({});
  let dlById: Record<string, RowDownloadState> = $state({});
  let unsubProgress: (() => void) | null = null;

  const rowIdForKey = (key: string): string | null =>
    key.startsWith("detection:") ? key.slice("detection:".length) : null;

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
    // Drop rows whose jobs vanished (discarded / never started here).
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

  function detectionRepoPath(id: string): { repo: string; path: string } {
    const detId = normalizeDetectionModel(id);
    if (detId === "comic-bubble") return { repo: DefaultConfig.rtdetrModelRepo, path: "detector-v4-s_int8.onnx" };
    if (detId === "comic-text-detector") return { repo: "direct-model-cache", path: DefaultConfig.comicTextDetectorUrl };
    throw new Error(UNKNOWN_DETECTION_MODEL_MESSAGE(detId));
  }

  async function probeAll() {
    // Routed through background: sidebar runs in page content context whose
    // CacheStorage partition is invisible to the extension partition.
    const paths = DefaultConfig.detectionModels.map((m) => detectionRepoPath(m.id));
    const results = await probeArtifactsCached(paths);
    const next: Record<string, boolean> = {};
    DefaultConfig.detectionModels.forEach((m, i) => {
      next[m.id] = results[i] ?? false;
    });
    cached = next;
  }

  // Single-button Download ⇄ Pause / Resume, owned by the background
  // download manager — pausing here can resume in the setup wizard and
  // vice versa. The manager writes straight into the extension partition,
  // so no PREFETCH_MODEL mirror round-trip is needed.
  async function toggleDownload(id: string) {
    const st = dlById[id]?.status;
    const key = detectionDownloadJob(id).key;
    if (st === "downloading") {
      await pauseManagedDownload(key);
    } else {
      loadingId = id;
      progress = { ...progress, [id]: dlById[id]?.progress ?? 0 };
      await startManagedDownload(detectionDownloadJob(id));
      await probeAll();
    }
    await refreshManaged();
  }

  // Keep legacy isFetchingDetection in sync with internal loading
  $effect(() => {
    isFetchingDetection = loadingId !== null;
  });

  onMount(() => {
    probeAll();
    void refreshManaged();
    unsubProgress = onManagedDownloadProgress(applySnapshot);
  });

  onDestroy(() => {
    unsubProgress?.();
  });

  // Re-probe when detectionModel changes externally
  $effect(() => {
    detectionModel;
    probeAll();
  });

  const modelOptions = $derived(
    DefaultConfig.detectionModels.map((m) => ({ id: m.id, label: m.label, size: m.size, desc: m.desc })),
  );

</script>

<div class="space-y-1.5">
  <span class="kicker ml-0.5">
    Detection model
  </span>
  <div class="panel-card !p-2.5 space-y-3">
    <div class="flex flex-col space-y-1.5">
      <ModelSelect
        id="detection-model"
        label="Model Selection"
        bind:value={detectionModel}
        options={modelOptions}
        {cached}
        {loadingId}
        {progress}
        downloadState={dlById}
        onToggleDownload={toggleDownload}
      />
    </div>

    <div class="flex flex-col space-y-1.5 pt-2 border-t border-[var(--border-faint)]">
      <div class="flex justify-between items-center">
        <label for="detection-min-confidence" class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-dim)]">
          Min Confidence
        </label>
        <span class="text-[10px] font-mono font-bold text-[var(--accent-amber)]">
          {Math.round(detectionMinConfidence * 100)}%
        </span>
      </div>
      <input
        id="detection-min-confidence"
        type="range"
        min="0.1"
        max="1"
        step="0.05"
        bind:value={detectionMinConfidence}
        class="slider-cyber is-amber"
      />
    </div>

    <div class="flex items-center justify-between pt-2 border-t border-[var(--border-faint)]">
      <div class="flex flex-col">
        <span class="text-[13px] font-medium text-[var(--text-primary)]">
          Skip bbox editor
        </span>
        <span class="text-[11px] text-[var(--text-muted)]">
          Translate directly after detection (edit boxes later if needed)
        </span>
      </div>
      <label class="switch-cyber is-amber">
        <input type="checkbox" bind:checked={skipBboxRefining} />
        <span class="track"><span class="thumb"></span></span>
      </label>
    </div>
  </div>
</div>
