<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Copy, Check } from '@lucide/svelte';
  import {
    clampTemplateColor,
    getTemplateColor,
    hexToNearestIndex,
    hsvToNearestIndex,
    hsvToRgb,
    indexToHsv,
    rgbToHex,
    type Hsv,
  } from '$lib/templateColor';
  import { menuPopoverIn, menuPopoverOut } from '$lib/menuTransitions';
  import { portal } from '$lib/portal';

  let {
    colorIndex = 0,
    open = $bindable(false),
    anchorEl = null as HTMLElement | null,
    onChange = (_index: number) => {},
  }: {
    /** Controlled index from parent (single source of truth for header swatch + name). */
    colorIndex?: number;
    open?: boolean;
    anchorEl?: HTMLElement | null;
    onChange?: (index: number) => void;
  } = $props();

  let hsv = $state<Hsv>({ h: 0, s: 0.9, v: 0.9 });
  let panelEl = $state<HTMLDivElement | undefined>();
  let pos = $state({ top: 0, left: 0 });
  let hexCopied = $state(false);
  let hexCopyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Draft hex while editing; null means show live preview. */
  let hexDraft = $state<string | null>(null);
  /**
   * Index we last pushed to the parent. Prevents the open-sync effect from
   * re-quantizing HSV after every slider tick (which snaps thumbs).
   */
  let lastEmittedIndex = $state<number | null>(null);
  let wasOpen = $state(false);

  /** Continuous HSV → hex for smooth slider feedback (not palette-snapped). */
  const liveHex = $derived(rgbToHex(hsvToRgb(hsv.h, hsv.s, hsv.v)));
  const quantizedIndex = $derived(hsvToNearestIndex(hsv.h, hsv.s, hsv.v));
  const paletteHex = $derived(getTemplateColor(quantizedIndex));
  const hexDisplay = $derived(hexDraft ?? liveHex.toUpperCase());
  const hexValid = $derived(hexDraft === null || hexToNearestIndex(hexDraft) !== null);
  /** 8 hue presets across the wheel */
  const HUE_PRESETS = 8;

  function syncFromIndex(idx: number) {
    hsv = indexToHsv(clampTemplateColor(idx));
    hexDraft = null;
  }

  $effect(() => {
    if (!open) {
      wasOpen = false;
      lastEmittedIndex = null;
      return;
    }
    // Hydrate once when opening, or when parent index changes from outside (not from us).
    const openedNow = !wasOpen;
    wasOpen = true;
    if (openedNow || lastEmittedIndex !== colorIndex) {
      syncFromIndex(colorIndex);
      lastEmittedIndex = colorIndex;
      hexCopied = false;
      hexDraft = null;
    }
  });

  function placePanel() {
    if (!anchorEl || typeof window === 'undefined') return;
    const r = anchorEl.getBoundingClientRect();
    const panelW = panelEl?.offsetWidth || 240;
    const panelH = panelEl?.offsetHeight || 280;
    const gap = 6;
    let left = r.right - panelW;
    let top = r.bottom + gap;
    if (left < 8) left = 8;
    if (left + panelW > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - panelW - 8);
    }
    if (top + panelH > window.innerHeight - 8) {
      top = Math.max(8, r.top - panelH - gap);
    }
    pos = { top: Math.round(top), left: Math.round(left) };
  }

  $effect(() => {
    if (!open) return;
    let cancelled = false;
    placePanel();
    void tick().then(() => {
      if (cancelled) return;
      placePanel();
      requestAnimationFrame(() => {
        if (!cancelled) placePanel();
      });
    });
    const onScroll = () => placePanel();
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  });

  function applyFromSliders() {
    // Keep continuous HSV on the sliders; only the committed palette index is quantized.
    hexDraft = null;
    const idx = hsvToNearestIndex(hsv.h, hsv.s, hsv.v);
    lastEmittedIndex = idx;
    onChange(idx);
  }

  /** Apply typed/pasted hex if valid; snaps to nearest palette entry. */
  function commitHex(raw: string, opts?: { revertOnInvalid?: boolean }): boolean {
    const idx = hexToNearestIndex(raw);
    if (idx === null) {
      if (opts?.revertOnInvalid) hexDraft = null;
      return false;
    }
    hsv = indexToHsv(idx);
    hexDraft = null;
    lastEmittedIndex = idx;
    onChange(idx);
    return true;
  }

  function onHexInput(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    let v = el.value.trim();
    // Allow optional leading # while typing
    if (v && !v.startsWith('#')) v = `#${v.replace(/^#+/, '')}`;
    hexDraft = v;
    // Live-apply when we have a complete valid hex (3 or 6 digits after #)
    const body = v.replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(body)) {
      commitHex(v);
    }
  }

  function onHexBlur() {
    if (hexDraft === null) return;
    commitHex(hexDraft, { revertOnInvalid: true });
  }

  function onHexKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (hexDraft !== null) commitHex(hexDraft, { revertOnInvalid: true });
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hexDraft = null;
      (e.currentTarget as HTMLInputElement).blur();
    }
  }

  async function copyHex() {
    const hex = (hexDraft && hexToNearestIndex(hexDraft) !== null
      ? hexDraft
      : paletteHex
    ).toUpperCase();
    const normalized = hex.startsWith('#') ? hex : `#${hex}`;
    try {
      await navigator.clipboard.writeText(normalized);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = normalized;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    hexCopied = true;
    if (hexCopyTimer) clearTimeout(hexCopyTimer);
    hexCopyTimer = setTimeout(() => {
      hexCopied = false;
      hexCopyTimer = null;
    }, 1200);
  }

  function onDocPointer(e: PointerEvent) {
    if (!open) return;
    const t = e.target as Node;
    if (panelEl?.contains(t)) return;
    if (anchorEl?.contains(t)) return;
    open = false;
  }

  onMount(() => {
    document.addEventListener('pointerdown', onDocPointer, true);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer, true);
      if (hexCopyTimer) clearTimeout(hexCopyTimer);
    };
  });
</script>

{#if open}
  <div
    bind:this={panelEl}
    use:portal
    class="template-color-picker fixed z-[200] w-[240px] rounded-xl border border-[#2a2a2a] bg-[#141414] shadow-xl shadow-black/50 p-3 flex flex-col gap-2.5"
    style="top: {pos.top}px; left: {pos.left}px;"
    role="dialog"
    aria-label="Template color"
    in:menuPopoverIn
    out:menuPopoverOut
  >
    <div class="flex items-center gap-2">
      <div
        class="w-8 h-8 rounded-lg border border-[#2a2a2a] shrink-0"
        style="background-color: {liveHex}"
        title="Live preview (saves as {paletteHex})"
      ></div>
      <div class="min-w-0 flex-1">
        <div class="text-[10px] font-bold tracking-wider text-zinc-400 leading-none">COLOR</div>
        <div class="flex items-center gap-1 mt-0.5 min-w-0">
          <input
            type="text"
            class="template-hex-input min-w-0 flex-1 bg-transparent border-0 border-b border-transparent hover:border-[#2a2a2a] focus:border-zinc-500 outline-none text-[11px] font-mono uppercase text-zinc-300 py-0 px-0 leading-tight transition-colors {hexValid ? '' : 'text-red-400 border-red-500/60'}"
            value={hexDisplay}
            spellcheck="false"
            autocomplete="off"
            autocapitalize="characters"
            maxlength="7"
            aria-label="Hex color"
            title="Paste or type hex (#RGB or #RRGGBB)"
            oninput={onHexInput}
            onblur={onHexBlur}
            onkeydown={onHexKeydown}
            onfocus={(e) => {
              const el = e.currentTarget as HTMLInputElement;
              if (hexDraft === null) hexDraft = liveHex.toUpperCase();
              // Select all for easy paste-over
              queueMicrotask(() => el.select());
            }}
          />
          <span class="text-[11px] text-zinc-500 font-mono shrink-0 tabular-nums">· #{quantizedIndex}</span>
        </div>
      </div>
      <button
        type="button"
        class="w-8 h-8 shrink-0 rounded-lg border border-[#1e1e1e] bg-[#0d0d0d] text-zinc-400 hover:text-white hover:border-[#2a2a2a] flex items-center justify-center transition-colors"
        title={hexCopied ? 'Copied' : 'Copy hex'}
        onclick={() => void copyHex()}
      >
        {#if hexCopied}
          <Check class="size-3.5 text-emerald-400" />
        {:else}
          <Copy class="size-3.5" />
        {/if}
      </button>
    </div>

    <label class="flex flex-col gap-1">
      <div class="flex justify-between text-[9px] uppercase tracking-wider text-zinc-500">
        <span>Hue</span>
        <span class="tabular-nums text-zinc-400">{Math.round(hsv.h)}°</span>
      </div>
      <input
        type="range"
        min="0"
        max="360"
        step="any"
        class="template-hsv-slider template-hsv-slider--hue w-full h-2 rounded-full appearance-none cursor-pointer"
        value={hsv.h}
        oninput={(e) => {
          hsv = { ...hsv, h: Number((e.currentTarget as HTMLInputElement).value) };
          applyFromSliders();
        }}
      />
    </label>

    <label class="flex flex-col gap-1">
      <div class="flex justify-between text-[9px] uppercase tracking-wider text-zinc-500">
        <span>Saturation</span>
        <span class="tabular-nums text-zinc-400">{Math.round(hsv.s * 100)}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        step="any"
        class="template-hsv-slider w-full h-2 rounded-full appearance-none cursor-pointer"
        style="background: linear-gradient(to right, {rgbToHex(hsvToRgb(hsv.h, 0, hsv.v))}, {rgbToHex(hsvToRgb(hsv.h, 1, hsv.v))})"
        value={hsv.s * 100}
        oninput={(e) => {
          hsv = { ...hsv, s: Number((e.currentTarget as HTMLInputElement).value) / 100 };
          applyFromSliders();
        }}
      />
    </label>

    <label class="flex flex-col gap-1">
      <div class="flex justify-between text-[9px] uppercase tracking-wider text-zinc-500">
        <span>Value</span>
        <span class="tabular-nums text-zinc-400">{Math.round(hsv.v * 100)}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        step="any"
        class="template-hsv-slider w-full h-2 rounded-full appearance-none cursor-pointer"
        style="background: linear-gradient(to right, #111, {rgbToHex(hsvToRgb(hsv.h, hsv.s, 1))})"
        value={hsv.v * 100}
        oninput={(e) => {
          hsv = { ...hsv, v: Number((e.currentTarget as HTMLInputElement).value) / 100 };
          applyFromSliders();
        }}
      />
    </label>

    <div class="grid grid-cols-8 gap-1.5 mt-0.5 px-0.5">
      {#each Array.from({ length: HUE_PRESETS }, (_, i) => i) as hi}
        {@const hue = (hi / HUE_PRESETS) * 360}
        {@const idx = hsvToNearestIndex(hue, hsv.s, hsv.v)}
        {@const activeBand = Math.round((hsv.h / 360) * HUE_PRESETS) % HUE_PRESETS}
        <button
          type="button"
          class="template-hue-squircle justify-self-center w-4 h-4 border-0 hover:brightness-110 transition-[filter,opacity] {activeBand === hi ? 'opacity-100 ring-1 ring-white/80' : 'opacity-90'}"
          style="background-color: {getTemplateColor(idx)}"
          title="Hue {Math.round(hue)}°"
          onclick={() => {
            hsv = { ...hsv, h: hue };
            applyFromSliders();
          }}
        ></button>
      {/each}
    </div>
  </div>
{/if}

<style>
  .template-hex-input {
    width: 4.5rem;
    max-width: 100%;
  }
  .template-hsv-slider {
    outline: none;
  }
  .template-hsv-slider--hue {
    background: linear-gradient(
      to right,
      #f00 0%,
      #ff0 17%,
      #0f0 33%,
      #0ff 50%,
      #00f 67%,
      #f0f 83%,
      #f00 100%
    );
  }
  .template-hsv-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 11px;
    height: 11px;
    border-radius: 28%;
    background: #fff;
    border: none;
    box-shadow: none;
    cursor: pointer;
  }
  .template-hsv-slider::-moz-range-thumb {
    width: 11px;
    height: 11px;
    border-radius: 28%;
    background: #fff;
    border: none;
    box-shadow: none;
    cursor: pointer;
  }
  /* iOS-like squircle (continuous rounded square) */
  .template-hue-squircle {
    border-radius: 28%;
    border: none;
    padding: 0;
  }
</style>
