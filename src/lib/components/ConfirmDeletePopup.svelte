<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Trash2 } from '@lucide/svelte';
  import { menuPopoverIn, menuPopoverOut } from '$lib/menuTransitions';
  import { portal } from '$lib/portal';

  let {
    open = $bindable(false),
    label = '',
    message = 'This cannot be undone.',
    confirmLabel = 'DELETE',
    busy = false,
    anchorEl = null as HTMLElement | null,
    onConfirm = (_close: () => void) => {},
  }: {
    /** Controlled by parent; also written internally on outside-tap / Escape. */
    open?: boolean;
    /** Item name shown in the popup (already formatted, e.g. `[PUSH DAY]`). */
    label?: string;
    message?: string;
    confirmLabel?: string;
    busy?: boolean;
    anchorEl?: HTMLElement | null;
    /** Parent decides what deleting means; call close() when the popup should dismiss. */
    onConfirm?: (close: () => void) => void;
  } = $props();

  let panelEl = $state<HTMLDivElement | undefined>();
  let pos = $state({ top: 0, left: 0 });

  function close() {
    open = false;
  }

  function placePanel() {
    if (!anchorEl || typeof window === 'undefined') return;
    const r = anchorEl.getBoundingClientRect();
    const panelW = panelEl?.offsetWidth || 210;
    const panelH = panelEl?.offsetHeight || 120;
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
    const onReposition = () => placePanel();
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  });

  function onDocPointer(e: PointerEvent) {
    if (!open) return;
    const t = e.target as Node;
    if (panelEl?.contains(t)) return;
    if (anchorEl?.contains(t)) return;
    open = false;
  }

  function onDocKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      open = false;
    }
  }

  onMount(() => {
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onDocKeydown, true);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.removeEventListener('keydown', onDocKeydown, true);
    };
  });
</script>

{#if open}
  <div
    bind:this={panelEl}
    use:portal
    class="confirm-delete-popup fixed z-[200] w-[210px] max-w-[calc(100vw-16px)] rounded-xl border border-[#2a2a2a] bg-[#141414] shadow-xl shadow-black/50 p-3 flex flex-col gap-2.5"
    style="top: {pos.top}px; left: {pos.left}px;"
    role="alertdialog"
    aria-label="Confirm delete"
    in:menuPopoverIn
    out:menuPopoverOut
  >
    <div class="flex items-start gap-2 min-w-0">
      <span
        class="w-7 h-7 shrink-0 rounded-lg border border-red-900/80 bg-red-950/50 text-red-400 flex items-center justify-center"
        aria-hidden="true"
      >
        <Trash2 class="size-3.5" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="text-[10px] font-bold tracking-wider text-red-300 leading-none">DELETE?</div>
        {#if label}
          <div class="text-[10px] font-medium text-zinc-300 break-words leading-snug mt-1 uppercase">
            {label}
          </div>
        {/if}
        <div class="text-[9px] text-zinc-500 leading-snug mt-0.5">{message}</div>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-1.5">
      <button
        type="button"
        class="h-11 rounded-lg border border-[#2a2a2a] bg-transparent text-zinc-400 hover:text-white hover:bg-[#1a1a1a] text-[11px] font-bold tracking-wider transition-colors disabled:opacity-50"
        onclick={close}
        disabled={busy}
      >
        CANCEL
      </button>
      <button
        type="button"
        class="h-11 rounded-lg border border-red-900/80 bg-red-950/60 text-red-300 hover:text-red-200 hover:border-red-800 hover:bg-red-950 text-[11px] font-bold tracking-wider transition-colors disabled:opacity-50"
        onclick={() => onConfirm(close)}
        disabled={busy}
      >
        {confirmLabel}
      </button>
    </div>
  </div>
{/if}
