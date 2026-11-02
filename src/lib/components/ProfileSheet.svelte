<script lang="ts">
  import { fade } from 'svelte/transition';
  import { X, Check, Cake, Ruler, Flame } from '@lucide/svelte';
  import { menuPanelIn, menuPanelOut, OVERLAY_MS } from '$lib/menuTransitions';
  import type { BodyProfile, BodyProfileInput } from '$lib/bodySanitize';
  import { ageFromDob, ageYearsDecimal, dobBounds, formatAge } from '$lib/age';
  import { ACTIVITY_LEVELS, canDerive, type Activity, type Sex } from '$lib/bodyComp';
  import {
    formatHeight,
    fromDisplayHeight,
    heightUnit,
    toDisplayHeight,
    type BodyUnits,
  } from '$lib/units';
  import { hapticLight, hapticSuccess, hapticWarning } from '$lib/haptics';
  import { playError, playSetLogged } from '$lib/sounds';

  /**
   * The four inputs every derived metric can use.
   *
   * Only the birth date is stored, never the age, so the number stays correct on its
   * own: nothing to re-enter on a birthday and nothing to drift if the app sits closed
   * for a month. Everything is optional by design; a missing field costs the metrics
   * that depend on it and the sheet says exactly which, rather than refusing to save.
   */
  let {
    open = $bindable(false),
    profile,
    units = 'metric' as BodyUnits,
    onboarding = false,
    onDismiss = () => {},
    onSave = async (_input: BodyProfileInput) => {},
  }: {
    /** Kept mounted by the page so the close transition can run. */
    open?: boolean;
    profile: BodyProfile;
    units?: BodyUnits;
    /** First-run copy + a way out, instead of a modal that must be filled in. */
    onboarding?: boolean;
    onDismiss?: () => void;
    onSave?: (input: BodyProfileInput) => Promise<void> | void;
  } = $props();

  const SEXES: { value: Sex; label: string }[] = [
    { value: 'male', label: 'MALE' },
    { value: 'female', label: 'FEMALE' },
    { value: 'other', label: 'OTHER' },
  ];

  // Blank until the sheet is opened — the open-edge effect below is what fills
  // these from the profile, so a refresh can never clobber half-typed values.
  let sex = $state<Sex | null>(null);
  let dob = $state('');
  let heightText = $state('');
  let activity = $state<Activity | null>(null);
  let saving = $state(false);
  let errorMessage = $state<string | null>(null);

  const bounds = dobBounds();

  function round1(value: number): number {
    return Math.round(value * 10) / 10;
  }

  /** Refill on the open edge only, so a background profile refresh cannot wipe what is being typed. */
  let wasOpen = $state(false);
  $effect(() => {
    const edge = open && !wasOpen;
    wasOpen = open;
    if (!edge) return;
    sex = profile.sex;
    dob = profile.date_of_birth ?? '';
    heightText =
      profile.height_cm != null ? String(round1(toDisplayHeight(profile.height_cm, units))) : '';
    activity = profile.activity;
    saving = false;
    errorMessage = null;
  });

  const age = $derived(ageFromDob(dob));
  const heightCm = $derived.by(() => {
    const raw = heightText.trim().replace(',', '.');
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    const cm = round1(fromDisplayHeight(value, units));
    return cm >= 30 && cm <= 280 ? cm : null;
  });

  const heightInvalid = $derived(heightText.trim() !== '' && heightCm == null);
  const dobInvalid = $derived(dob !== '' && age == null);

  const ready = $derived(
    canDerive({ sex, heightCm, ageYears: ageYearsDecimal(age) }),
  );

  /**
   * Which inputs are in place. Every metric is always calculated and shown — tagged
   * SCALE / BIA / DERIVED for provenance — so a missing field does not hide a row, it
   * only costs the accuracy of the numbers that would have used it.
   */
  const inputs = $derived.by((): { label: string; ok: boolean; note: string }[] => {
    return [
      { label: 'SEX', ok: sex != null, note: 'Body-fat, water, muscle and bone formulas branch on it' },
      { label: 'DATE OF BIRTH', ok: age != null, note: 'Age at each weigh-in, so history stays correct' },
      { label: 'HEIGHT', ok: heightCm != null, note: 'BMI, impedance-based lean mass, visceral fat' },
      { label: 'ACTIVITY LEVEL', ok: activity != null, note: 'Daily-calorie target (TDEE) — nothing else' },
    ];
  });

  const canSave = $derived(
    !saving &&
      !heightInvalid &&
      !dobInvalid &&
      (sex != null || dob !== '' || heightText.trim() !== '' || activity != null),
  );

  async function save() {
    if (!canSave) return;
    saving = true;
    errorMessage = null;
    try {
      await onSave({ sex, date_of_birth: dob || null, height_cm: heightCm, activity });
      void hapticSuccess();
      playSetLogged();
      onDismiss();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Could not save your profile';
      void hapticWarning();
      playError();
    } finally {
      saving = false;
    }
  }

  function pickSex(value: Sex) {
    // Tapping the current choice again clears it: no third-state trap for a
    // mis-click, and an unset sex is a real answer some users want.
    sex = sex === value ? null : value;
    void hapticLight();
  }

  function pickActivity(value: Activity) {
    activity = activity === value ? null : value;
    void hapticLight();
  }
</script>

{#if open}
<div
  class="settings-panel-overlay"
  role="dialog"
  aria-modal="true"
  aria-label="Body profile"
  tabindex="-1"
  transition:fade={{ duration: OVERLAY_MS }}
>
  <div class="settings-panel-dialog profile-sheet rounded-xl border border-app-outline-subtle bg-app-surface-1 shadow-xl overflow-hidden text-left" in:menuPanelIn out:menuPanelOut>
    <div class="settings-panel-header">
      <div class="settings-panel-header__title">
        <span class="text-app-caption font-medium tracking-[0.14em] text-app-fg-secondary leading-none">BODY PROFILE</span>
      </div>
      <button
        type="button"
        aria-label="Close"
        class="settings-panel-header__close"
        disabled={saving}
        onclick={onDismiss}
      >
        <X class="app-icon-small" />
      </button>
    </div>

    <div class="settings-panel-body flex flex-col gap-3">
      <p class="text-app-micro leading-snug text-app-fg-muted">
        {onboarding
          ? 'Sex, birthday, height and activity level feed the derived metrics and your daily-calorie target. Only you can read these profile details.'
          : 'Age is calculated from your date of birth for each measurement.'}
      </p>

      <!-- Sex -->
      <div class="flex flex-col gap-1.5">
        <span class="profile-field__label">SEX</span>
        <div class="grid grid-cols-3 gap-1.5" role="group" aria-label="Sex">
          {#each SEXES as option (option.value)}
            {@const on = sex === option.value}
            <button
              type="button"
              role="radio"
              aria-checked={on}
              class="profile-choice"
              class:profile-choice--on={on}
              onclick={() => pickSex(option.value)}
            >
              {#if on}<Check class="app-icon-small" />{/if}
              <span>{option.label}</span>
            </button>
          {/each}
        </div>
        <span class="text-app-micro leading-snug text-app-fg-disabled">
          Used by the body-fat, water and muscle formulas. Tap again to clear.
        </span>
      </div>

      <!-- Date of birth -->
      <label class="flex flex-col gap-1.5">
        <span class="profile-field__label"><Cake class="app-icon-small" /> DATE OF BIRTH</span>
        <div class="profile-input-row" class:profile-input-row--bad={dobInvalid}>
          <input
            type="date"
            min={bounds.min}
            max={bounds.max}
            bind:value={dob}
            class="profile-input flex-1 min-w-0"
            aria-label="Date of birth"
          />
          <span class="profile-input__readout" class:profile-input__readout--on={age != null}>
            {age ? formatAge(age) : '—'}
          </span>
        </div>
        {#if dobInvalid}
          <span class="profile-field__error">That date is in the future or before {bounds.min}.</span>
        {:else if age}
          <span class="text-app-micro leading-snug text-app-fg-disabled">
            Past readings use the age calculated for their measurement date.
          </span>
        {/if}
      </label>

      <!-- Height -->
      <label class="flex flex-col gap-1.5">
        <span class="profile-field__label"><Ruler class="app-icon-small" /> HEIGHT ({heightUnit(units)})</span>
        <div class="profile-input-row" class:profile-input-row--bad={heightInvalid}>
          <input
            type="text"
            inputmode="decimal"
            autocomplete="off"
            placeholder={units === 'imperial' ? 'in' : 'cm'}
            bind:value={heightText}
            class="profile-input flex-1 min-w-0"
            aria-label="Height in {heightUnit(units)}"
          />
          <span class="profile-input__readout" class:profile-input__readout--on={heightCm != null}>
            {heightCm != null ? formatHeight(heightCm, units) : '—'}
          </span>
        </div>
        {#if heightInvalid}
          <span class="profile-field__error">Height must be between {round1(toDisplayHeight(30, units))} and {round1(toDisplayHeight(280, units))} {heightUnit(units)}.</span>
        {/if}
      </label>

      <!-- Activity level -->
      <div class="flex flex-col gap-1.5">
        <span class="profile-field__label"><Flame class="app-icon-small" /> ACTIVITY LEVEL</span>
        <div class="flex flex-col gap-1" role="group" aria-label="Activity level">
          {#each ACTIVITY_LEVELS as option (option.key)}
            {@const on = activity === option.key}
            <button
              type="button"
              role="radio"
              aria-checked={on}
              class="profile-choice profile-choice--row"
              class:profile-choice--on={on}
              onclick={() => pickActivity(option.key)}
            >
              <span class="profile-choice__tick" aria-hidden="true">
                {#if on}<Check class="app-icon-small" />{/if}
              </span>
              <span class="profile-choice__text">
                <span>{option.label.toUpperCase()}</span>
                <span class="profile-choice__hint">{option.hint}</span>
              </span>
            </button>
          {/each}
        </div>
        <span class="text-app-micro leading-snug text-app-fg-disabled">
          Sets your daily-calorie target. Tap again to clear.
        </span>
      </div>

      <!-- What each field is used for -->
      <div class="rounded-md border border-app-outline-subtle bg-app-surface-0 overflow-hidden">
        <div class="flex items-center justify-between px-2.5 py-1.5 border-b border-app-outline-subtle">
          <span class="text-app-micro tracking-[0.14em] text-app-fg-disabled">PROFILE INPUTS</span>
          <span class="text-app-micro tabular-nums {ready ? 'text-emerald-400' : 'text-app-fg-disabled'}">
            {inputs.filter((item) => item.ok).length}/{inputs.length}
          </span>
        </div>
        <div class="px-2.5 py-1.5 flex flex-col gap-1.5">
          {#each inputs as item (item.label)}
            <div class="flex items-start gap-1.5">
              <span
                class="mt-1 w-1.5 h-1.5 shrink-0 rounded-full {item.ok ? 'bg-emerald-500' : 'bg-app-surface-4'}"
                aria-hidden="true"
              ></span>
              <span class="flex flex-col gap-0.5">
                <span
                  class="text-app-micro tracking-[0.1em] {item.ok
                    ? 'text-app-fg-secondary-strong'
                    : 'text-app-fg-disabled'}"
                >{item.label}</span>
                <span class="text-app-micro leading-snug text-app-fg-disabled">{item.note}</span>
              </span>
            </div>
          {/each}
        </div>
        <div
          class="border-t border-app-outline-subtle px-2.5 py-1.5 text-app-micro leading-snug text-app-fg-disabled"
        >
          Every metric is still calculated and charted without these — each one is tagged
          SCALE, BIA or DERIVED so you can see where a number came from.
        </div>
      </div>

      {#if errorMessage}
        <p class="settings-panel-alert">{errorMessage}</p>
      {/if}

      <div class="flex items-center gap-2 pt-0.5">
        {#if onboarding}
          <button type="button" class="profile-btn" onclick={onDismiss} disabled={saving}>LATER</button>
        {/if}
        <button type="button" class="profile-btn profile-btn--go flex-1" onclick={save} disabled={!canSave}>
          {saving ? 'SAVING…' : 'SAVE'}
        </button>
      </div>

      {#if onboarding && !ready}
        <p class="text-app-micro leading-snug text-app-fg-disabled">
          Weigh-ins can be saved now. Body-fat, water, and BMR estimates are available after these
          profile details are saved.
        </p>
      {/if}
    </div>
  </div>
</div>
{/if}

<style>
  .profile-sheet {
    width: min(94vw, 26rem);
  }

  .profile-field__label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    font-size: var(--type-micro);
    letter-spacing: 0.12em;
    color: var(--app-fg-disabled);
  }

  .profile-field__error {
    font-size: var(--type-micro);
    color: #fca5a5;
  }

  .profile-choice {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
    height: 2.25rem;
    border-radius: var(--app-radius-compact);
    border: 1px solid var(--app-outline-subtle);
    background: var(--app-canvas);
    font-size: var(--type-micro);
    font-weight: 500;
    letter-spacing: 0.1em;
    color: var(--app-fg-muted);
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
  }

  .profile-choice:hover {
    border-color: var(--app-outline-strong);
    color: var(--app-fg-secondary-strong);
  }

  .profile-choice--on {
    background: #fff;
    border-color: #fff;
    color: #000;
  }

  .profile-choice--row {
    justify-content: flex-start;
    align-items: flex-start;
    height: auto;
    padding: var(--space-1-5) var(--space-2-5);
    text-align: left;
  }

  .profile-choice__tick {
    display: flex;
    align-items: center;
    height: 1.15rem;
  }

  .profile-choice__text {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .profile-choice__hint {
    letter-spacing: 0.02em;
    font-weight: 400;
    color: var(--app-fg-disabled);
  }

  .profile-choice--on .profile-choice__hint {
    color: #52525b;
  }

  .profile-input-row {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--app-outline-subtle);
    border-radius: var(--app-radius-compact);
    background: var(--app-canvas);
    overflow: hidden;
  }

  .profile-input-row:focus-within {
    border-color: var(--app-outline-strong);
  }

  .profile-input-row--bad {
    border-color: #7f1d1d;
  }

  .profile-input {
    height: 2.25rem;
    background: transparent;
    border: 0;
    padding: 0 var(--space-2-5);
    font-size: var(--type-caption);
    color: #fff;
    outline: none;
    font-variant-numeric: tabular-nums;
  }

  .profile-input__readout {
    display: flex;
    align-items: center;
    padding: 0 var(--space-2-5);
    border-left: 1px solid var(--app-outline-subtle);
    background: var(--app-surface-0);
    font-size: var(--type-micro);
    letter-spacing: 0.04em;
    color: var(--app-fg-disabled);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .profile-input__readout--on {
    color: #4ade80;
  }

  .profile-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 2.25rem;
    padding: 0 var(--space-3-5);
    border-radius: var(--app-radius-compact);
    border: 1px solid var(--app-outline-subtle);
    background: transparent;
    font-size: var(--type-micro);
    font-weight: 500;
    letter-spacing: 0.08em;
    color: var(--app-fg-secondary);
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
  }

  .profile-btn:hover:not(:disabled) {
    background: var(--app-surface-2);
    color: #fff;
  }

  .profile-btn--go {
    background: #fff;
    border-color: #fff;
    color: #000;
  }

  .profile-btn--go:hover:not(:disabled) {
    background: #e4e4e7;
    border-color: var(--app-outline-strong);
    color: #000;
  }

  .profile-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
