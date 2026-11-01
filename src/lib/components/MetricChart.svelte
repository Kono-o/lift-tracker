<script lang="ts">
  import type { BodyPoint } from '$lib/bodyHistory';

  /**
   * Time-series line chart for body readings.
   *
   * The viewBox width tracks the container (measured, not assumed): a fixed viewBox
   * with `width="100%"` letterboxes the drawing on a wide screen, and every tap then
   * maps to the wrong day. Matching the viewBox to the pixel box makes hit-testing
   * exact and keeps the axis text un-stretched.
   *
   * Empty stretches of days are shaded, so "I stopped weighing in" reads as a gap
   * instead of a smooth line.
   */
  let {
    points,
    domainStart,
    domainEnd,
    color = '#e4e4e7',
    height = 188,
    selectedId = null,
    onPick = () => {},
  }: {
    points: BodyPoint[];
    domainStart: number;
    domainEnd: number;
    color?: string;
    height?: number;
    selectedId?: string | null;
    onPick?: (id: string | null) => void;
  } = $props();

  const PAD_L = 40;
  const PAD_R = 10;
  const PAD_T = 14;
  const PAD_B = 26;
  const DAY_MS = 24 * 60 * 60 * 1000;

  let host = $state<HTMLDivElement | undefined>(undefined);
  let boxWidth = $state(0);

  $effect(() => {
    const node = host;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? node.clientWidth);
      // A 0-width read during a tab transition must not blank the chart out.
      if (next > 0) boxWidth = next;
    });
    observer.observe(node);
    return () => observer.disconnect();
  });

  const viewW = $derived(boxWidth || 560);
  const plotW = $derived(Math.max(1, viewW - PAD_L - PAD_R));
  const plotH = $derived(Math.max(1, height - PAD_T - PAD_B));

  const span = $derived(Math.max(DAY_MS, domainEnd - domainStart));
  const xOf = (at: number) =>
    PAD_L + Math.max(0, Math.min(1, (at - domainStart) / span)) * plotW;

  const scale = $derived.by(() => {
    const values = points.map((p) => p.value);
    if (values.length === 0) return { min: 0, max: 1 };
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max - min < 1e-6) {
      // One value (or an unchanged streak): frame it instead of hugging the axis.
      const pad = Math.max(0.5, Math.abs(max) * 0.02);
      min -= pad;
      max += pad;
    } else {
      const pad = (max - min) * 0.12;
      min -= pad;
      max += pad;
    }
    return { min, max };
  });

  const range = $derived(scale.max - scale.min || 1);
  const yOf = (value: number) => PAD_T + plotH - ((value - scale.min) / range) * plotH;

  const latestId = $derived(points.length ? points[points.length - 1].id : null);

  const yTicks = $derived(
    Array.from({ length: 3 }, (_, i) => {
      const value = scale.min + (i / 2) * range;
      return { value, y: yOf(value) };
    }),
  );

  const xTicks = $derived.by(() => {
    const count = Math.max(2, Math.min(5, Math.round(plotW / 96)));
    return Array.from({ length: count }, (_, i) => {
      const at = domainStart + (i / (count - 1)) * span;
      return { at, x: xOf(at) };
    });
  });

  const gaps = $derived.by(() => {
    const out: { x: number; w: number; days: number }[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const days = Math.round((points[i + 1].at - points[i].at) / DAY_MS);
      if (days < 2) continue;
      const left = xOf(points[i].at + DAY_MS);
      const right = xOf(points[i + 1].at - DAY_MS);
      out.push({ x: left, w: Math.max(1, right - left), days });
    }
    return out;
  });

  function axisLabel(at: number): string {
    return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function yLabel(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1000) return String(Math.round(value));
    return abs >= 100 ? value.toFixed(0) : value.toFixed(1);
  }

  /** Tap the plot: select the nearest reading, tap it again to clear. */
  function handlePlotTap(event: MouseEvent) {
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * viewW;
    let best: { id: string; distance: number } | null = null;
    for (const point of points) {
      const distance = Math.abs(xOf(point.at) - x);
      if (!best || distance < best.distance) best = { id: point.id, distance };
    }
    const hit = best && best.distance <= 28 ? best.id : null;
    onPick(hit === selectedId ? null : hit);
  }
</script>

<div class="metric-chart" bind:this={host} style="--chart-accent: {color};">
  {#if points.length === 0}
    <div class="metric-chart__empty" style="height: {height}px">
      <span>Nothing recorded in this range</span>
    </div>
  {:else}
    <svg
      viewBox="0 0 {viewW} {height}"
      width="100%"
      height={height}
      class="block select-none cursor-pointer"
      role="presentation"
      onclick={handlePlotTap}
    >
      <rect x={PAD_L} y={PAD_T} width={plotW} height={plotH} fill="#0c0c0c" stroke="#161616" stroke-width="1" />

      {#each yTicks as tick}
        <line x1={PAD_L} y1={tick.y} x2={PAD_L + plotW} y2={tick.y} stroke="#161616" stroke-width="1" />
        <text x={PAD_L - 5} y={tick.y + 3.5} text-anchor="end" fill="#52525b" font-size="10" font-family="ui-monospace, monospace">{yLabel(tick.value)}</text>
      {/each}

      {#each xTicks as tick}
        <line x1={tick.x} y1={PAD_T} x2={tick.x} y2={PAD_T + plotH} stroke="#141414" stroke-width="1" />
        <text x={tick.x} y={PAD_T + plotH + 16} text-anchor="middle" fill="#52525b" font-size="10" font-family="ui-monospace, monospace">{axisLabel(tick.at)}</text>
      {/each}

      {#each gaps as gap}
        <rect x={gap.x} y={PAD_T} width={gap.w} height={plotH} fill="#eab308" fill-opacity="0.05" />
        <text
          x={gap.x + gap.w / 2}
          y={PAD_T + 11}
          text-anchor="middle"
          fill="#a16207"
          font-size="8"
          opacity="0.75"
        >{gap.days}d</text>
      {/each}

      {#each points.slice(0, -1) as point, i}
        <line
          x1={xOf(point.at)}
          y1={yOf(point.value)}
          x2={xOf(points[i + 1].at)}
          y2={yOf(points[i + 1].value)}
          stroke="var(--chart-accent)"
          stroke-width="2"
          stroke-linecap="round"
        />
      {/each}

      {#each points as point}
        {@const x = xOf(point.at)}
        {@const y = yOf(point.value)}
        {@const isSelected = point.id === selectedId}
        {#if isSelected}
          <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + plotH} stroke="#e4e4e7" stroke-width="1" stroke-dasharray="3 3" opacity="0.45" />
        {/if}
        <circle
          cx={x}
          cy={y}
          r={isSelected ? 4.5 : point.id === latestId ? 3.5 : 2.75}
          fill="var(--chart-accent)"
          stroke={isSelected ? '#fff' : 'var(--chart-accent)'}
          stroke-opacity={isSelected ? 1 : 0.9}
          stroke-width={isSelected ? 1.5 : 1}
        />
      {/each}
    </svg>
  {/if}
</div>

<style>
  .metric-chart {
    position: relative;
    border-radius: 0.375rem;
    border: 1px solid #1e1e1e;
    background: #080808;
    overflow: hidden;
  }

  .metric-chart__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 0 1rem;
    font-size: 11px;
    color: #71717a;
  }
</style>
