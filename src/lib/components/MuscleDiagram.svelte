<script lang="ts">
  import frontRaw from '../../../static/svg/front.svg?raw';
  import backRaw from '../../../static/svg/back.svg?raw';

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

  const primarySet = $derived(new Set(primary.filter((id) => Number.isFinite(id))));
  const secondarySet = $derived(new Set(secondary.filter((id) => Number.isFinite(id))));

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

  const frontSvg = $derived(decorate(frontRaw));
  const backSvg = $derived(decorate(backRaw));

  const ariaLabel = $derived.by(() => {
    if (primary.length === 0 && secondary.length === 0) return 'Muscle diagram';
    return `Muscle diagram highlighting ${primary.length} primary and ${secondary.length} secondary muscles`;
  });
</script>

<div class="muscle-diagram {className}" role="img" aria-label={ariaLabel}>
  <div class="muscle-diagram__view">
    <div class="muscle-diagram__canvas">{@html frontSvg}</div>
    {#if showLabels}<span class="muscle-diagram__label">FRONT</span>{/if}
  </div>
  <div class="muscle-diagram__view">
    <div class="muscle-diagram__canvas">{@html backSvg}</div>
    {#if showLabels}<span class="muscle-diagram__label">BACK</span>{/if}
  </div>
  {#if showLegend && (primary.length > 0 || secondary.length > 0)}
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
    gap: 0.5rem;
    width: 100%;
  }

  .muscle-diagram__view {
    display: flex;
    min-width: 0;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
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
    font-size: 8px;
    letter-spacing: 0.18em;
    color: #52525b;
  }

  .muscle-diagram__legend {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.9rem;
    font-size: 8px;
    letter-spacing: 0.14em;
    color: #71717a;
  }

  .muscle-diagram__legend span {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
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
