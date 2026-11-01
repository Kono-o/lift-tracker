<script lang="ts">
  import { onMount } from 'svelte';
  import { anchoredPopover } from '$lib/anchoredPopover';
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
  let selected = $state(0);

  const PreviewIcon = $derived(getItemIcon(selected));

  $effect(() => {
    if (open) selected = clampItemIcon(iconIndex);
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
    use:anchoredPopover={{ anchor: anchorEl, fallbackWidth: 336 }}
    class="app-float-surface app-popover-surface item-icon-picker fixed z-[200] w-[336px] max-w-[calc(100vw-16px)] flex flex-col"
    role="dialog"
    aria-label="Pick icon"
    in:menuPopoverIn
    out:menuPopoverOut
  >
    <div class="flex items-center gap-2.5">
      <div
        class="w-9 h-9 rounded-lg border border-app-outline shrink-0 flex items-center justify-center"
        style="color: {accentColor}"
      >
        <PreviewIcon class="app-icon-nav" strokeWidth={ITEM_ICON_STROKE} />
      </div>
      <div class="min-w-0 flex-1">
        <div class="text-app-micro font-bold tracking-wider text-app-fg-secondary leading-none">ICON</div>
        <div class="text-xs text-app-fg-muted font-mono mt-0.5 tabular-nums">#{selected}</div>
      </div>
    </div>

    <div class="item-icon-picker__grid grid grid-cols-8 gap-1.5">
      {#each ITEM_ICONS as Icon, i}
        {@const active = selected === i}
        <button
          type="button"
          class="item-icon-picker-cell w-full aspect-square rounded-lg border flex items-center justify-center transition-colors {active
            ? 'border-white bg-white/10 text-app-fg-primary'
            : 'border-app-outline-subtle bg-app-surface-0 text-app-fg-secondary hover:border-app-outline hover:text-app-fg-secondary-strong'}"
          title="Icon {i}"
          aria-label="Icon {i}"
          aria-pressed={active}
          onclick={() => pick(i)}
        >
          <Icon class="app-icon-control" strokeWidth={ITEM_ICON_STROKE} />
        </button>
      {/each}
    </div>
  </div>
{/if}
