<script lang="ts">
  import { onMount } from 'svelte';

  let {
    primary = [],
    secondary = [],
    class: className = '',
    showLabels = true,
    showLegend = false,
  }: {
    primary?: number[];
    secondary?: number[];
    class?: string;
    showLabels?: boolean;
    showLegend?: boolean;
  } = $props();

  let frontRaw = $state('');
  let backRaw = $state('');
  let loadingState = $state<'loading' | 'ready' | 'error'>('loading');
  let diagramRequest: AbortController | null = null;

  const primarySet = $derived(new Set(primary.filter((id) => Number.isFinite(id))));
  const secondarySet = $derived(new Set(secondary.filter((id) => Number.isFinite(id))));

  async function loadDiagrams() {
    diagramRequest?.abort();
    const request = new AbortController();
    diagramRequest = request;
    loadingState = 'loading';
    try {
      const [frontResponse, backResponse] = await Promise.all([
        fetch('/svg/front.svg', { signal: request.signal }),
        fetch('/svg/back.svg', { signal: request.signal }),
      ]);
      if (!frontResponse.ok || !backResponse.ok) throw new Error('Muscle diagrams could not be loaded.');
      const [front, back] = await Promise.all([frontResponse.text(), backResponse.text()]);
      if (request.signal.aborted) return;
      frontRaw = front;
      backRaw = back;
      loadingState = 'ready';
    } catch (error) {
      if (!request.signal.aborted) {
        loadingState = 'error';
        console.warn('[muscle-diagram] Could not load local illustration assets.', error);
      }
    }
  }

  onMount(() => {
    void loadDiagrams();
    return () => diagramRequest?.abort();
  });

  function decorate(source: string): string {
    return source.replace(
      /<g id="muscle-(\d+)" class="muscle-overlay"/g,
      (_match, rawId: string) => {
        const id = Number(rawId);
        const role = primarySet.has(id)
          ? 'muscle-primary'
          : secondarySet.has(id)
            ? 'muscle-secondary'
            : 'muscle-idle';
        return `<g id="muscle-${id}" class="muscle-overlay ${role}"`;
      },
    );
  }

  const frontSvg = $derived(frontRaw ? decorate(frontRaw) : '');
  const backSvg = $derived(backRaw ? decorate(backRaw) : '');

  const ariaLabel = $derived.by(() => {
    if (primary.length === 0 && secondary.length === 0) return 'Muscle diagram';
    return `Muscle diagram highlighting ${primary.length} primary and ${secondary.length} secondary muscles`;
  });
</script>

<div
  class="muscle-diagram {className}"
  role={loadingState === 'ready' ? 'img' : 'group'}
  aria-label={loadingState === 'ready' ? ariaLabel : loadingState === 'loading' ? 'Loading muscle diagrams' : undefined}
>
  {#if loadingState === 'error'}
    <div class="muscle-diagram__error" role="status">
      <span>Muscle maps are unavailable.</span>
      <button type="button" onclick={() => void loadDiagrams()}>TRY AGAIN</button>
    </div>
  {:else}
    <div class="muscle-diagram__view">
      <div class="muscle-diagram__canvas">
        {#if loadingState === 'ready'}{@html frontSvg}{:else}<span role="status">Loading…</span>{/if}
      </div>
      {#if showLabels}<span class="muscle-diagram__label">FRONT</span>{/if}
    </div>
    <div class="muscle-diagram__view">
      <div class="muscle-diagram__canvas" aria-hidden="true">
        {#if loadingState === 'ready'}{@html backSvg}{:else}<span>Loading…</span>{/if}
      </div>
      {#if showLabels}<span class="muscle-diagram__label">BACK</span>{/if}
    </div>
  {/if}
  {#if loadingState === 'ready' && showLegend && (primary.length > 0 || secondary.length > 0)}
    <div class="muscle-diagram__legend">
      {#if primary.length > 0}
        <span><i class="muscle-diagram__dot muscle-diagram__dot--primary"></i>PRIMARY</span>
      {/if}
      {#if secondary.length > 0}
        <span><i class="muscle-diagram__dot muscle-diagram__dot--secondary"></i>SECONDARY</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .muscle-diagram {
    --muscle-body: #17171a;
    --muscle-body-stroke: #2c2c32;
    --muscle-idle-fill: #52525b;
    --muscle-primary-color: #fbbf24;
    --muscle-secondary-color: #38bdf8;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-2);
    width: 100%;
  }

  .muscle-diagram__view {
    display: flex;
    min-width: 0;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
  }

  .muscle-diagram__canvas {
    display: flex;
    width: 100%;
    align-items: flex-end;
    justify-content: center;
  }

  .muscle-diagram__canvas :global(svg) {
    display: block;
    width: 100%;
    max-width: 11rem;
    height: auto;
    overflow: visible;
  }

  .muscle-diagram__canvas :global(.body-silhouette) {
    fill: var(--muscle-body);
    stroke: var(--muscle-body-stroke);
    stroke-width: 0.8;
  }

  .muscle-diagram__canvas :global(.muscle-overlay) {
    transition:
      fill 240ms ease,
      opacity 240ms ease,
      filter 240ms ease;
  }

  .muscle-diagram__canvas :global(.muscle-idle) {
    fill: var(--muscle-idle-fill);
    opacity: 0.16;
  }

  .muscle-diagram__canvas :global(.muscle-primary) {
    fill: var(--muscle-primary-color);
    opacity: 0.92;
    filter: drop-shadow(0 0 2.5px color-mix(in srgb, var(--muscle-primary-color) 60%, transparent));
  }

  .muscle-diagram__canvas :global(.muscle-secondary) {
    fill: var(--muscle-secondary-color);
    opacity: 0.7;
  }

  .muscle-diagram__label {
    font-family: var(--font-mono, monospace);
    font-size: var(--type-micro);
    letter-spacing: 0.18em;
    color: var(--app-fg-disabled);
  }

  .muscle-diagram__legend {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3-5);
    font-size: var(--type-micro);
    letter-spacing: 0.14em;
    color: var(--app-fg-muted);
  }

  .muscle-diagram__error {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2-5);
    min-height: 3rem;
    color: var(--app-fg-secondary);
    font-size: var(--type-micro);
  }

  .muscle-diagram__error button {
    min-height: 2.75rem;
    padding: 0 var(--space-3);
    border: 1px solid var(--app-outline-strong);
    border-radius: var(--app-radius-control);
    color: var(--app-fg-secondary-strong);
    font: 600 var(--type-micro) var(--font-mono, monospace);
    letter-spacing: 0.08em;
  }

  .muscle-diagram__canvas > span {
    display: grid;
    width: 100%;
    max-width: 11rem;
    aspect-ratio: 3 / 4;
    place-items: center;
    color: var(--app-fg-muted);
    font-size: var(--type-micro);
  }

  .muscle-diagram__legend span {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }

  .muscle-diagram__dot {
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 999px;
  }

  .muscle-diagram__dot--primary {
    background: var(--muscle-primary-color);
  }

  .muscle-diagram__dot--secondary {
    background: var(--muscle-secondary-color);
  }

  @media (prefers-reduced-motion: reduce) {
    .muscle-diagram__canvas :global(.muscle-overlay) {
      transition: none;
    }
  }
</style>
