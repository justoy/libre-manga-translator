<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { DefaultConfig } from "@/lib/configs";
  import { normalizeInpaintMethod } from "@/lib/inpaint/ladder";
  import { probeArtifactsCached } from "@/lib/utils";
  import {
    lamaDownloadJob,
    getManagedDownloads,
    onManagedDownloadProgress,
    pauseManagedDownload,
    startManagedDownload,
    type ManagedDownloadSnapshot,
  } from "@/lib/download-client";
  import { Info, Download, LoaderCircle, CircleCheck, CircleAlert, Play, Pause } from "lucide-svelte";

  let {
    inpaintMethod = $bindable(DefaultConfig.inpaintMethod),
    alwaysInpaint = $bindable(DefaultConfig.alwaysInpaint),
  }: {
    inpaintMethod: string;
    alwaysInpaint?: boolean;
  } = $props();

  let lamaCached = $state(false);
  let lamaDownloading = $state(false);
  let lamaPaused = $state(false);
  let lamaProgress = $state(0);
  let lamaProgressText = $state("");
  let lamaError = $state<string | null>(null);
  let unsubProgress: (() => void) | null = null;
  let unwatchMethod: (() => void) | null = null;

  const LAMA_KEY = "inpaint:lama";

  function applyLamaSnap(snap: ManagedDownloadSnapshot | undefined) {
    if (!snap || snap.key !== LAMA_KEY) return;
    if (snap.status === "downloading" || snap.status === "paused" || snap.status === "error") {
      lamaDownloading = snap.status === "downloading";
      lamaPaused = snap.status === "paused";
      lamaError = snap.status === "error" ? (snap.error ?? "Failed to download LaMa model weights.") : null;
      lamaProgress = Math.round(snap.fraction * 100);
      if (snap.status === "paused") {
        lamaProgressText = `Paused at ${lamaProgress}% — resume to continue.`;
      } else if (snap.status === "downloading") {
        lamaProgressText = snap.fileLabel
          ? `${snap.fileLabel}: ${(snap.loaded / 1024 / 1024).toFixed(1)} MB${snap.total > 0 ? ` / ${(snap.total / 1024 / 1024).toFixed(1)} MB` : ""}`
          : `${lamaProgress}%`;
      }
    } else {
      lamaDownloading = false;
      lamaPaused = false;
      if (snap.status === "done") void probeLama();
    }
  }

  async function refreshLamaDl() {
    const all = await getManagedDownloads();
    applyLamaSnap(all[LAMA_KEY]);
  }

  async function probeLama() {
    try {
      // Routed through background: Sidebar runs in page content context whose
      // CacheStorage partition is invisible to the extension partition where
      // the wizard/popup/offscreen download. Direct isArtifactCached() here
      // would always read false after a wizard download.
      const [cached] = await probeArtifactsCached([
        { repo: DefaultConfig.lamaRepo, path: DefaultConfig.lamaModelPath },
      ]);
      lamaCached = cached ?? false;
    } catch {
      lamaCached = false;
    }
  }

  onMount(() => {
    probeLama();
    void refreshLamaDl();
    unsubProgress = onManagedDownloadProgress(applyLamaSnap);
    // The pipeline auto-switches a weightless Quality back to Fast at
    // translate time (offscreen guard) — reflect that here while open.
    try {
      unwatchMethod = storage.watch("sync:inpaint-method", (v) => {
        if (typeof v === "string") inpaintMethod = normalizeInpaintMethod(v);
      });
    } catch {}
  });

  onDestroy(() => {
    unsubProgress?.();
    try {
      unwatchMethod?.();
    } catch {}
  });

  // Re-probe when Quality becomes active (e.g. model downloaded in wizard
  // while the sidebar was already mounted showing Fast).
  $effect(() => {
    if (inpaintMethod === "quality") {
      void probeLama();
    }
  });

  async function startLamaDownload() {
    if (lamaDownloading) return;
    lamaError = null;
    await startManagedDownload(lamaDownloadJob());
    await probeLama();
    await refreshLamaDl();
  }

  // Single-button Download ⇄ Pause / Resume, owned by the background
  // download manager — no Stop in this compact UI.
  async function toggleLamaDownload() {
    if (lamaDownloading && !lamaPaused) {
      await pauseManagedDownload(LAMA_KEY);
    } else {
      await startLamaDownload();
    }
    await refreshLamaDl();
  }

  // Manual opt-in only: selecting Quality never auto-downloads (consistent
  // with the setup wizard). The pipeline guard falls back to Fast when the
  // weights are missing at translate time.
  function handleSelectQuality() {
    inpaintMethod = "quality";
    void probeLama();
  }

  const OPTIONS = [
    {
      id: "fast",
      label: "Fast",
      desc: "Model-Free Ladder (Telea)",
    },
    {
      id: "quality",
      label: "Quality",
      desc: "LaMa Neural Redraw (~197 MB, test: dynamic)",
    },
  ];
</script>

<div class="space-y-1.5">
  <span class="kicker ml-0.5">
    Inpainting
  </span>
  <div class="panel-card !p-2.5 space-y-2.5">
    <div class="grid grid-cols-2 gap-2">
      {#each OPTIONS as opt}
        {@const isSelected = inpaintMethod === opt.id}
        <button
          type="button"
          onclick={() => {
            if (opt.id === "quality") {
              handleSelectQuality();
            } else {
              inpaintMethod = opt.id;
            }
          }}
          class="p-2 rounded-lg border text-left transition-all cursor-pointer flex flex-col justify-between
          {isSelected
            ? (opt.id === 'quality'
                ? 'border-[var(--accent-emerald)] bg-[var(--surface-panel-alt)] text-[var(--accent-emerald)] font-medium shadow-[0_0_8px_var(--accent-emerald-glow)]'
                : 'border-[var(--accent-cyan)] bg-[var(--surface-panel-alt)] text-[var(--accent-cyan)] font-medium shadow-[0_0_8px_var(--accent-cyan-glow)]')
            : 'border-[var(--border-line)] bg-[var(--bg-void)] text-[var(--text-primary)] hover:border-[var(--border-line)]/80'}"
        >
          <div>
            <div class="flex items-center justify-between gap-1 mb-0.5">
              <span class="block font-semibold text-xs {isSelected ? (opt.id === 'quality' ? 'text-[var(--accent-emerald)]' : 'text-[var(--accent-cyan)]') : 'text-[var(--text-primary)]'}">
                {opt.label}
              </span>
              {#if opt.id === "quality"}
                {#if lamaCached}
                  <span class="badge-cyber is-emerald">
                    Cached
                  </span>
                {:else if lamaDownloading}
                  <span class="badge-cyber is-cyan">
                    {lamaProgress}%
                  </span>
                {:else}
                  <span class="badge-cyber is-amber">
                    ~197 MB
                  </span>
                {/if}
              {:else}
                <span class="badge-cyber is-cyan">
                  0 MB
                </span>
              {/if}
            </div>
            <span class="block text-[11px] leading-tight {isSelected ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}">
              {opt.desc}
            </span>
          </div>
        </button>
      {/each}
    </div>

    <!-- Download & Cache Status for LaMa / Quality -->
    {#if inpaintMethod === "quality"}
      <div
        class="flex flex-col gap-2 p-2.5 rounded-lg border transition-colors bg-[var(--bg-void)]
          {lamaCached
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
              <Pause size={14} class="text-[var(--accent-amber)] shrink-0" />
              <span class="text-xs font-medium text-[var(--accent-amber)] truncate">
                {lamaProgressText || `Paused at ${lamaProgress}%`}
              </span>
            {:else if lamaDownloading}
              <LoaderCircle size={14} class="animate-spin text-[var(--accent-cyan)] shrink-0" />
              <span class="text-xs font-medium text-[var(--accent-cyan)] truncate">
                Downloading LaMa weights (~197 MB)...
              </span>
            {:else if lamaCached}
              <CircleCheck size={14} class="text-[var(--accent-emerald)] shrink-0" />
              <span class="text-xs font-medium text-[var(--text-primary)] truncate">
                LaMa weights cached and ready.
              </span>
            {:else if lamaError}
              <CircleAlert size={14} class="text-[var(--accent-rose)] shrink-0" />
              <span class="text-xs text-[var(--accent-rose)] truncate">
                {lamaError}
              </span>
            {:else}
              <Download size={14} class="text-[var(--text-dim)] shrink-0" />
              <span class="text-xs text-[var(--text-muted)] truncate">
                LaMa weights (~197 MB) not yet downloaded.
              </span>
            {/if}
          </div>

          {#if lamaDownloading && !lamaPaused}
            <button
              type="button"
              onclick={toggleLamaDownload}
              title="Pause download (keeps progress)"
              class="btn-ghost !py-1 !px-2.5 text-xs shrink-0 cursor-pointer flex items-center gap-1"
            >
              <Pause size={13} />
              Pause
            </button>
          {:else if lamaPaused}
            <button
              type="button"
              onclick={toggleLamaDownload}
              title="Resume download from where it paused"
              class="btn-primary !py-1 !px-2.5 text-xs font-bold shrink-0 cursor-pointer flex items-center gap-1"
            >
              <Play size={13} />
              Resume
            </button>
          {:else if !lamaCached && !lamaError}
            <button
              type="button"
              onclick={toggleLamaDownload}
              class="btn-primary !py-1 !px-2.5 text-xs font-bold shrink-0 cursor-pointer flex items-center gap-1"
            >
              <Download size={13} />
              Download Now
            </button>
          {:else if lamaError}
            <button
              type="button"
              onclick={toggleLamaDownload}
              class="btn-ghost !py-1 !px-2.5 text-xs shrink-0 cursor-pointer flex items-center gap-1"
            >
              <Play size={13} />
              Retry
            </button>
          {/if}
        </div>

        {#if lamaDownloading || lamaPaused}
          <div class="space-y-1">
            <div class="h-1.5 bg-[var(--surface-panel)] rounded-full overflow-hidden border border-[var(--border-faint)]">
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

      <div class="p-2 bg-[var(--bg-void)] border border-[var(--border-line)] rounded-lg text-[var(--text-muted)] text-[11px] leading-snug">
        <strong class="text-[var(--text-primary)] font-medium">Neural redraw:</strong> Reconstructs screentone and artwork behind text. Regions LaMa declines fall back into Fast automatically.
      </div>
    {/if}

    <div class="flex items-center justify-between pt-2 border-t border-[var(--border-faint)]">
      <div class="flex flex-col">
        <span class="text-[13px] font-medium text-[var(--text-primary)]">
          Always inpaint
        </span>
        <span class="text-[11px] text-[var(--text-muted)]">
          Force inpainting even if quality checks decline (never leaves text area as-is)
        </span>
      </div>
      <label class="switch-cyber is-emerald">
        <input type="checkbox" bind:checked={alwaysInpaint} />
        <span class="track"><span class="thumb"></span></span>
      </label>
    </div>

    <div
      class="flex gap-1.5 p-2 bg-[var(--bg-void)] border border-[var(--border-line)] rounded-lg text-[var(--text-muted)] text-[11px] leading-snug"
    >
      <Info size={12} class="shrink-0 mt-0.5 text-[var(--accent-cyan)]" />
      <p>
        <strong class="font-semibold text-[var(--text-primary)]">Fast:</strong> Planar fill → bilateral denoise → Telea fast-marching.<br />
        <strong class="font-semibold text-[var(--text-primary)]">Quality:</strong> Standalone LaMa pass per region with Fast fallback.
      </p>
    </div>
  </div>
</div>
