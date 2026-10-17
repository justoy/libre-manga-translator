<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import {
    Cpu,
    LoaderCircle,
    CircleCheck,
    CircleAlert,
    Download,
    ChevronRight,
    Play,
    Pause,
    Square,
  } from "lucide-svelte";
  import { DefaultConfig } from "@/lib/configs";
  import { UNKNOWN_DETECTION_MODEL_MESSAGE } from "@/lib/detections/main";
  import { isArtifactCached } from "@/lib/utils";
  import {
    detectionDownloadJob,
    startManagedDownload,
    pauseManagedDownload,
    discardManagedDownload,
    getManagedDownloads,
    onManagedDownloadProgress,
    type ManagedDownloadSnapshot,
  } from "@/lib/download-client";

  let {
    detectionModel = $bindable(DefaultConfig.detectionModels[0].id),
    onBack,
    onNext,
  }: {
    detectionModel?: string;
    onBack: () => void;
    onNext: () => void;
  } = $props();

  let prevDetectionModel = untrack(() => detectionModel);
  let detectionPrefetching = $state(false);
  let detectionPrefetched = $state(false);
  let detectionPaused = $state(false);
  let detectionProgress = $state(0);
  let detectionProgressText = $state("");
  let detectionError = $state<string | null>(null);
  let unsubProgress: (() => void) | null = null;

  const dlKey = (): string => detectionDownloadJob(detectionModel).key;

  /** Fold a background-manager snapshot into this step's status UI. */
  function applyDlSnap(snap: ManagedDownloadSnapshot) {
    if (snap.key !== dlKey()) return;
    if (snap.status === "downloading" || snap.status === "paused" || snap.status === "error") {
      detectionPrefetching = snap.status === "downloading";
      detectionPaused = snap.status === "paused";
      detectionError = snap.status === "error" ? (snap.error ?? "Download failed.") : null;
      detectionProgress = Math.round(snap.fraction * 100);
      if (snap.status === "paused") {
        detectionProgressText = `Paused at ${detectionProgress}% — resume to continue.`;
      } else if (snap.status === "downloading") {
        detectionProgressText = snap.fileLabel
          ? `${snap.fileLabel}: ${(snap.loaded / 1024 / 1024).toFixed(1)} MB${snap.total > 0 ? ` / ${(snap.total / 1024 / 1024).toFixed(1)} MB` : ""}`
          : `${detectionProgress}%`;
      }
    } else if (snap.status === "done") {
      detectionPrefetching = false;
      detectionPaused = false;
      void checkDetectionCache();
    } else {
      // idle (discarded via Stop): reset progress UI.
      detectionPrefetching = false;
      detectionPaused = false;
      detectionProgress = 0;
      detectionProgressText = "Download stopped.";
    }
  }

  async function refreshDl() {
    const all = await getManagedDownloads();
    applyDlSnap(all[dlKey()]);
  }

  async function checkDetectionCache(): Promise<boolean> {
    detectionError = null;
    let cached = false;
    if (detectionModel === "comic-bubble") {
      cached = await isArtifactCached(
        DefaultConfig.rtdetrModelRepo,
        "detector-v4-s_int8.onnx",
      );
    } else if (detectionModel === "comic-text-detector") {
      cached = await isArtifactCached(
        "direct-model-cache",
        DefaultConfig.comicTextDetectorUrl,
      );
    } else {
      throw new Error(UNKNOWN_DETECTION_MODEL_MESSAGE(detectionModel));
    }
    detectionPrefetched = cached;
    return cached;
  }

  // Opt-in downloads owned by the background manager: starting here can
  // resume a partial paused in popup/sidebar and vice versa. Progress
  // arrives via broadcast; the cache probe below stays the source of truth
  // for the Continue gate.
  async function prefetchDetection() {
    if (detectionPrefetching) return;
    detectionPrefetching = true;
    detectionPaused = false;
    detectionError = null;
    detectionProgressText = "Connecting...";
    try {
      await startManagedDownload(detectionDownloadJob(detectionModel));
      await checkDetectionCache();
    } catch (err: any) {
      detectionError =
        err?.message ?? "Could not cache the model. Please check connection and retry.";
      detectionPrefetching = false;
    }
    await refreshDl();
  }

  async function pauseDetection() {
    if (!detectionPrefetching || detectionPaused) return;
    await pauseManagedDownload(dlKey());
    await refreshDl();
  }

  async function stopDetection() {
    await discardManagedDownload(dlKey());
    detectionPaused = false;
    detectionPrefetching = false;
    detectionProgress = 0;
    detectionProgressText = "Download stopped.";
    detectionError = null;
  }

  // Opt-in downloads: check cache on entry / model switch, never auto-fetch.
  onMount(() => {
    checkDetectionCache();
    void refreshDl();
    unsubProgress = onManagedDownloadProgress(applyDlSnap);
  });

  onDestroy(() => {
    unsubProgress?.();
  });

  $effect(() => {
    if (detectionModel) {
      if (prevDetectionModel !== detectionModel) {
        detectionPrefetched = false;
        detectionPaused = false;
        detectionPrefetching = false;
        detectionProgress = 0;
        detectionProgressText = "";
        detectionError = null;
        prevDetectionModel = detectionModel;
        checkDetectionCache();
        void refreshDl();
      }
    }
  });
</script>

<div class="space-y-4">
  <div>
    <h2 class="text-base font-display font-bold text-[var(--text-primary)]">
      Bubble Detection Model
    </h2>
    <p class="text-xs text-[var(--text-muted)] mt-0.5">
      Choose the detection model used to locate text bubbles on pages.
    </p>
  </div>

  <!-- Detection model grid -->
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
    {#each DefaultConfig.detectionModels as model}
      <button
        type="button"
        onclick={() => (detectionModel = model.id)}
        disabled={detectionPrefetching || detectionPaused}
        class="p-3.5 rounded-xl border text-left cursor-pointer transition-all disabled:opacity-60 disabled:cursor-not-allowed bg-[var(--bg-void)]
          {detectionModel === model.id
          ? 'border-[var(--accent-cyan)] shadow-[0_0_14px_var(--accent-cyan-glow)]'
          : 'border-[var(--border-line)] hover:border-[var(--border-line)]/80'}"
      >
        <div class="flex items-start justify-between gap-2 mb-1.5 min-w-0">
          <div class="flex items-start gap-1.5 min-w-0 flex-1">
            <Cpu
              size={14}
              class="shrink-0 mt-0.5 {detectionModel === model.id
                ? 'text-[var(--accent-cyan)]'
                : 'text-[var(--text-dim)]'}"
            />
            <span
              class="text-xs font-display font-bold leading-snug {detectionModel === model.id
                ? 'text-[var(--accent-cyan)]'
                : 'text-[var(--text-primary)]'}"
            >
              {model.label}
            </span>
          </div>
          <span
            class="badge-cyber text-[10px] font-mono shrink-0 whitespace-nowrap !py-0.5 !px-1.5 {detectionModel === model.id
              ? 'is-cyan'
              : ''}"
          >
            {model.size}
          </span>
        </div>
        <p
          class="text-[11px] leading-snug {detectionModel === model.id
            ? 'text-[var(--text-primary)]'
            : 'text-[var(--text-muted)]'}"
        >
          {model.desc}
        </p>
      </button>
    {/each}
  </div>

  <!-- Prefetch Status Panel -->
  <div
    class="flex flex-col gap-2 p-3.5 rounded-xl border transition-colors bg-[var(--bg-void)]
      {detectionPrefetched
      ? 'border-[var(--accent-emerald)]/40'
      : detectionError
        ? 'border-[var(--accent-rose)]/40'
        : detectionPrefetching
          ? 'border-[var(--accent-cyan)]/40'
          : 'border-[var(--border-line)]'}"
  >
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        {#if detectionPaused}
          <Pause size={15} class="text-[var(--accent-amber)] shrink-0" />
          <span class="text-xs font-medium text-[var(--accent-amber)] truncate">
            {detectionProgressText || `Paused at ${detectionProgress}%`}
          </span>
        {:else if detectionPrefetching}
          <LoaderCircle size={15} class="animate-spin text-[var(--accent-cyan)] shrink-0" />
          <span class="text-xs font-medium text-[var(--accent-cyan)] truncate">
            Downloading detector weights...
          </span>
        {:else if detectionPrefetched}
          <CircleCheck size={15} class="text-[var(--accent-emerald)] shrink-0" />
          <span class="text-xs font-medium text-[var(--text-primary)] truncate">
            Model cached and ready for inference.
          </span>
        {:else if detectionError}
          <CircleAlert size={15} class="text-[var(--accent-rose)] shrink-0" />
          <span class="text-xs text-[var(--accent-rose)] truncate">
            {detectionError}
          </span>
        {:else}
          <Download size={15} class="text-[var(--text-dim)] shrink-0" />
          <span class="text-xs text-[var(--text-muted)] truncate">
            Weights not yet downloaded — you choose when to download.
          </span>
        {/if}
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        {#if detectionPrefetching && !detectionPaused}
          <button
            type="button"
            onclick={pauseDetection}
            title="Pause download (keeps progress)"
            class="btn-ghost !py-1 !px-2.5 text-xs shrink-0 cursor-pointer flex items-center gap-1"
          >
            <Pause size={13} />
            Pause
          </button>
          <button
            type="button"
            onclick={stopDetection}
            title="Stop download (discards progress)"
            class="btn-ghost !py-1 !px-2.5 text-xs shrink-0 cursor-pointer flex items-center gap-1"
          >
            <Square size={13} />
            Stop
          </button>
        {:else if detectionPaused}
          <button
            type="button"
            onclick={prefetchDetection}
            title="Resume download from where it paused"
            class="btn-primary !py-1 !px-2.5 text-xs font-bold shrink-0 cursor-pointer flex items-center gap-1"
          >
            <Play size={13} />
            Resume
          </button>
          <button
            type="button"
            onclick={stopDetection}
            title="Stop download (discards progress)"
            class="btn-ghost !py-1 !px-2.5 text-xs shrink-0 cursor-pointer flex items-center gap-1"
          >
            <Square size={13} />
            Stop
          </button>
        {:else if !detectionPrefetched && !detectionError}
          <button
            type="button"
            onclick={prefetchDetection}
            class="btn-primary !py-1 !px-2.5 text-xs font-bold shrink-0 cursor-pointer flex items-center gap-1"
          >
            <Download size={13} />
            Download &amp; Cache
          </button>
        {:else if detectionError}
          <button
            type="button"
            onclick={prefetchDetection}
            class="btn-ghost !py-1 !px-2.5 text-xs shrink-0 cursor-pointer flex items-center gap-1"
          >
            <Play size={13} />
            Retry
          </button>
        {/if}
      </div>
    </div>

    {#if detectionPrefetching || detectionPaused}
      <div class="space-y-1">
        <div
          class="h-1.5 bg-[var(--surface-panel)] rounded-full overflow-hidden border border-[var(--border-faint)]"
        >
          <div
            class="h-full bg-[var(--accent-cyan)] shadow-[0_0_8px_var(--accent-cyan-glow)] rounded-full transition-all duration-300"
            style="width: {detectionProgress}%"
          ></div>
        </div>
        <div class="flex justify-between text-[10px] text-[var(--text-dim)] font-mono">
          <span>{detectionProgressText}</span>
          <span>{detectionProgress}%</span>
        </div>
      </div>
    {/if}
  </div>

  <!-- Navigation -->
  <div class="flex items-center gap-2.5 pt-2 border-t border-[var(--border-faint)]">
    <button
      type="button"
      onclick={onBack}
      class="btn-ghost flex-1 text-xs !py-2.5 cursor-pointer"
    >
      Back
    </button>
    <button
      type="button"
      onclick={onNext}
      disabled={!detectionPrefetched || detectionPrefetching || detectionPaused}
      class="btn-primary flex-1 text-xs !py-2.5 font-bold cursor-pointer disabled:bg-none disabled:bg-[var(--surface-panel-alt)] disabled:border-[var(--border-line)] disabled:text-[var(--text-dim)] disabled:opacity-60 disabled:shadow-none disabled:cursor-not-allowed"
    >
      {#if detectionPrefetching}
        <LoaderCircle size={14} class="animate-spin" />
        Downloading...
      {:else if detectionPaused}
        <Pause size={14} />
        Paused
      {:else}
        Continue
        <ChevronRight size={14} />
      {/if}
    </button>
  </div>
</div>
