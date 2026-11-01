<script lang="ts">
  import { fade } from 'svelte/transition';
  import { X, RefreshCw, Bluetooth, Scale, Activity, ChevronRight } from '@lucide/svelte';
  import { createScaleClient } from '$lib/scale';
  import { menuPanelIn, menuPanelOut, OVERLAY_MS } from '$lib/menuTransitions';
  import type { ScaleClientState } from '$lib/scale/client';
  import type { ScaleReading } from '$lib/scale/session';
  import { canDerive, deriveReading } from '$lib/bodyComp';
  import { formatMeasuredAt, toLocalInputValue } from '$lib/bodyHistory';
  import { ageFromDob, ageYearsDecimal } from '$lib/age';
  import { formatBodyMass, massUnit, massRange, toDisplayMass, fromDisplayMass, type BodyUnits } from '$lib/units';
  import type { BodyProfile, BodyReading, BodyReadingInput } from '$lib/bodySanitize';
  import { hapticLight, hapticMedium, hapticSuccess, hapticWarning } from '$lib/haptics';
  import { playError, playSetLogged } from '$lib/sounds';

  /**
   * One weigh-in, start to finish.
   *
   * The whole point is that the user never has to think about Bluetooth: tap MEASURE,
   * step on, hold still, get a number. Every way a session can end — heart rate
   * converged, stepped off early, scale powered itself off, 30 s elapsed, a link drop,
   * a wrong device, a declined permission — lands somewhere with a way forward, and
   * manual entry is always one tap away for the days the scale refuses to cooperate.
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
  let liveWeight = $state(0);
  let liveHeartRate = $state<number | null>(null);
  let lockedWeight = $state<number | null>(null);
  let reading = $state<ScaleReading | null>(null);
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

  const transportKind = $derived(client?.transportKind ?? 'web');
  const supported = $derived(client ? client.supported() : true);
  const unsupportedReason = $derived(client?.unsupportedReason() ?? null);

  /** Manual entry is forced when the build cannot reach Bluetooth, or to correct a stored row. */
  const manualOnly = $derived(!supported || editing != null);
  const manual = $derived(manualChoice ?? (manualOnly || startManual));

  $effect(() => {
    if (!open) return;
    const instance = createScaleClient();
    client = instance;
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
      instance.on('live', (frame) => {
        liveWeight = frame.weightKg;
        if (frame.heartRate != null) liveHeartRate = frame.heartRate;
      }),
      instance.on('locked', (locked) => {
        lockedWeight = locked.weightKg;
        void hapticMedium();
        playSetLogged();
      }),
      instance.on('measuring', (tick) => {
        liveHeartRate = tick.heartRate;
      }),
      instance.on('complete', (finished) => {
        reading = finished;
        void hapticSuccess();
        playSetLogged();
      }),
      instance.on('error', (err) => {
        errorMessage = err.message || 'Could not read the scale';
      }),
    ];
    return () => {
      for (const dispose of off) dispose();
      instance.dispose();
      client = null;
    };
  });

  /** The final number, whichever path produced it. */
  const capturedKg = $derived(reading?.weightKg ?? lockedWeight ?? liveWeight ?? 0);
  const capturedHeartRate = $derived(reading?.heartRate ?? liveHeartRate);
  const capturedImpedance = $derived(reading?.impedanceRaw ?? null);

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

  const preview = $derived.by(() => {
    if (capturedKg <= 0 || !profileReady) return null;
    return deriveReading({
      weightKg: capturedKg,
      impedanceRaw: capturedImpedance,
      sex: profile.sex,
      heightCm: profile.height_cm,
      ageYears,
    });
  });

  /** Why the session ended, in the user's terms — never a raw protocol reason. */
  const reasonNote = $derived.by(() => {
    if (!reading) return null;
    if (reading.reason === 'hr-stable') return null;
    if (reading.reason === 'stepped-off') return 'You stepped off before the heart rate finished — the weight is still exact.';
    if (reading.reason === 'disconnect') return 'The scale switched itself off — saved what it had measured.';
    if (reading.reason === 'idle' || reading.reason === 'timeout') return 'The scale stopped sending new numbers — saved the last one.';
    return null;
  });

  const canSave = $derived(
    !saving && (showScale ? capturedKg > 0 : parsedManualWeight() != null),
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

  async function beginSession() {
    if (!client) return;
    reading = null;
    lockedWeight = null;
    liveWeight = 0;
    liveHeartRate = null;
    errorMessage = null;
    deviceLabel = null;
    battery = null;
    void hapticLight();
    try {
      // Must stay inside the tap: Web Bluetooth only opens its picker on a user gesture.
      await client.start();
    } catch {
      // The client already moved to `error` and set the message.
    }
  }

  async function retry() {
    client?.stop();
    reading = null;
    errorMessage = null;
    await beginSession();
  }

  async function save() {
    if (saving) return;
    let input: BodyReadingInput | null = null;

    if (showScale) {
      if (capturedKg <= 0) return;
      input = {
        weight_kg: Math.round(capturedKg * 1000) / 1000,
        heart_rate: capturedHeartRate,
        impedance_raw: capturedImpedance,
        source: 'scale',
        device_label: deviceLabel,
        measured_at: new Date().toISOString(),
      };
    } else {
      const weight = parsedManualWeight();
      const when = manualTimestamp();
      if (weight == null || when == null) return;
      input = {
        id: editing?.id ?? null,
        weight_kg: weight,
        heart_rate: parsedManualHeartRate(),
        // A corrected scale row keeps the impedance the hardware actually measured.
        impedance_raw: editing?.impedance_raw ?? null,
        source: editing?.source ?? 'manual',
        device_label: editing?.device_label ?? null,
        measured_at: when,
      };
    }

    saving = true;
    try {
      await onSave(input);
      client?.stop('manual');
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
    manualChoice = false;
    void hapticLight();
  }

  const stageCopy = $derived.by(() => {
    if (stage === 'choosing') return 'Pick your scale in the dialog';
    if (stage === 'connected') return 'Step on the scale — hold still';
    if (stage === 'weighing') return 'Hold still — settling';
    if (stage === 'measuring') return 'Weight locked — measuring heart rate';
    if (stage === 'complete') return 'Reading captured';
    if (stage === 'error') return errorMessage ?? 'Could not read the scale';
    return transportKind === 'sim' ? 'Simulated scale connected' : 'Ready when you are';
  });

  const busy = $derived(stage === 'choosing' || stage === 'connected' || stage === 'weighing' || stage === 'measuring');

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
    liveWeight = 0;
    liveHeartRate = null;
    lockedWeight = null;
    reading = null;
    deviceLabel = null;
    battery = null;
    errorMessage = null;
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
    saving ? 'SAVING…' : editing ? 'UPDATE' : manual || manualOnly ? 'ADD' : 'SAVE',
  );
</script>

{#if open}
<div class="settings-panel-overlay" role="dialog" aria-modal="true" aria-label={editing ? 'Edit weigh-in' : 'Measure body composition'} tabindex="-1" transition:fade={{ duration: OVERLAY_MS }}>
  <div class="settings-panel-dialog measure-sheet rounded-xl border border-[#1e1e1e] bg-[#141414] shadow-xl overflow-hidden text-left" in:menuPanelIn out:menuPanelOut>
    <div class="settings-panel-header">
      <div class="settings-panel-header__title">
        <span class="text-[11px] font-medium tracking-[0.14em] text-zinc-400 leading-none">
          {editing ? 'EDIT WEIGH-IN' : manual || manualOnly ? 'ADD WEIGH-IN' : 'MEASURE'}
        </span>
      </div>
      <div class="flex items-center gap-2">
        {#if deviceLabel && !manual && !manualOnly}
          <span class="measure-sheet__chip" title="Connected scale">{deviceLabel}</span>
        {/if}
        {#if battery != null && !manual && !manualOnly}
          <span class="measure-sheet__chip">{battery}%</span>
        {/if}
        <button type="button" aria-label="Close" class="settings-panel-header__close" onclick={onDismiss} disabled={saving}>
          <X class="size-3.5" />
        </button>
      </div>
    </div>

    <div class="settings-panel-body">
      {#if manual || manualOnly}
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
                <Bluetooth class="size-3.5" />
                <span>USE SCALE</span>
              </button>
            {/if}
            <button type="button" class="measure-sheet__primary" onclick={save} disabled={!canSave}>
              {saveLabel}
            </button>
          </div>
        </div>
      {:else}
        <div class="measure-readout" data-stage={stage}>
          <div class="measure-readout__weight font-7segment" class:measure-readout__weight--live={busy}>
            {displayWeight}
            <span class="measure-readout__unit">{massUnit(units)}</span>
          </div>
          {#if capturedHeartRate != null && stage !== 'idle'}
            <div class="measure-readout__hr">
              <Activity class="size-3.5" />
              <span class="tabular-nums">{capturedHeartRate} bpm</span>
            </div>
          {/if}
          <p class="measure-readout__status" class:measure-readout__status--error={stage === 'error'}>{stageCopy}</p>

          {#if stage === 'connected' || stage === 'weighing' || stage === 'measuring'}
            <div class="measure-readout__spinner" aria-hidden="true">
              <RefreshCw class="size-3.5 animate-spin" />
              <span>{stage === 'measuring' ? 'Counting pulses' : 'Listening for the scale'}</span>
            </div>
          {/if}

          {#if reasonNote}
            <p class="measure-sheet__note">{reasonNote}</p>
          {/if}

          {#if preview}
            <div class="measure-preview">
              <div class="measure-preview__cell"><span>BMI</span><strong class="tabular-nums">{preview.bmi ?? '—'}</strong></div>
              <div class="measure-preview__cell"><span>BODY FAT</span><strong class="tabular-nums">{preview.bodyFatPct != null ? `${preview.bodyFatPct}%` : '—'}</strong></div>
              <div class="measure-preview__cell"><span>LEAN</span><strong class="tabular-nums">{formatBodyMass(preview.ffmKg, units)}</strong></div>
              <div class="measure-preview__cell"><span>WATER</span><strong class="tabular-nums">{preview.bodyWaterPct != null ? `${preview.bodyWaterPct}%` : '—'}</strong></div>
              <div class="measure-preview__cell"><span>BMR</span><strong class="tabular-nums">{preview.bmrKcal != null ? `${preview.bmrKcal}` : '—'}</strong></div>
              {#if preview.smmKg != null}
                <div class="measure-preview__cell"><span>MUSCLE</span><strong class="tabular-nums">{formatBodyMass(preview.smmKg, units)}</strong></div>
              {:else}
                <div class="measure-preview__cell measure-preview__cell--muted"><span>MUSCLE</span><strong>needs Ω</strong></div>
              {/if}
            </div>
          {:else if capturedKg > 0 && !profileReady}
            <button type="button" class="measure-sheet__nudge" onclick={onEditProfile}>
              <span>Add sex, birthday and height to unlock BMI, body fat, water and BMR</span>
              <ChevronRight class="size-3.5" />
            </button>
          {/if}

          <div class="measure-sheet__actions">
            {#if stage === 'idle' || stage === 'error'}
              <button type="button" class="measure-sheet__primary" onclick={beginSession}>
                <Scale class="size-4" />
                <span>{stage === 'error' ? 'TRY AGAIN' : 'STEP ON'}</span>
              </button>
            {:else if busy}
              <button type="button" class="measure-sheet__ghost" onclick={() => { client?.stop(); void hapticLight(); }}>
                <span>CANCEL</span>
              </button>
            {:else if reading}
              <button type="button" class="measure-sheet__ghost" onclick={retry}>
                <RefreshCw class="size-3.5" />
                <span>REDO</span>
              </button>
              <button type="button" class="measure-sheet__primary" onclick={save} disabled={saving}>
                {saveLabel}
              </button>
            {:else}
              <button type="button" class="measure-sheet__primary" onclick={beginSession}>
                <Scale class="size-4" />
                <span>STEP ON</span>
              </button>
            {/if}
          </div>

          <button type="button" class="measure-sheet__manual-link" onclick={useManual}>
            Can’t connect? <span>Enter it by hand</span>
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>
{/if}

<style>
  .measure-sheet {
    width: min(94vw, 26rem);
  }

  .measure-sheet__chip {
    max-width: 9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid #1e1e1e;
    background: #0d0d0d;
    border-radius: 999px;
    padding: 0.125rem 0.5rem;
    font-size: 9px;
    letter-spacing: 0.06em;
    color: #a1a1aa;
  }

  .measure-sheet__actions {
    display: flex;
    align-items: stretch;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .measure-sheet__primary,
  .measure-sheet__ghost {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    height: 2.25rem;
    flex: 1;
    border-radius: 0.375rem;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.08em;
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
  }

  .measure-sheet__primary {
    border: 1px solid #2a2a2a;
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
    border: 1px solid #1e1e1e;
    background: transparent;
    color: #a1a1aa;
  }

  .measure-sheet__ghost:hover {
    background: #1a1a1a;
    color: #fff;
  }

  .measure-sheet__note {
    margin-top: 0.6rem;
    font-size: 10px;
    line-height: 1.45;
    color: #a1a1aa;
    border: 1px dashed #1e1e1e;
    border-radius: 0.375rem;
    padding: 0.4rem 0.5rem;
    background: #0d0d0d;
  }

  .measure-sheet__alert {
    margin-top: 0.5rem;
    font-size: 10px;
    color: #fca5a5;
  }

  .measure-sheet__nudge {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    margin-top: 0.6rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid #1e1e1e;
    border-radius: 0.375rem;
    background: #0d0d0d;
    font-size: 10px;
    line-height: 1.4;
    color: #d4d4d8;
    text-align: left;
  }

  .measure-sheet__nudge:hover {
    border-color: #3a3a3a;
    color: #fff;
  }

  .measure-sheet__manual-link {
    display: block;
    width: 100%;
    margin-top: 0.5rem;
    font-size: 10px;
    color: #71717a;
    text-align: center;
  }

  .measure-sheet__manual-link span {
    color: #a1a1aa;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .measure-sheet__manual-link:hover span {
    color: #fff;
  }

  .measure-readout {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    padding: 0.75rem 0 0.25rem;
  }

  .measure-readout__weight {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    font-size: 3.25rem;
    line-height: 1;
    color: #fafafa;
    font-variant-numeric: tabular-nums;
  }

  .measure-readout__weight--live {
    color: #4ade80;
  }

  .measure-readout__unit {
    font-size: 0.875rem;
    color: #71717a;
    letter-spacing: 0.08em;
  }

  .measure-readout__hr {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 11px;
    color: #f87171;
  }

  .measure-readout__status {
    font-size: 10px;
    letter-spacing: 0.08em;
    color: #a1a1aa;
    text-align: center;
  }

  .measure-readout__status--error {
    color: #fca5a5;
  }

  .measure-readout__spinner {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 9px;
    letter-spacing: 0.1em;
    color: #52525b;
  }

  .measure-preview {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    width: 100%;
    margin-top: 0.75rem;
    background: #1e1e1e;
    border: 1px solid #1e1e1e;
    border-radius: 0.375rem;
    overflow: hidden;
  }

  .measure-preview__cell {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.4rem 0.5rem;
    background: #0d0d0d;
  }

  .measure-preview__cell span {
    font-size: 8px;
    letter-spacing: 0.12em;
    color: #52525b;
  }

  .measure-preview__cell strong {
    font-size: 12px;
    font-weight: 500;
    color: #e4e4e7;
  }

  .measure-preview__cell--muted strong {
    color: #52525b;
  }

  .manual-form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding-top: 0.25rem;
  }

  .manual-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .manual-field__label {
    font-size: 9px;
    letter-spacing: 0.12em;
    color: #52525b;
  }

  .manual-field__input {
    height: 2.25rem;
    border: 1px solid #1e1e1e;
    border-radius: 0.375rem;
    background: #060606;
    padding: 0 0.6rem;
    font-size: 13px;
    color: #fff;
    outline: none;
    font-variant-numeric: tabular-nums;
  }

  .manual-field__input:focus {
    border-color: #3a3a3a;
  }
</style>
