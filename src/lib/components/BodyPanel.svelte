<script lang="ts">
  import { Bluetooth, ChevronDown, Pencil, Plus, Scale, Trash2, User } from '@lucide/svelte';
  import ConfirmDeletePopup from './ConfirmDeletePopup.svelte';
  import MetricChart from './MetricChart.svelte';
  import {
    availableMetrics,
    buildSeries,
    deriveBodyReadings,
    filterRange,
    formatMeasuredAt,
    formatMetric,
    formatMetricDelta,
    metricByKey,
    metricUnit,
    metricValueOf,
    rangeStart,
    summarize,
    trendDelta,
    type BodyMetricKey,
    type BodyRange,
    type DerivedReading,
  } from '$lib/bodyHistory';
  import type { BodyProfile, BodyReading } from '$lib/bodySanitize';
  import { formatBodyMass, massUnit, type BodyUnits } from '$lib/units';
  import { hapticLight, hapticWarning } from '$lib/haptics';

  /**
   * The BODY tab: measured weight plus profile-based estimates.
   *
   * Weight is the only measured truth here — the rest is re-derived per row from the
   * profile captured at that moment, so a birthday or corrected height does not
   * silently rewrite history. The three things a user looks for are above the fold:
   * where they are now, which way they are going, and when they last weighed in.
   */
  let {
    profile,
    readings = [],
    units = 'metric' as BodyUnits,
    canMeasure = true,
    onMeasure = () => {},
    onAddManual = () => {},
    onEditReading = (_reading: BodyReading) => {},
    onDeleteReading = async (_reading: BodyReading) => {},
    onEditProfile = () => {},
  }: {
    profile: BodyProfile;
    readings?: BodyReading[];
    units?: BodyUnits;
    canMeasure?: boolean;
    onMeasure?: () => void;
    onAddManual?: () => void;
    onEditReading?: (reading: BodyReading) => void;
    onDeleteReading?: (reading: BodyReading) => Promise<void> | void;
    onEditProfile?: () => void;
  } = $props();

  const DAY_MS = 24 * 60 * 60 * 1000;
  const RANGES: BodyRange[] = ['3weeks', '3m', '6m', 'ytd', 'all'];
  const RANGE_LABEL: Record<BodyRange, string> = {
    '3weeks': '3W',
    '3m': '3M',
    '6m': '6M',
    ytd: 'YTD',
    all: 'ALL',
  };

  let metricKey = $state<BodyMetricKey>('weight_kg');
  let range = $state<BodyRange>('3weeks');
  let selectedId = $state<string | null>(null);
  let listExpanded = $state(false);
  let deleting = $state<BodyReading | null>(null);
  let deleteAnchor = $state<HTMLElement | null>(null);
  let deleteOpen = $state(false);
  let deleteBusy = $state(false);

  /** Fixed at mount: the ranges are relative to when the tab opened, not to every re-render. */
  const now = new Date();

  const rows = $derived.by(() => {
    const ordered = [...readings].sort(
      (a, b) => new Date(b.measured_at).getTime() - new Date(a.measured_at).getTime(),
    );
    return deriveBodyReadings(ordered, profile);
  });

  const latest = $derived<DerivedReading | null>(rows.length ? rows[0] : null);

  /** Pills only for metrics that have a number somewhere in the history. */
  const metrics = $derived(availableMetrics(rows));
  const activeKey = $derived<BodyMetricKey>(
    metrics.some((m) => m.key === metricKey) ? metricKey : 'weight_kg',
  );
  const activeMetric = $derived(metricByKey(activeKey));

  const allPoints = $derived(buildSeries(rows, activeKey));
  const points = $derived(filterRange(allPoints, range, now));
  const summary = $derived(summarize(points));
  const delta7 = $derived(trendDelta(allPoints, 7));
  const delta30 = $derived(trendDelta(allPoints, 30));

  /** Tuple-typed so the markup still knows which half of each pair is a number. */
  const deltaChips = $derived<[string, number | null][]>([
    ['7 DAY', delta7],
    ['30 DAY', delta30],
  ]);
  const summaryChips = $derived<[string, number | null][]>([
    ['LATEST', summary.latest?.value ?? null],
    ['MIN', summary.min],
    ['MAX', summary.max],
    ['AVG', summary.avg],
  ]);

  const domainStart = $derived(
    range === 'all' && points.length ? points[0].at - DAY_MS : rangeStart(range, now),
  );
  const domainEnd = $derived(
    points.length ? Math.max(now.getTime(), points[points.length - 1].at) : now.getTime(),
  );
  const rangeIdx = $derived(Math.max(0, RANGES.indexOf(range)));

  const selected = $derived(rows.find((row) => row.reading.id === selectedId) ?? null);

  const daysSinceLatest = $derived(
    latest
      ? Math.max(0, Math.floor((now.getTime() - new Date(latest.reading.measured_at).getTime()) / DAY_MS))
      : null,
  );
  const stale = $derived(daysSinceLatest != null && daysSinceLatest >= 7);

  const profileMissing = $derived(
    profile.sex == null || profile.date_of_birth == null || profile.height_cm == null,
  );

  const visible = $derived(listExpanded ? rows : rows.slice(0, 8));
  const heroWeight = $derived(latest ? formatBodyMass(latest.reading.weight_kg, units) : '—');
  const heroBmi = $derived(latest?.metrics.bmi ?? null);

  function pickMetric(key: BodyMetricKey) {
    metricKey = key;
    selectedId = null;
    void hapticLight();
  }

  function openDelete(reading: BodyReading, node: HTMLElement) {
    deleteAnchor = node;
    deleting = reading;
    deleteOpen = true;
    void hapticLight();
  }

  async function confirmDelete(close: () => void) {
    const reading = deleting;
    if (!reading || deleteBusy) return;
    deleteBusy = true;
    try {
      await onDeleteReading(reading);
      deleting = null;
      if (selectedId === reading.id) selectedId = null;
    } catch {
      void hapticWarning();
    } finally {
      deleteBusy = false;
      close();
    }
  }
</script>

<div class="body-panel flex flex-col gap-2 min-w-0">
  <section class="rounded-lg border border-app-outline-subtle bg-app-surface-0 overflow-hidden">
    <div class="flex items-start gap-3 px-3 pt-3 pb-2.5">
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-1.5">
          <span class="font-7segment text-3xl leading-none text-app-fg-primary tabular-nums">{heroWeight}</span>
          <span class="text-app-micro tracking-[0.12em] text-app-fg-muted">{massUnit(units)}</span>
        </div>
        <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-app-micro text-app-fg-muted leading-none tabular-nums">
          {#if latest}
            <span>{formatMeasuredAt(latest.reading.measured_at, now)}</span>
            {#if latest.reading.source === 'scale' && latest.reading.device_label}
              <span class="text-zinc-700">·</span>
              <span class="max-w-[9rem] truncate">{latest.reading.device_label}</span>
            {/if}
          {:else}
            <span>No weigh-ins yet</span>
          {/if}
        </div>
      </div>

      {#if heroBmi != null}
        <div class="shrink-0 text-right">
          <div class="text-app-micro tracking-[0.14em] text-app-fg-disabled leading-none">BMI</div>
          <div class="mt-1 text-lg font-medium text-app-fg-primary leading-none tabular-nums">{heroBmi.toFixed(1)}</div>
          <div class="mt-1 text-app-micro tracking-[0.08em] text-app-fg-muted leading-none">{latest?.metrics.bmiClass ?? ''}</div>
        </div>
      {:else if latest && profileMissing}
        <button
          type="button"
          class="shrink-0 flex items-center gap-1.5 rounded-md border border-dashed border-app-outline px-2 py-1.5 text-app-micro tracking-[0.1em] text-app-fg-secondary hover:text-app-fg-primary hover:border-app-outline-strong transition-colors"
          onclick={onEditProfile}
        >
          <User class="app-icon-small" />
          <span>ADD PROFILE</span>
        </button>
      {/if}
    </div>

    {#if allPoints.length > 1}
      <div class="grid grid-cols-2 gap-px bg-app-surface-3 border-t border-app-outline-subtle">
        {#each deltaChips as [label, delta] (label)}
          <div class="bg-app-surface-0 px-3 py-1.5 flex items-center justify-between">
            <span class="text-app-micro tracking-[0.14em] text-app-fg-disabled">{label}</span>
            <span class="text-app-caption tabular-nums {delta == null ? 'text-app-fg-disabled' : delta > 0 ? 'text-app-fg-secondary-strong' : 'text-emerald-400'}">
              {formatMetricDelta(activeKey, delta, units)}
            </span>
          </div>
        {/each}
      </div>
    {/if}

    {#if stale}
      <div class="border-t border-app-outline-subtle bg-surface-0 px-3 py-1.5 text-app-micro leading-snug text-amber-200/80">
          Last weigh-in: {daysSinceLatest} days ago.
      </div>
    {/if}
  </section>

  <div class="flex gap-2">
    <button type="button" class="body-action body-action--go" onclick={onMeasure} disabled={!canMeasure}>
      <Scale class="app-icon-control" />
      <span>{canMeasure ? 'MEASURE' : 'LOADING…'}</span>
    </button>
    <button type="button" class="body-action" onclick={onAddManual} title="Type in a weigh-in">
      <Plus class="app-icon-control" />
      <span>MANUAL</span>
    </button>
  </div>

  {#if rows.length === 0}
    <div class="flex flex-col items-center gap-2.5 rounded-lg border border-dashed border-app-outline-subtle bg-app-surface-0 px-4 py-8 text-center">
      <span class="w-9 h-9 rounded-lg border border-app-outline-subtle bg-app-canvas flex items-center justify-center text-app-fg-muted">
        <Bluetooth class="app-icon-control" />
      </span>
      <div class="text-xs leading-snug text-app-fg-secondary">
        This scale sends weight over Bluetooth. BMI, body-fat, body-water, and BMR values are estimates calculated from your profile.
      </div>
      <div class="max-w-[22rem] text-app-micro leading-snug text-app-fg-disabled">
        The BLE reading does not include reliable heart-rate or impedance data, so those metrics are not shown.
      </div>
      <div class="max-w-[22rem] text-app-micro leading-snug text-app-fg-disabled">
        No Bluetooth on this device? Use MANUAL and type in what the display shows.
      </div>
      {#if profileMissing}
        <button
          type="button"
          class="mt-1 h-8 px-3 rounded-md border border-app-outline bg-app-surface-1 text-app-micro font-medium tracking-wide text-app-fg-secondary-strong hover:border-app-outline-strong hover:text-app-fg-primary"
          onclick={onEditProfile}
        >
          SET UP PROFILE
        </button>
      {/if}
    </div>
  {:else}
    {#if latest?.reading.source === 'scale'}
      <p class="px-1 text-app-micro leading-snug text-app-fg-disabled">
        Weight is measured. BMI, body-fat, body-water, and BMR values are profile-based estimates; this scale does not send reliable heart-rate or impedance data.
      </p>
    {/if}
    <div class="flex gap-1.5 overflow-x-auto no-scrollbar" role="tablist" aria-label="Body metrics">
      {#each metrics as metric (metric.key)}
        <button
          type="button"
          role="tab"
          aria-selected={metric.key === activeKey}
          title={metric.hint}
          class="body-pill"
          class:body-pill--on={metric.key === activeKey}
          onclick={() => pickMetric(metric.key)}
        >{metric.label}</button>
      {/each}
    </div>

    <div
      class="relative grid h-8 shrink-0 grid-cols-5 rounded-md border border-app-outline-subtle bg-app-canvas px-0.5"
      role="group"
      aria-label="Chart range"
    >
      <div
        class="pointer-events-none absolute top-0.5 bottom-0.5 rounded-sm bg-white transition-transform duration-200 ease-out"
        style="width: calc((100% - 4px) / 5); left: 2px; transform: translateX(calc({rangeIdx} * 100%))"
      ></div>
      {#each RANGES as mode}
        <button
          type="button"
          class="relative z-10 h-full flex items-center justify-center text-app-micro font-medium tracking-[0.1em] transition-colors {range === mode ? 'text-black' : 'text-app-fg-muted hover:text-app-fg-secondary-strong'}"
          onclick={() => {
            range = mode;
            void hapticLight();
          }}
        >{RANGE_LABEL[mode]}</button>
      {/each}
    </div>

    <div class="rounded-md border border-app-outline-subtle bg-app-canvas overflow-hidden">
      <MetricChart
        {points}
        {domainStart}
        {domainEnd}
        {selectedId}
        onPick={(id) => {
          selectedId = id;
          if (id) void hapticLight();
        }}
      />
    </div>

    {#if points.length > 0}
      <div class="grid grid-cols-4 gap-px rounded-md border border-app-outline-subtle bg-app-surface-3 overflow-hidden">
        {#each summaryChips as [label, value] (label)}
          <div class="flex flex-col items-center gap-1 bg-app-surface-0 px-2 py-1.5">
            <span class="text-app-micro tracking-[0.14em] text-app-fg-disabled leading-none">{label}</span>
            <span class="text-app-caption text-app-fg-secondary-strong leading-none tabular-nums">{formatMetric(activeKey, value, units)}</span>
          </div>
        {/each}
      </div>
      <div class="flex items-center justify-between px-1 text-app-micro text-app-fg-disabled tabular-nums">
        <span>{points.length} {activeMetric.label.toLowerCase()} values</span>
        <span>{RANGE_LABEL[range]} · {metricUnit(activeKey, units) || 'index'}</span>
      </div>
    {/if}

    {#if selected}
      <div class="rounded-md border border-app-outline-subtle bg-app-canvas px-2.5 py-2">
        <div class="flex items-center justify-between gap-2">
          <span class="text-app-micro text-app-fg-secondary tabular-nums">{formatMeasuredAt(selected.reading.measured_at, now)}</span>
          <button
            type="button"
            class="flex items-center gap-1 text-app-micro tracking-[0.1em] text-app-fg-muted hover:text-app-fg-primary transition-colors"
            onclick={() => onEditReading(selected.reading)}
          >
            <Pencil class="app-icon-small" />
            <span>EDIT</span>
          </button>
        </div>
        {#if metrics.length > 1}
          <div class="mt-2 grid grid-cols-3 gap-x-2 gap-y-1.5">
            {#each metrics as metric (metric.key)}
              {#if metric.key !== activeKey}
                <div class="flex flex-col gap-0.5">
                  <span class="text-app-micro tracking-[0.12em] text-app-fg-disabled leading-none">{metric.label}</span>
                  <span class="text-app-micro text-app-fg-secondary-strong leading-none tabular-nums">
                    {formatMetric(metric.key, metricValueOf(selected, metric.key), units)}
                  </span>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
        <div class="mt-2 text-app-micro leading-snug text-app-fg-disabled">
          {activeMetric.hint} · {selected.canDerive
            ? 'derived from the profile saved with this reading'
            : 'profile incomplete, so only measured values are available'}
        </div>
      </div>
    {/if}

    <div class="rounded-lg border border-app-outline-subtle bg-app-surface-0 overflow-hidden">
      <div class="flex items-center justify-between border-b border-app-outline-subtle px-2.5 py-1.5">
        <span class="text-app-micro tracking-[0.14em] text-app-fg-disabled">WEIGH-INS</span>
        <span class="text-app-micro text-app-fg-disabled tabular-nums">{rows.length}</span>
      </div>
      {#each visible as row (row.reading.id)}
        {@const isActiveRow = row.reading.id === selectedId}
        <div
          class="body-row flex items-center gap-2 px-2.5 py-1.5 border-b border-outline-subtle last:border-b-0"
          class:body-row--on={isActiveRow}
          role="button"
          tabindex="0"
          onclick={() => {
            selectedId = isActiveRow ? null : row.reading.id;
            void hapticLight();
          }}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectedId = isActiveRow ? null : row.reading.id;
            }
          }}
        >
          <div class="flex-1 min-w-0">
            <div class="text-app-caption text-app-fg-secondary-strong leading-none tabular-nums">
              {formatMeasuredAt(row.reading.measured_at, now)}
            </div>
            <div class="mt-1 flex items-center gap-1.5 text-app-micro text-app-fg-disabled leading-none tabular-nums">
              <span>{row.reading.source}</span>
              {#if row.reading.heart_rate != null}
                <span class="text-zinc-700">·</span>
                <span>{row.reading.heart_rate} bpm</span>
              {/if}
              {#if row.ohms != null}
                <span class="text-zinc-700">·</span>
                <span>{Math.round(row.ohms)} Ω</span>
              {/if}
              {#if row.age}
                <span class="text-zinc-700">·</span>
                <span>{row.age.years}y {row.age.months}m</span>
              {/if}
            </div>
          </div>
          {#if row.metrics.bodyFatPct != null}
            <span class="shrink-0 text-app-micro text-app-fg-muted tabular-nums">{row.metrics.bodyFatPct}% fat</span>
          {/if}
          <span class="w-16 shrink-0 text-right text-app-caption text-app-fg-primary tabular-nums">
            {formatBodyMass(row.reading.weight_kg, units)}
          </span>
          <button
            type="button"
            class="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-app-fg-disabled hover:text-red-400 hover:bg-canvas transition-colors"
            aria-label="Delete weigh-in"
            title="Delete"
            onclick={(e) => {
              e.stopPropagation();
              openDelete(row.reading, e.currentTarget as HTMLElement);
            }}
          >
            <Trash2 class="app-icon-small" />
          </button>
        </div>
      {/each}

      {#if rows.length > 8}
        <button
          type="button"
          class="w-full h-8 flex items-center justify-center gap-1.5 text-app-micro tracking-[0.14em] text-app-fg-muted hover:text-app-fg-primary transition-colors"
          onclick={() => {
            listExpanded = !listExpanded;
            void hapticLight();
          }}
        >
          <ChevronDown class="app-icon-small transition-transform duration-200 {listExpanded ? 'rotate-180' : ''}" />
          <span>{listExpanded ? 'SHOW LESS' : `SHOW ALL ${rows.length}`}</span>
        </button>
      {/if}
    </div>
  {/if}
</div>

<ConfirmDeletePopup
  bind:open={deleteOpen}
  label={deleting ? formatMeasuredAt(deleting.measured_at, now) : ''}
  message="The weigh-in leaves your history and every chart."
  busy={deleteBusy}
  anchorEl={deleteAnchor}
  onConfirm={confirmDelete}
/>

<style>
  .body-action {
    display: inline-flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    gap: var(--space-1-5);
    height: 2.25rem;
    border-radius: var(--app-radius-compact);
    border: 1px solid var(--app-outline-subtle);
    background: var(--app-surface-0);
    font-size: var(--type-micro);
    font-weight: 500;
    letter-spacing: 0.08em;
    color: var(--app-fg-secondary);
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
  }

  .body-action:hover {
    border-color: var(--app-outline-strong);
    color: #fff;
  }

  .body-action--go {
    background: #fff;
    border-color: #fff;
    color: #000;
  }

  .body-action--go:hover:not(:disabled) {
    background: #e4e4e7;
    border-color: var(--app-outline-strong);
    color: #000;
  }

  .body-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .body-pill {
    flex-shrink: 0;
    height: 1.75rem;
    padding: 0 var(--space-2-5);
    border-radius: 999px;
    border: 1px solid var(--app-outline-subtle);
    background: var(--app-canvas);
    font-size: var(--type-micro);
    font-weight: 500;
    letter-spacing: 0.1em;
    color: var(--app-fg-muted);
    white-space: nowrap;
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
  }

  .body-pill:hover {
    color: var(--app-fg-secondary-strong);
    border-color: var(--app-outline);
  }

  .body-pill--on {
    background: #fff;
    border-color: #fff;
    color: #000;
  }

  .body-pill--on:hover {
    color: #000;
  }

  .body-row {
    cursor: pointer;
    transition: background-color 120ms ease;
  }

  .body-row:hover {
    background: var(--app-surface-1);
  }

  .body-row--on {
    background: var(--app-surface-1);
  }
</style>
