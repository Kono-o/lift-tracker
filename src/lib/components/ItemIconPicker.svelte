<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    clampItemIcon,
    getItemIcon,
    ITEM_ICONS,
    ITEM_ICON_STROKE,
  } from '$lib/itemIcons';
  import { menuPopoverIn, menuPopoverOut } from '$lib/menuTransitions';
  import { portal } from '$lib/portal';

  let {
    iconIndex = 0,
    open = $bindable(false),
    anchorEl = null as HTMLElement | null,
    accentColor = '#a1a1aa',
    onChange = (_index: number) => {},
  }: {
    iconIndex?: number;
    open?: boolean;
    anchorEl?: HTMLElement | null;
    /** Optional tint for the preview tile */
    accentColor?: string;
    onChange?: (index: number) => void;
  } = $props();

  let panelEl = $state<HTMLDivElement | undefined>();
  let pos = $state({ top: 0, left: 0 });
  let selected = $state(0);

  const PreviewIcon = $derived(getItemIcon(selected));

  $effect(() => {
    if (open) selected = clampItemIcon(iconIndex);
  });

  function placePanel() {
    if (!anchorEl || typeof window === 'undefined') return;
    const r = anchorEl.getBoundingClientRect();
    const panelW = panelEl?.offsetWidth || 336;
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
    // Snap to integer CSS pixels to avoid subpixel blur
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

  function pick(i: number) {
    selected = clampItemIcon(i);
    onChange(selected);
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
    return () => document.removeEventListener('pointerdown', onDocPointer, true);
  });
</script>

{#if open}
  <div
    bind:this={panelEl}
    use:portal
    class="item-icon-picker fixed z-[200] w-[336px] rounded-xl border border-[#2a2a2a] bg-[#141414] shadow-xl shadow-black/50 p-3 flex flex-col gap-2.5"
    style="top: {pos.top}px; left: {pos.left}px;"
    role="dialog"
    aria-label="Pick icon"
    in:menuPopoverIn
    out:menuPopoverOut
  >
    <div class="flex items-center gap-2.5">
      <div
        class="w-9 h-9 rounded-lg border border-[#2a2a2a] shrink-0 flex items-center justify-center"
        style="color: {accentColor}"
      >
        <PreviewIcon class="size-5" strokeWidth={ITEM_ICON_STROKE} />
      </div>
      <div class="min-w-0 flex-1">
        <div class="text-[10px] font-bold tracking-wider text-zinc-400 leading-none">ICON</div>
        <div class="text-xs text-zinc-500 font-mono mt-0.5 tabular-nums">#{selected}</div>
      </div>
    </div>

    <div class="grid grid-cols-8 gap-1.5">
      {#each ITEM_ICONS as Icon, i}
        {@const active = selected === i}
        <button
          type="button"
          class="item-icon-picker-cell w-full aspect-square rounded-lg border flex items-center justify-center transition-colors {active
            ? 'border-white bg-white/10 text-white'
            : 'border-[#1e1e1e] bg-[#0d0d0d] text-zinc-400 hover:border-[#2a2a2a] hover:text-zinc-200'}"
          title="Icon {i}"
          aria-label="Icon {i}"
          aria-pressed={active}
          onclick={() => pick(i)}
        >
          <Icon class="size-4" strokeWidth={ITEM_ICON_STROKE} />
        </button>
      {/each}
    </div>
  </div>
{/if}
