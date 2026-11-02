<script lang="ts">
  import { fade } from 'svelte/transition';
  import { X, RefreshCw, Bluetooth, ChevronRight } from '@lucide/svelte';
  import { createScaleClient } from '$lib/scale';
  import { menuPanelIn, menuPanelOut, OVERLAY_MS } from '$lib/menuTransitions';
  import type { ScaleClientState } from '$lib/scale/client';
  import type { ScaleReading, ScaleStage, SettleMetric } from '$lib/scale/session';
  import type { ScaleDevice } from '$lib/scale/discovery';
  import ScaleDeviceList from '$lib/components/ScaleDeviceList.svelte';
  import { canDerive, type MetricTier } from '$lib/bodyComp';
  import {
    BODY_METRICS,
    TIER_LABEL,
    TIER_HINT,
    deriveBodyReading,
    formatMeasuredAt,
    formatMetric,
    metricTier,
    metricValueOf,
    toLocalInputValue,
    type BodyMetric,
    type BodyMetricKey,
  } from '$lib/bodyHistory';
  import { ageFromDob, ageYearsDecimal } from '$lib/age';
  import { massUnit, massRange, toDisplayMass, fromDisplayMass, type BodyUnits } from '$lib/units';
  import { CAPTURE_VERSION_STAGED, type BodyProfile, type BodyReading, type BodyReadingInput } from '$lib/bodySanitize';
  import { hapticLight, hapticMedium, hapticSuccess, hapticWarning } from '$lib/haptics';
  import { playError, playSetLogged } from '$lib/sounds';

  /**
   * One weigh-in, start to finish: pick a scale, stand still while each signal
   * stabilizes in its own order, then read the composition off the result grid.
   *
   * The whole point is that the user never has to think about Bluetooth. The board
   * lists what this platform already knows and what it can hear; a row tap connects
   * without a dialog. Where the browser will not enumerate (a scale never granted to
   * this origin), the system picker stays on the sheet as the fallback, and manual
   * entry is always one tap away for the days the scale refuses to cooperate.
   *
   * Nothing here invents a number. The result grid is the same derivation the history
   * uses, and every cell says whether the hardware measured it, BIA computed it from a
   * real resistance, or it is only an estimate off weight, height, age and sex.
   */
  let {
    open = $bindable(false),
    profile,
    editing = null,
    startManual = false,
    units = 'metric' as BodyUnits,
    onDismiss = () => {},
    onSave = async () => {},
    onEditProfile = () => {},
  }: {
    /** Kept mounted so the close transition can run; the sheet owns its own BLE session. */
    open?: boolean;
    profile: BodyProfile;
    /** A stored row to correct — opens the form prefilled instead of the scale. */
    editing?: BodyReading | null;
    /** The MANUAL button: skip the scale and type it in. */
    startManual?: boolean;
    units?: BodyUnits;
    onDismiss?: () => void;
    onSave?: (input: BodyReadingInput) => Promise<void> | void;
    onEditProfile?: () => void;
  } = $props();

  let client = $state<ReturnType<typeof createScaleClient> | null>(null);
  let stage = $state<ScaleClientState>('idle');
  let clientStage = $state<ScaleStage>('weigh');
  let devices = $state<ScaleDevice[]>([]);
  let scanning = $state(false);
  let selectedId = $state<string | null>(null);
  let liveWeight = $state(0);
  let liveHeartRate = $state<number | null>(null);
  let liveOhms = $state<number | null>(null);
  let lockedWeight = $state<number | null>(null);
  let reading = $state<ScaleReading | null>(null);
  let capturedAt = $state<string | null>(null);
  let deviceLabel = $state<string | null>(null);
  let battery = $state<number | null>(null);
  let errorMessage = $state<string | null>(null);
  // Null until the user picks: the parent can open the sheet straight into the
  // manual form without waiting for an effect to run after the first render.
  let manualChoice = $state<boolean | null>(null);
  let manualWeight = $state('');
  let manualHeartRate = $state('');
  let manualWhen = $state(toLocalInputValue(new Date().toISOString()));
  let saving = $state(false);

  type SettleProgress = { have: number; need: number; value: number | null };
  const unsettle = (): Record<SettleMetric, SettleProgress> => ({
    heart_rate: { have: 0, need: 0, value: null },
    impedance: { have: 0, need: 0, value: null },
  });
  let settle = $state<Record<SettleMetric, SettleProgress>>(unsettle());

  const transportKind = $derived(client?.transportKind ?? 'web');
  const supported = $derived(client ? client.supported() : true);
  const unsupportedReason = $derived(client?.unsupportedReason() ?? null);
  /** False only on a platform where a row tap cannot reach the device. */
  const connectable = $derived(client?.canPickById() ?? false);

  /** Manual entry is forced when the build cannot reach Bluetooth, or to correct a stored row. */
  const manualOnly = $derived(!supported || editing != null);
  const manual = $derived(manualChoice ?? (manualOnly || startManual));

  $effect(() => {
    if (!open) return;
    const instance = createScaleClient();
    client = instance;
    devices = instance.devices;
    scanning = instance.scanning;
    const off = [
      instance.on('state', (next) => {
        stage = next;
        if (next === 'error') void hapticWarning();
      }),
      instance.on('device', (label) => {
        deviceLabel = label;
      }),
      instance.on('battery', (level) => {
        battery = level;
      }),
      instance.on('stage', (next) => {
        clientStage = next;
      }),
      instance.on('devices', (next) => {
        devices = next;
      }),
      instance.on('scanning', (next) => {
        scanning = next;
      }),
      instance.on('settle', (event) => {
        settle[event.metric] = { have: event.have, need: event.need, value: event.value };
      }),
      instance.on('live', (frame) => {
        liveWeight = frame.weightKg;
        liveHeartRate = frame.heartRate;
        liveOhms = frame.impedanceOhms;
      }),
      instance.on('locked', (locked) => {
        lockedWeight = locked.weightKg;
        void hapticMedium();
        playSetLogged();
      }),
      instance.on('complete', (finished) => {
        reading = finished;
        capturedAt = new Date().toISOString();
        void hapticSuccess();
        playSetLogged();
      }),
      instance.on('error', (err) => {
        errorMessage = err.message || 'Could not read the scale';
      }),
    ];
    // Fill the board on open. Advertisement watching usually needs the tap that
    // presses LOOK FOR SCALES, so this pass is best-effort and never an error.
    if (instance.supported() && instance.canDiscover()) void instance.scan();
    return () => {
      for (const dispose of off) dispose();
      instance.dispose();
      client = null;
    };
  });

  /** The final number, whichever path produced it. */
  const capturedKg = $derived(reading?.weightKg ?? lockedWeight ?? liveWeight ?? 0);
  const capturedHeartRate = $derived(reading?.heartRate ?? null);
  const capturedOhms = $derived(reading?.impedanceOhms ?? null);

  const displayWeight = $derived(
    capturedKg > 0 ? toDisplayMass(capturedKg, units).toFixed(1) : '0.0',
  );

  const showScale = $derived(!manual && !manualOnly);

  const ageYears = $derived(ageYearsDecimal(ageFromDob(profile.date_of_birth)));

  const profileReady = $derived(
    canDerive({
      sex: profile.sex,
      heightCm: profile.height_cm,
      ageYears,
    }),
  );

  /**
   * The capture, shaped as the row it is about to become, so the grid on this sheet
   * and the one in the history come from the same derivation.
   */
  const captured = $derived.by((): BodyReading | null => {
    if (!reading || !capturedAt) return null;
    return {
      id: 'pending',
      user_id: 'pending',
      measured_at: capturedAt,
      weight_kg: Math.round(reading.weightKg * 1000) / 1000,
      heart_rate: reading.heartRate,
      impedance_ohms: reading.impedanceOhms,
      impedance_source: reading.impedanceSource,
      captured_version: CAPTURE_VERSION_STAGED,
      source: 'scale',
      device_label: deviceLabel,
      profile_snapshot: {
        sex: profile.sex,
        date_of_birth: profile.date_of_birth,
        height_cm: profile.height_cm,
        activity: profile.activity,
      },
    };
  });

  const capturedRow = $derived(captured ? deriveBodyReading(captured, profile) : null);

  type MetricRow = { key: BodyMetricKey; metric: BodyMetric; text: string; tier: MetricTier };

  const TIERS: MetricTier[] = ['measured', 'bia', 'estimate'];

  /**
   * Weight is the headline, so the grid starts at the optional signals. A measured
   * column that never arrived still gets a cell — "not sent" is information — while a
   * computed one with nothing to compute it from is dropped rather than shown as a dash.
   */
  const results = $derived.by((): MetricRow[] => {
    if (!capturedRow) return [];
    const rows: MetricRow[] = [];
    for (const metric of BODY_METRICS.slice(1)) {
      const value = metricValueOf(capturedRow, metric.key);
      const tier = metricTier(capturedRow, metric.key);
      if (value == null && tier !== 'measured') continue;
      rows.push({
        key: metric.key,
        metric,
        text: value == null ? 'not sent' : formatMetric(metric.key, value, units),
        tier,
      });
    }
    return rows;
  });

  const resultSummary = $derived.by(() => {
    if (!reading) return '';
    const parts = [`${displayWeight} ${massUnit(units)} locked`];
    parts.push(reading.heartRate != null ? `${reading.heartRate} bpm` : 'no pulse');
    parts.push(reading.impedanceOhms != null ? `${Math.round(reading.impedanceOhms)} Ω` : 'no resistance');
    parts.push(`${reading.frames} frames read`);
    return parts.join(' · ');
  });

  /** A frame that flickers a value is worth showing before enough of them agree. */
  const heartSignal = $derived.by(
    (): SettleProgress => ({ ...settle.heart_rate, value: settle.heart_rate.value ?? liveHeartRate }),
  );
  const impedanceSignal = $derived.by(
    (): SettleProgress => ({ ...settle.impedance, value: settle.impedance.value ?? liveOhms }),
  );

  type PhaseState = 'waiting' | 'collecting' | 'locked';
  type Phase = { label: string; state: PhaseState; text: string; pct: number | null };

  /**
   * One row per signal, in the order the hardware produces them. `pct` is the
   * stabilization agreement so far; null means the bar has nothing honest to show yet.
   * The sheet leaves this view the moment the reading completes, so a signal that
   * never agreed is the result grid's "not sent" cell to report, not a row here.
   */
  const phases = $derived.by((): Phase[] => {
    const weight: Phase =
      lockedWeight != null
        ? { label: 'WEIGHT', state: 'locked', text: 'locked', pct: 1 }
        : stage === 'choosing'
          ? { label: 'WEIGHT', state: 'waiting', text: 'waiting for the scale', pct: 0 }
          : liveWeight > 0
            ? { label: 'WEIGHT', state: 'collecting', text: 'looking for a steady number', pct: null }
            : { label: 'WEIGHT', state: 'waiting', text: 'step on and hold still', pct: 0 };

    const started = lockedWeight != null || clientStage !== 'weigh';

    const settled = (label: string, progress: SettleProgress, format: (value: number) => string): Phase => {
      if (!started) return { label, state: 'waiting', text: 'after the weight locks', pct: 0 };
      if (progress.value == null) return { label, state: 'collecting', text: 'listening', pct: null };
      const enough = progress.need > 0 && progress.have >= progress.need;
      return {
        label,
        state: enough ? 'locked' : 'collecting',
        text: `${format(progress.value)} · ${enough ? 'holding' : `${progress.have}/${progress.need} steady`}`,
        pct: enough ? 1 : progress.need > 0 ? Math.min(progress.have / progress.need, 1) : null,
      };
    };

    return [
      weight,
      settled('HEART RATE', heartSignal, (value) => `${Math.round(value)} bpm`),
      settled('RESISTANCE', impedanceSignal, (value) => `${Math.round(value)} Ω`),
    ];
  });

  const canSave = $derived(
    !saving && (showScale ? reading != null : parsedManualWeight() != null),
  );

  function parsedManualWeight(): number | null {
    const raw = manualWeight.trim().replace(',', '.');
    if (!raw) return null;
    const value = Number(raw);
    const { max } = massRange(units);
    if (!Number.isFinite(value) || value <= 0 || value > max) return null;
    return Math.round(fromDisplayMass(value, units) * 1000) / 1000;
  }

  function parsedManualHeartRate(): number | null {
    const raw = manualHeartRate.trim();
    if (!raw) return null;
    const value = Math.round(Number(raw));
    return Number.isFinite(value) && value >= 20 && value <= 260 ? value : null;
  }

  function manualTimestamp(): string | null {
    if (!manualWhen) return new Date().toISOString();
    const at = new Date(manualWhen);
    if (Number.isNaN(at.getTime())) return null;
    return at.toISOString();
  }

  /** Wipe the previous attempt so its number can never be tapped as SAVE again. */
  function resetCapture() {
    clientStage = 'weigh';
    liveWeight = 0;
    liveHeartRate = null;
    liveOhms = null;
    lockedWeight = null;
    reading = null;
    capturedAt = null;
    deviceLabel = null;
    battery = null;
    errorMessage = null;
    settle = unsettle();
  }

  /** Must stay inside the tap: Web Bluetooth only opens its picker on a user gesture. */
  async function beginSession() {
    if (!client) return;
    resetCapture();
    void hapticLight();
    try {
      await client.start();
    } catch {
      // The client already moved to `error` and set the message.
    }
  }

  async function selectDevice(device: ScaleDevice) {
    if (!client) return;
    selectedId = device.id;
    resetCapture();
    void hapticLight();
    try {
      await client.connectTo(device);
    } catch {
      // Same: the client owns the message, and the sheet falls back to the board.
    }
  }

  function scanNow() {
    selectedId = null;
    void hapticLight();
    void client?.scan();
  }

  function cancelCapture() {
    client?.stop();
    resetCapture();
    void hapticLight();
  }

  /** REDO keeps the same scale on the board; only the capture is thrown away. */
  function redo() {
    client?.stop();
    resetCapture();
    selectedId = null;
    void hapticLight();
    void client?.scan();
  }

  async function save() {
    if (saving) return;
    let input: BodyReadingInput | null = null;

    if (showScale) {
      // Preview values are intentionally never savable; only a completed,
      // stable capture can reach this path.
      if (!reading || !captured) return;
      input = {
        weight_kg: captured.weight_kg,
        heart_rate: capturedHeartRate,
        impedance_ohms: capturedOhms,
        impedance_source: reading.impedanceSource ?? null,
        captured_version: CAPTURE_VERSION_STAGED,
        source: 'scale',
        device_label: deviceLabel,
        measured_at: capturedAt ?? new Date().toISOString(),
      };
    } else {
      const weight = parsedManualWeight();
      const when = manualTimestamp();
      if (weight == null || when == null) return;
      input = {
        id: editing?.id ?? null,
        weight_kg: weight,
        heart_rate: parsedManualHeartRate(),
        // A corrected scale row keeps what the hardware actually measured.
        impedance_ohms: editing?.impedance_ohms ?? null,
        impedance_source: editing?.impedance_source ?? null,
        captured_version: editing?.captured_version ?? null,
        source: editing?.source ?? 'manual',
        device_label: editing?.device_label ?? null,
        measured_at: when,
      };
    }

    saving = true;
    try {
      await onSave(input);
      client?.stop();
      void hapticSuccess();
      onDismiss();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Could not save the reading';
      void hapticWarning();
      playError();
    } finally {
      saving = false;
    }
  }

  function useManual() {
    manualChoice = true;
    void hapticLight();
  }

  function backToScale() {
    // `false`, not `null`: falling back to the default would re-read `startManual`
    // and bounce straight back into the form the user just asked to leave.
    manualChoice = false;
    resetCapture();
    void hapticLight();
    if (client?.canDiscover()) void client.scan();
  }

  const capturing = $derived(stage === 'choosing' || stage === 'connected' || stage === 'weighing');

  const view = $derived.by((): 'device' | 'capture' | 'result' => {
    if (reading) return 'result';
    if (capturing) return 'capture';
    return 'device';
  });

  const stageCopy = $derived.by(() => {
    if (stage === 'choosing') return 'Pick your scale in the dialog';
    if (stage === 'connected') return 'Connected. Step onto the scale.';
    if (stage === 'weighing') {
      if (clientStage === 'composition') return 'Hold still — measuring resistance.';
      if (clientStage === 'heart') return 'Hold still — finding your pulse.';
      return 'Hold still while the weight settles.';
    }
    if (stage === 'complete') return 'Reading captured';
    if (stage === 'error') return errorMessage ?? 'Could not read the scale';
    return transportKind === 'sim' ? 'Simulated scale ready' : 'Ready when you are';
  });

  const pickerLabel = $derived(
    transportKind === 'native'
      ? 'SYSTEM BLUETOOTH PICKER'
      : transportKind === 'sim'
        ? 'USE THE SIMULATED SCALE'
        : 'BROWSER DEVICE PICKER',
  );

  /** The manual form only exists to be typed into, so put the cursor there. */
  let manualWeightInput = $state<HTMLInputElement | null>(null);
  $effect(() => {
    if ((manual || manualOnly) && manualWeightInput) manualWeightInput.focus();
  });

  /** Every open starts clean: last time's number must never be tappable as SAVE again. */
  let wasOpen = $state(false);
  $effect(() => {
    const edge = open && !wasOpen;
    wasOpen = open;
    if (!edge) return;
    stage = 'idle';
    resetCapture();
    devices = [];
    scanning = false;
    selectedId = null;
    saving = false;
    manualChoice = null;
    if (editing) {
      manualWeight = toDisplayMass(editing.weight_kg, units).toFixed(1);
      manualHeartRate = editing.heart_rate != null ? String(editing.heart_rate) : '';
      manualWhen = toLocalInputValue(editing.measured_at);
    } else {
      manualWeight = '';
      manualHeartRate = '';
      manualWhen = toLocalInputValue(new Date().toISOString());
    }
  });

  const saveLabel = $derived(
    saving ? 'SAVING…' : editing ? 'UPDATE' : manual ? 'ADD' : 'SAVE',
  );
</script>

{#if open}
<div class="settings-panel-overlay" role="dialog" aria-modal="true" aria-label={editing ? 'Edit weigh-in' : 'Measure body composition'} tabindex="-1" transition:fade={{ duration: OVERLAY_MS }}>
  <div class="settings-panel-dialog measure-sheet rounded-xl border border-app-outline-subtle bg-app-surface-1 shadow-xl overflow-hidden text-left" in:menuPanelIn out:menuPanelOut>
    <div class="settings-panel-header">
      <div class="settings-panel-header__title">
        <span class="text-app-caption font-medium tracking-[0.14em] text-app-fg-secondary leading-none">
          {editing ? 'EDIT WEIGH-IN' : manual ? 'ADD WEIGH-IN' : view === 'result' ? 'WEIGH-IN' : 'MEASURE'}
        </span>
      </div>
      <div class="flex items-center gap-2">
        {#if deviceLabel && showScale}
          <span class="measure-sheet__chip" title="Connected scale">{deviceLabel}</span>
        {/if}
        {#if battery != null && showScale}
          <span class="measure-sheet__chip" title="Scale battery">{battery}%</span>
        {/if}
        <button type="button" aria-label="Close" class="settings-panel-header__close" onclick={onDismiss} disabled={saving}>
          <X class="app-icon-small" />
        </button>
      </div>
    </div>

    <div class="settings-panel-body">
      {#if manual}
        <div class="manual-form">
          {#if !supported && unsupportedReason}
            <p class="measure-sheet__note">{unsupportedReason}</p>
          {:else if editing}
            <p class="measure-sheet__note">
              Correcting the {editing.source === 'scale' ? editing.device_label ?? 'scale' : 'manual'} reading from
              {formatMeasuredAt(editing.measured_at)}.
            </p>
          {/if}
          <label class="manual-field">
            <span class="manual-field__label">WEIGHT ({massUnit(units)})</span>
            <input
              type="text"
              inputmode="decimal"
              autocomplete="off"
              placeholder="0.0"
              bind:value={manualWeight}
              bind:this={manualWeightInput}
              class="manual-field__input"
            />
          </label>
          <label class="manual-field">
            <span class="manual-field__label">HEART RATE (bpm, optional)</span>
            <input
              type="text"
              inputmode="numeric"
              autocomplete="off"
              placeholder="—"
              bind:value={manualHeartRate}
              class="manual-field__input"
            />
          </label>
          <label class="manual-field">
            <span class="manual-field__label">WHEN</span>
            <input type="datetime-local" bind:value={manualWhen} class="manual-field__input" />
          </label>
          {#if manualWeight && parsedManualWeight() == null}
            <p class="measure-sheet__alert">Enter a weight between 0 and {massRange(units).max} {massUnit(units)}.</p>
          {/if}
          <div class="measure-sheet__actions">
            {#if !manualOnly}
              <button type="button" class="measure-sheet__ghost" onclick={backToScale}>
                <Bluetooth class="app-icon-small" />
                <span>USE SCALE</span>
              </button>
            {/if}
            <button type="button" class="measure-sheet__primary" onclick={save} disabled={!canSave}>
              {saveLabel}
            </button>
          </div>
        </div>
      {:else if view === 'device'}
        <div class="measure-devices">
          {#if errorMessage}
            <p class="measure-sheet__alert measure-devices__error">{errorMessage}</p>
          {/if}
          <ScaleDeviceList {devices} {scanning} {connectable} {selectedId} onSelect={selectDevice} onScan={scanNow} />
          <button type="button" class="device-picker-fallback" onclick={beginSession}>
            <Bluetooth class="app-icon-small" />
            <span>{pickerLabel}</span>
          </button>
          <button type="button" class="measure-sheet__manual-link" onclick={useManual}>
            Can’t connect? <span>Enter it by hand</span>
          </button>
        </div>
      {:else if view === 'capture'}
        <div class="measure-readout">
          <div class="measure-readout__weight font-7segment" class:measure-readout__weight--live={lockedWeight == null}>
            {displayWeight}
            <span class="measure-readout__unit">{massUnit(units)}</span>
          </div>
          <p class="measure-readout__status" class:measure-readout__status--error={stage === 'error'} role="status" aria-live="polite">{stageCopy}</p>

          <div class="measure-phases">
            {#each phases as phase (phase.label)}
              <div class="measure-phase" data-state={phase.state}>
                <span class="measure-phase__label">{phase.label}</span>
                <span class="measure-phase__track" aria-hidden="true">
                  {#if phase.pct == null}
                    <i class="measure-phase__bar measure-phase__bar--seeking"></i>
                  {:else}
                    <i class="measure-phase__bar" style="width: {Math.round(phase.pct * 100)}%"></i>
                  {/if}
                </span>
                <span class="measure-phase__text">{phase.text}</span>
              </div>
            {/each}
          </div>

          <div class="measure-sheet__actions">
            <button type="button" class="measure-sheet__ghost" onclick={cancelCapture}>
              <span>CANCEL</span>
            </button>
          </div>
        </div>
      {:else}
        <div class="measure-result">
          <div class="measure-readout__weight font-7segment">{displayWeight}<span class="measure-readout__unit">{massUnit(units)}</span></div>
          <p class="measure-result__summary" role="status">{resultSummary}</p>

          {#if heartSignal.value != null && reading?.heartRate == null}
            <p class="measure-sheet__note">The pulse the scale flashed ({Math.round(heartSignal.value)} bpm) never repeated enough times to be trusted.</p>
          {/if}

          {#if results.length}
            <div class="metric-grid">
              {#each results as row (row.key)}
                <div class="metric-cell" title={row.metric.hint} class:metric-cell--void={row.text === 'not sent'}>
                  <span class="metric-cell__label">{row.metric.label}</span>
                  <strong class="metric-cell__value tabular-nums">{row.text}</strong>
                  {#if row.text !== 'not sent'}
                    <em class="metric-cell__tier" data-tier={row.tier} title={TIER_HINT[row.tier]}>{TIER_LABEL[row.tier]}</em>
                  {/if}
                </div>
              {/each}
            </div>
            <div class="tier-legend">
              {#each TIERS as tier (tier)}
                <span class="tier-legend__chip" data-tier={tier} title={TIER_HINT[tier]}>{TIER_LABEL[tier]}</span>
              {/each}
              <span class="tier-legend__note">how each number was produced</span>
            </div>
          {/if}

          {#if !profileReady}
            <button type="button" class="measure-sheet__nudge" onclick={onEditProfile}>
              <span>Enter sex, date of birth, and height to estimate BMI, body fat, water, and BMR.</span>
              <ChevronRight class="app-icon-small" />
            </button>
          {/if}

          <div class="measure-sheet__actions">
            <button type="button" class="measure-sheet__ghost" onclick={redo}>
              <RefreshCw class="app-icon-small" />
              <span>REDO</span>
            </button>
            <button type="button" class="measure-sheet__primary" onclick={save} disabled={!canSave}>
              {saveLabel}
            </button>
          </div>

          <button type="button" class="measure-sheet__manual-link" onclick={useManual}>
            Numbers look wrong? <span>Enter them by hand</span>
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>
{/if}

<style>
  .measure-sheet {
    width: min(94vw, 28rem);
  }

  .measure-sheet__chip {
    max-width: 9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid var(--app-outline-subtle);
    background: var(--app-surface-0);
    border-radius: 999px;
    padding: var(--space-0-5) var(--space-2);
    font-size: var(--type-micro);
    letter-spacing: 0.06em;
    color: var(--app-fg-secondary);
  }

  .measure-sheet__actions {
    display: flex;
    align-items: stretch;
    gap: var(--space-2);
    margin-top: var(--space-3);
    width: 100%;
  }

  .measure-sheet__primary,
  .measure-sheet__ghost {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1-5);
    height: 2.25rem;
    flex: 1;
    border-radius: var(--app-radius-compact);
    font-size: var(--type-micro);
    font-weight: 500;
    letter-spacing: 0.08em;
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
  }

  .measure-sheet__primary {
    border: 1px solid var(--app-outline);
    background: #fff;
    color: #000;
  }

  .measure-sheet__primary:hover:not(:disabled) {
    background: #e4e4e7;
  }

  .measure-sheet__primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .measure-sheet__ghost {
    border: 1px solid var(--app-outline-subtle);
    background: transparent;
    color: var(--app-fg-secondary);
  }

  .measure-sheet__ghost:hover {
    background: var(--app-surface-2);
    color: #fff;
  }

  .measure-sheet__note {
    margin-top: var(--space-2-5);
    font-size: var(--type-micro);
    line-height: 1.45;
    color: var(--app-fg-secondary);
    border: 1px dashed var(--app-outline-subtle);
    border-radius: var(--app-radius-compact);
    padding: var(--space-1-5) var(--space-2);
    background: var(--app-surface-0);
  }

  .measure-sheet__alert {
    font-size: var(--type-micro);
    line-height: 1.45;
    color: #fca5a5;
  }

  .measure-sheet__nudge {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    width: 100%;
    margin-top: var(--space-2-5);
    padding: var(--space-2) var(--space-2-5);
    border: 1px solid var(--app-outline-subtle);
    border-radius: var(--app-radius-compact);
    background: var(--app-surface-0);
    font-size: var(--type-micro);
    line-height: 1.4;
    color: var(--app-fg-secondary-strong);
    text-align: left;
  }

  .measure-sheet__nudge:hover {
    border-color: var(--app-outline-strong);
    color: #fff;
  }

  .measure-sheet__manual-link {
    display: block;
    width: 100%;
    margin-top: var(--space-2);
    font-size: var(--type-micro);
    color: var(--app-fg-muted);
    text-align: center;
  }

  .measure-sheet__manual-link span {
    color: var(--app-fg-secondary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .measure-sheet__manual-link:hover span {
    color: #fff;
  }

  .measure-devices {
    display: flex;
    flex-direction: column;
    padding-top: var(--space-1);
  }

  .measure-devices__error {
    margin-bottom: var(--space-2-5);
  }

  .device-picker-fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1-5);
    width: 100%;
    height: 2.1rem;
    margin-top: var(--space-2);
    border: 1px dashed var(--app-outline-subtle);
    border-radius: var(--app-radius-compact);
    background: transparent;
    font-size: var(--type-micro);
    font-weight: 500;
    letter-spacing: 0.08em;
    color: var(--app-fg-muted);
    transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
  }

  .device-picker-fallback:hover {
    background: var(--app-surface-2);
    color: #fff;
    border-color: var(--app-outline-strong);
  }

  .measure-readout {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1-5);
    padding: var(--space-3) 0 var(--space-1);
  }

  .measure-readout__weight {
    display: flex;
    align-items: baseline;
    gap: var(--space-1-5);
    font-size: 3.25rem;
    line-height: 1;
    color: var(--app-fg-primary);
    font-variant-numeric: tabular-nums;
  }

  .measure-readout__weight--live {
    color: #4ade80;
  }

  .measure-readout__unit {
    font-size: var(--type-body);
    color: var(--app-fg-muted);
    letter-spacing: 0.08em;
  }

  .measure-readout__status {
    font-size: var(--type-micro);
    letter-spacing: 0.08em;
    color: var(--app-fg-secondary);
    text-align: center;
  }

  .measure-readout__status--error {
    color: #fca5a5;
  }

  .measure-phases {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    margin-top: var(--space-3);
    background: var(--app-outline-subtle);
    border: 1px solid var(--app-outline-subtle);
    border-radius: var(--app-radius-compact);
    overflow: hidden;
  }

  .measure-phase {
    display: grid;
    grid-template-columns: 5.5rem 1fr auto;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-2-5);
    background: var(--app-surface-0);
  }

  .measure-phase__label {
    font-size: var(--type-micro);
    letter-spacing: 0.12em;
    color: var(--app-fg-disabled);
  }

  .measure-phase[data-state='locked'] .measure-phase__label {
    color: var(--app-fg-secondary);
  }

  .measure-phase__track {
    height: 3px;
    border-radius: 999px;
    background: var(--app-surface-3);
    overflow: hidden;
  }

  .measure-phase__bar {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--app-fg-disabled);
    transition: width 180ms ease;
  }

  .measure-phase[data-state='collecting'] .measure-phase__bar {
    background: #4ade80;
  }

  .measure-phase[data-state='locked'] .measure-phase__bar {
    background: #65e6ac;
  }

  .measure-phase__bar--seeking {
    width: 40%;
    animation: measure-phase-seek 1.1s ease-in-out infinite alternate;
  }

  @keyframes measure-phase-seek {
    from { transform: translateX(0); }
    to { transform: translateX(150%); }
  }

  .measure-phase__text {
    font-size: var(--type-micro);
    letter-spacing: 0.04em;
    color: var(--app-fg-muted);
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }

  .measure-phase[data-state='locked'] .measure-phase__text {
    color: #7ee0ab;
  }

  .measure-result {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1-5);
    padding: var(--space-3) 0 var(--space-1);
  }

  .measure-result__summary {
    font-size: var(--type-micro);
    letter-spacing: 0.06em;
    color: var(--app-fg-secondary);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1px;
    width: 100%;
    margin-top: var(--space-3);
    background: var(--app-outline-subtle);
    border: 1px solid var(--app-outline-subtle);
    border-radius: var(--app-radius-compact);
    overflow: hidden;
  }

  .metric-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) var(--space-2-5);
    background: var(--app-surface-0);
  }

  .metric-cell__label {
    font-size: var(--type-micro);
    letter-spacing: 0.12em;
    color: var(--app-fg-disabled);
  }

  .metric-cell__value {
    font-size: var(--type-body);
    font-weight: 500;
    color: var(--app-fg-primary);
    font-variant-numeric: tabular-nums;
  }

  .metric-cell--void .metric-cell__value {
    font-size: var(--type-caption);
    font-weight: 400;
    color: var(--app-fg-disabled);
  }

  .metric-cell__tier {
    font-style: normal;
    font-size: 0.625rem;
    letter-spacing: 0.1em;
    color: var(--app-fg-muted);
  }

  .metric-cell__tier[data-tier='measured'] {
    color: #7ee0ab;
  }

  .metric-cell__tier[data-tier='bia'] {
    color: #93b4f5;
  }

  .tier-legend {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    margin-top: var(--space-2);
    font-size: var(--type-micro);
    color: var(--app-fg-disabled);
  }

  .tier-legend__chip {
    border: 1px solid var(--app-outline-subtle);
    border-radius: var(--app-radius-pill);
    padding: 1px var(--space-2);
    letter-spacing: 0.1em;
    color: var(--app-fg-muted);
  }

  .tier-legend__chip[data-tier='measured'] {
    color: #7ee0ab;
    border-color: rgb(101 230 172 / 0.35);
  }

  .tier-legend__chip[data-tier='bia'] {
    color: #93b4f5;
    border-color: rgb(147 180 245 / 0.35);
  }

  .tier-legend__note {
    letter-spacing: 0.04em;
  }

  .manual-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2-5);
    padding-top: var(--space-1);
  }

  .manual-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .manual-field__label {
    font-size: var(--type-micro);
    letter-spacing: 0.12em;
    color: var(--app-fg-disabled);
  }

  .manual-field__input {
    height: 2.25rem;
    border: 1px solid var(--app-outline-subtle);
    border-radius: var(--app-radius-compact);
    background: var(--app-canvas);
    padding: 0 var(--space-2-5);
    font-size: var(--type-caption);
    color: #fff;
    outline: none;
    font-variant-numeric: tabular-nums;
  }

  .manual-field__input:focus {
    border-color: var(--app-outline-strong);
  }

  @media (prefers-reduced-motion: reduce) {
    .measure-phase__bar--seeking {
      animation: none;
      width: 100%;
      opacity: 0.4;
    }
  }
</style>
