<script lang="ts">
  import { fade } from 'svelte/transition';
  import { X, Check, Cake, Ruler } from '@lucide/svelte';
  import { menuPanelIn, menuPanelOut, OVERLAY_MS } from '$lib/menuTransitions';
  import type { BodyProfile, BodyProfileInput } from '$lib/bodySanitize';
  import { ageFromDob, ageYearsDecimal, dobBounds, formatAge } from '$lib/age';
  import { canDerive, type Sex } from '$lib/bodyComp';
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
   * Sex, birthday, height — the three inputs every derived metric needs.
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

  /** Per-metric truth table so the user knows what each field buys them. */
  const unlocks = $derived.by((): { label: string; ok: boolean; needsScale?: boolean }[] => {
    const hasAgeSex = sex != null && age != null;
    const needsProfile = hasAgeSex && heightCm != null;
    return [
      { label: 'BMI', ok: heightCm != null },
      { label: 'Body fat %', ok: needsProfile },
      { label: 'Body water', ok: needsProfile },
      { label: 'BMR (kcal/day)', ok: needsProfile },
      { label: 'Muscle mass', ok: needsProfile, needsScale: true },
    ];
  });

  const canSave = $derived(
    !saving && !heightInvalid && !dobInvalid && (sex != null || dob !== '' || heightText.trim() !== ''),
  );

  async function save() {
    if (!canSave) return;
    saving = true;
    errorMessage = null;
    try {
      await onSave({ sex, date_of_birth: dob || null, height_cm: heightCm });
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
  <div class="settings-panel-dialog profile-sheet rounded-xl border border-[#1e1e1e] bg-[#141414] shadow-xl overflow-hidden text-left" in:menuPanelIn out:menuPanelOut>
    <div class="settings-panel-header">
      <div class="settings-panel-header__title">
        <span class="text-[11px] font-medium tracking-[0.14em] text-zinc-400 leading-none">BODY PROFILE</span>
      </div>
      <button
        type="button"
        aria-label="Close"
        class="settings-panel-header__close"
        disabled={saving}
        onclick={onDismiss}
      >
        <X class="size-3.5" />
      </button>
    </div>

    <div class="settings-panel-body flex flex-col gap-3">
      <p class="text-[10px] leading-snug text-zinc-500">
        {onboarding
          ? 'Your scale only measures weight. These three fields are what turn it into body fat, water and BMR. Only you can read them.'
          : 'Age is worked out from your birthday and stays correct on its own — nothing to update every year.'}
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
              {#if on}<Check class="size-3" />{/if}
              <span>{option.label}</span>
            </button>
          {/each}
        </div>
        <span class="text-[9px] leading-snug text-zinc-600">
          Used by the body-fat, water and muscle formulas. Tap again to clear.
        </span>
      </div>

      <!-- Date of birth -->
      <label class="flex flex-col gap-1.5">
        <span class="profile-field__label"><Cake class="size-3" /> DATE OF BIRTH</span>
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
          <span class="text-[9px] leading-snug text-zinc-600">
            Measurements keep the age they were taken at, so history stays honest as you grow.
          </span>
        {/if}
      </label>

      <!-- Height -->
      <label class="flex flex-col gap-1.5">
        <span class="profile-field__label"><Ruler class="size-3" /> HEIGHT ({heightUnit(units)})</span>
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

      <!-- What this unlocks -->
      <div class="rounded-md border border-[#1e1e1e] bg-[#0d0d0d] overflow-hidden">
        <div class="flex items-center justify-between px-2.5 py-1.5 border-b border-[#1e1e1e]">
          <span class="text-[9px] tracking-[0.14em] text-zinc-600">DERIVED METRICS</span>
          <span class="text-[9px] tabular-nums {ready ? 'text-emerald-400' : 'text-zinc-600'}">
            {unlocks.filter((u) => u.ok).length}/{unlocks.length}
          </span>
        </div>
        <div class="px-2.5 py-1.5 flex flex-col gap-1">
          {#each unlocks as item (item.label)}
            <div class="flex items-center justify-between gap-2">
              <span class="flex items-center gap-1.5 text-[10px] {item.ok ? 'text-zinc-300' : 'text-zinc-600'}">
                <span class="w-1.5 h-1.5 rounded-full {item.ok ? 'bg-emerald-500' : 'bg-[#2a2a2a]'}" aria-hidden="true"></span>
                {item.label}
              </span>
              {#if item.needsScale}
                <span class="text-[9px] text-zinc-600">needs impedance</span>
              {/if}
            </div>
          {/each}
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
        <p class="text-[9px] leading-snug text-zinc-600">
          You can save weigh-ins now either way — they store your weight and heart rate, and the
          rest fills in once these fields are set.
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
    gap: 0.35rem;
    font-size: 9px;
    letter-spacing: 0.12em;
    color: #52525b;
  }

  .profile-field__error {
    font-size: 10px;
    color: #fca5a5;
  }

  .profile-choice {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    height: 2.25rem;
    border-radius: 0.375rem;
    border: 1px solid #1e1e1e;
    background: #060606;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.1em;
    color: #71717a;
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
  }

  .profile-choice:hover {
    border-color: #3a3a3a;
    color: #d4d4d8;
  }

  .profile-choice--on {
    background: #fff;
    border-color: #fff;
    color: #000;
  }

  .profile-input-row {
    display: flex;
    align-items: stretch;
    border: 1px solid #1e1e1e;
    border-radius: 0.375rem;
    background: #060606;
    overflow: hidden;
  }

  .profile-input-row:focus-within {
    border-color: #3a3a3a;
  }

  .profile-input-row--bad {
    border-color: #7f1d1d;
  }

  .profile-input {
    height: 2.25rem;
    background: transparent;
    border: 0;
    padding: 0 0.6rem;
    font-size: 13px;
    color: #fff;
    outline: none;
    font-variant-numeric: tabular-nums;
    color-scheme: dark;
  }

  .profile-input__readout {
    display: flex;
    align-items: center;
    padding: 0 0.6rem;
    border-left: 1px solid #1e1e1e;
    background: #0d0d0d;
    font-size: 10px;
    letter-spacing: 0.04em;
    color: #52525b;
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
    padding: 0 0.9rem;
    border-radius: 0.375rem;
    border: 1px solid #1e1e1e;
    background: transparent;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.08em;
    color: #a1a1aa;
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
  }

  .profile-btn:hover:not(:disabled) {
    background: #1a1a1a;
    color: #fff;
  }

  .profile-btn--go {
    background: #fff;
    border-color: #fff;
    color: #000;
  }

  .profile-btn--go:hover:not(:disabled) {
    background: #e4e4e7;
    border-color: #e4e4e7;
    color: #000;
  }

  .profile-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
