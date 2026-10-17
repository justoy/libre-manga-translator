<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import {
    Check,
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
  import { isArtifactCached } from "@/lib/utils";
  import {
    lamaDownloadJob,
    startManagedDownload,
    pauseManagedDownload,
    discardManagedDownload,
    getManagedDownloads,
    onManagedDownloadProgress,
    type ManagedDownloadSnapshot,
  } from "@/lib/download-client";

  let {
    selectedInpaintMethod = $bindable("fast"),
    onBack,
    onComplete,
  }: {
    selectedInpaintMethod?: "fast" | "quality";
    onBack: () => void;
    onComplete: () => void;
  } = $props();

  let lamaDownloading = $state(false);
  let lamaPaused = $state(false);
  let lamaDownloaded = $state(false);
  let lamaProgress = $state(0);
  let lamaProgressText = $state("");
  let lamaError = $state<string | null>(null);
  let prevInpaintMethod = untrack(() => selectedInpaintMethod);
  let unsubProgress: (() => void) | null = null;

  const dlKey = (): string => lamaDownloadJob().key;

  /** Fold a background-manager snapshot into this step's status UI. */
  function applyLamaSnap(snap: ManagedDownloadSnapshot) {
    if (snap.key !== dlKey()) return;
    if (snap.status === "downloading" || snap.status === "paused" || snap.status === "error") {
      lamaDownloading = snap.status === "downloading";
      lamaPaused = snap.status === "paused";
      lamaError = snap.status === "error" ? (snap.error ?? "Failed to download LaMa model weights.") : null;
      lamaProgress = Math.round(snap.fraction * 100);
      if (snap.status === "paused") {
        lamaProgressText = `Paused at ${lamaProgress}% — resume to continue.`;
      } else if (snap.status === "downloading") {
        lamaProgressText = `${(snap.loaded / 1024 / 1024).toFixed(1)} MB${snap.total > 0 ? ` / ${(snap.total / 1024 / 1024).toFixed(1)} MB` : ""}`;
      }
    } else if (snap.status === "done") {
      lamaDownloading = false;
      lamaPaused = false;
      void checkLamaStatus();
    } else {
      // idle (discarded via Stop): reset progress UI.
      lamaDownloading = false;
      lamaPaused = false;
      lamaProgress = 0;
      lamaProgressText = "Download stopped.";
    }
  }

  async function refreshDl() {
    const all = await getManagedDownloads();
    applyLamaSnap(all[dlKey()]);
  }

  async function checkLamaStatus(): Promise<boolean> {
    lamaError = null;
    if (selectedInpaintMethod !== "quality") {
      lamaDownloaded = false;
      return false;
    }
    const cached = await isArtifactCached(
      DefaultConfig.lamaRepo,
      DefaultConfig.lamaModelPath,
    );
    lamaDownloaded = cached;
    return cached;
  }

  // Opt-in downloads owned by the background manager (same contract as the
  // other wizard steps) — pausing here can resume in popup/sidebar and
  // vice versa. The cache probe stays the source of truth for completion.
  async function startLamaDownload() {
    if (selectedInpaintMethod !== "quality") return;
    if (lamaDownloading) return;
    lamaDownloading = true;
    lamaPaused = false;
    lamaError = null;
    lamaProgressText = "Connecting...";
    try {
      await startManagedDownload(lamaDownloadJob());
      await checkLamaStatus();
    } catch (err: any) {
      lamaError = err?.message ?? "Failed to download LaMa model weights.";
      lamaDownloading = false;
    }
    await refreshDl();
  }

  async function pauseLamaDownload() {
    if (!lamaDownloading || lamaPaused) return;
    await pauseManagedDownload(dlKey());
    await refreshDl();
  }

  async function stopLamaDownload() {
    await discardManagedDownload(dlKey());
    lamaPaused = false;
    lamaDownloading = false;
    lamaProgress = 0;
    lamaProgressText = "Download stopped.";
    lamaError = null;
  }

  // Opt-in downloads: check cache on entry / method switch, never auto-fetch.
  onMount(() => {
    checkLamaStatus();
    void refreshDl();
    unsubProgress = onManagedDownloadProgress(applyLamaSnap);
  });

  onDestroy(() => {
    unsubProgress?.();
  });

  $effect(() => {
    if (selectedInpaintMethod && selectedInpaintMethod !== prevInpaintMethod) {
      prevInpaintMethod = selectedInpaintMethod;
      lamaDownloaded = false;
      lamaPaused = false;
      lamaDownloading = false;
      lamaProgress = 0;
      lamaProgressText = "";
      lamaError = null;
      checkLamaStatus();
      void refreshDl();
    }
  });
</script>

<div class="space-y-4">
  <div>
    <h2 class="text-base font-display font-bold text-[var(--text-primary)]">
      Inpainting &amp; Redraw
    </h2>
    <p class="text-xs text-[var(--text-muted)] mt-0.5">
      Configure how original text is cleared before rendering translated text.
    </p>
  </div>

  <!-- 2 Balanced Inpainting Options -->
  <div class="space-y-2.5">
    <button
      type="button"
      onclick={() => (selectedInpaintMethod = "fast")}
      disabled={lamaDownloading || lamaPaused}
      class="w-full p-3.5 rounded-xl border text-left cursor-pointer transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-start justify-between gap-3 bg-[var(--bg-void)]
        {selectedInpaintMethod === 'fast'
        ? 'border-[var(--accent-cyan)] shadow-[0_0_14px_var(--accent-cyan-glow)]'
        : 'border-[var(--border-line)] hover:border-[var(--border-line)]/80'}"
    >
      <div class="min-w-0">
        <div class="flex items-center gap-2 mb-1">
          <span
            class="text-xs font-display font-bold {selectedInpaintMethod === 'fast'
              ? 'text-[var(--accent-cyan)]'
              : 'text-[var(--text-primary)]'}"
          >
            Fast (Recommended)
          </span>
          <span class="badge-cyber is-cyan text-[9px] !py-0.5 !px-1.5">
            0 MB Extra
          </span>
        </div>
        <p
          class="text-[11px] leading-snug {selectedInpaintMethod === 'fast'
            ? 'text-[var(--text-primary)]'
            : 'text-[var(--text-muted)]'}"
        >
          Model-free ladder: planar fill, bilateral denoise, and Telea. Instant, zero extra memory, perfectly cleans flat and screentone paper.
        </p>
      </div>
      <div
        class="w-4 h-4 rounded-full border border-[var(--border-line)] flex items-center justify-center shrink-0 {selectedInpaintMethod ===
        'fast'
          ? 'border-[var(--accent-cyan)]'
          : ''}"
      >
        {#if selectedInpaintMethod === "fast"}
          <div
            class="w-2 h-2 rounded-full bg-[var(--accent-cyan)] shadow-[0_0_6px_var(--accent-cyan-glow)]"
          ></div>
        {/if}
      </div>
    </button>

    <button
      type="button"
      onclick={() => (selectedInpaintMethod = "quality")}
      disabled={lamaDownloading || lamaPaused}
      class="w-full p-3.5 rounded-xl border text-left cursor-pointer transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-start justify-between gap-3 bg-[var(--bg-void)]
        {selectedInpaintMethod === 'quality'
        ? 'border-[var(--accent-cyan)] shadow-[0_0_14px_var(--accent-cyan-glow)]'
        : 'border-[var(--border-line)] hover:border-[var(--border-line)]/80'}"
    >
      <div class="min-w-0">
        <div class="flex items-center gap-2 mb-1">
          <span
            class="text-xs font-display font-bold {selectedInpaintMethod === 'quality'
              ? 'text-[var(--accent-cyan)]'
              : 'text-[var(--text-primary)]'}"
          >
            Quality (LaMa Redraw)
          </span>
          <span class="badge-cyber text-[9px] !py-0.5 !px-1.5">
            ~207 MB
          </span>
        </div>
        <p
          class="text-[11px] leading-snug {selectedInpaintMethod === 'quality'
            ? 'text-[var(--text-primary)]'
            : 'text-[var(--text-muted)]'}"
        >
          Finetuned neural inpainter that reconstructs halftone and complex art textures behind speech bubbles.
        </p>
      </div>
      <div
        class="w-4 h-4 rounded-full border border-[var(--border-line)] flex items-center justify-center shrink-0 {selectedInpaintMethod ===
        'quality'
          ? 'border-[var(--accent-cyan)]'
          : ''}"
      >
        {#if selectedInpaintMethod === "quality"}
          <div
            class="w-2 h-2 rounded-full bg-[var(--accent-cyan)] shadow-[0_0_6px_var(--accent-cyan-glow)]"
          ></div>
        {/if}
      </div>
    </button>
  </div>

  <!-- Download Card / Status -->
  {#if selectedInpaintMethod === "quality"}
    <div
      class="flex flex-col gap-2 p-3.5 rounded-xl border transition-colors bg-[var(--bg-void)]
        {lamaDownloaded
        ? 'border-[var(--accent-emerald)]/40'
        : lamaError
          ? 'border-[var(--accent-rose)]/40'
          : lamaDownloading
            ? 'border-[var(--accent-cyan)]/40'
            : 'border-[var(--border-line)]'}"
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          {#if lamaPaused}
            <Pause size={15} class="text-[var(--accent-amber)] shrink-0" />
            <span class="text-xs font-medium text-[var(--accent-amber)] truncate">
              {lamaProgressText || `Paused at ${lamaProgress}%`}
            </span>
          {:else if lamaDownloading}
            <LoaderCircle size={15} class="animate-spin text-[var(--accent-cyan)] shrink-0" />
            <span class="text-xs font-medium text-[var(--accent-cyan)] truncate">
              Downloading LaMa weights (~207 MB)...
            </span>
          {:else if lamaDownloaded}
            <CircleCheck size={15} class="text-[var(--accent-emerald)] shrink-0" />
            <span class="text-xs font-medium text-[var(--text-primary)] truncate">
              LaMa weights cached and ready.
            </span>
          {:else if lamaError}
            <CircleAlert size={15} class="text-[var(--accent-rose)] shrink-0" />
            <span class="text-xs text-[var(--accent-rose)] truncate">
              {lamaError}
            </span>
          {:else}
            <Download size={15} class="text-[var(--text-dim)] shrink-0" />
            <span class="text-xs text-[var(--text-muted)] truncate">
              LaMa weights (~207 MB) not yet downloaded — you choose when to download.
            </span>
          {/if}
        </div>

        <div class="flex items-center gap-1.5 shrink-0">
          {#if lamaDownloading && !lamaPaused}
            <button
              type="button"
              onclick={pauseLamaDownload}
              title="Pause download (keeps progress)"
              class="btn-ghost !py-1 !px-2.5 text-xs shrink-0 cursor-pointer flex items-center gap-1"
            >
              <Pause size={13} />
              Pause
            </button>
            <button
              type="button"
              onclick={stopLamaDownload}
              title="Stop download (discards progress)"
              class="btn-ghost !py-1 !px-2.5 text-xs shrink-0 cursor-pointer flex items-center gap-1"
            >
              <Square size={13} />
              Stop
            </button>
          {:else if lamaPaused}
            <button
              type="button"
              onclick={startLamaDownload}
              title="Resume download from where it paused"
              class="btn-primary !py-1 !px-2.5 text-xs font-bold shrink-0 cursor-pointer flex items-center gap-1"
            >
              <Play size={13} />
              Resume
            </button>
            <button
              type="button"
              onclick={stopLamaDownload}
              title="Stop download (discards progress)"
              class="btn-ghost !py-1 !px-2.5 text-xs shrink-0 cursor-pointer flex items-center gap-1"
            >
              <Square size={13} />
              Stop
            </button>
          {:else if !lamaDownloaded && !lamaError}
            <button
              type="button"
              onclick={startLamaDownload}
              class="btn-primary !py-1 !px-2.5 text-xs font-bold shrink-0 cursor-pointer flex items-center gap-1"
            >
              <Download size={13} />
              Download Now
            </button>
          {:else if lamaError}
            <button
              type="button"
              onclick={startLamaDownload}
              class="btn-ghost !py-1 !px-2.5 text-xs shrink-0 cursor-pointer flex items-center gap-1"
            >
              <Play size={13} />
              Retry
            </button>
          {/if}
        </div>
      </div>

      {#if lamaDownloading || lamaPaused}
        <div class="space-y-1">
          <div
            class="h-1.5 bg-[var(--surface-panel)] rounded-full overflow-hidden border border-[var(--border-faint)]"
          >
            <div
              class="h-full bg-[var(--accent-cyan)] shadow-[0_0_8px_var(--accent-cyan-glow)] rounded-full transition-all duration-300"
              style="width: {lamaProgress}%"
            ></div>
          </div>
          <div class="flex justify-between text-[10px] text-[var(--text-dim)] font-mono">
            <span>{lamaProgressText}</span>
            <span>{lamaProgress}%</span>
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div
      class="flex items-center gap-2 p-3 bg-[var(--bg-void)] border border-[var(--border-faint)] rounded-xl text-xs text-[var(--text-muted)]"
    >
      <Check size={14} class="text-[var(--accent-emerald)] shrink-0" />
      <span>Built-in mathematical ladder active. Zero extra downloads required.</span>
    </div>
  {/if}

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
      onclick={onComplete}
      disabled={selectedInpaintMethod === "quality" && (!lamaDownloaded || lamaDownloading || lamaPaused)}
      class="btn-primary flex-1 text-xs !py-2.5 font-bold cursor-pointer disabled:bg-none disabled:bg-[var(--surface-panel-alt)] disabled:border-[var(--border-line)] disabled:text-[var(--text-dim)] disabled:opacity-60 disabled:shadow-none disabled:cursor-not-allowed"
    >
      {#if lamaDownloading}
        <LoaderCircle size={14} class="animate-spin" />
        Downloading...
      {:else if lamaPaused}
        <Pause size={14} />
        Paused
      {:else}
        Complete Setup
        <ChevronRight size={14} />
      {/if}
    </button>
  </div>
</div>
