<script lang="ts">
  import { onMount } from 'svelte';
  import { Trash2 } from '@lucide/svelte';
  import { anchoredPopover } from '$lib/anchoredPopover';
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

  function close() {
    open = false;
  }

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
    use:anchoredPopover={{ anchor: anchorEl, fallbackWidth: 210 }}
    class="app-float-surface app-popover-surface confirm-delete-popup fixed z-[200] w-[210px] max-w-[calc(100vw-16px)] flex flex-col"
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
        <Trash2 class="app-icon-small" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="text-app-micro font-bold tracking-wider text-red-300 leading-none">DELETE?</div>
        {#if label}
          <div class="text-app-micro font-medium text-app-fg-secondary-strong break-words leading-snug mt-1 uppercase">
            {label}
          </div>
        {/if}
        <div class="text-app-micro text-app-fg-muted leading-snug mt-0.5">{message}</div>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-1.5">
      <button
        type="button"
        class="h-11 rounded-lg border border-app-outline bg-transparent text-app-fg-secondary hover:text-app-fg-primary hover:bg-app-surface-2 text-app-caption font-bold tracking-wider transition-colors disabled:opacity-50"
        onclick={close}
        disabled={busy}
      >
        CANCEL
      </button>
      <button
        type="button"
        class="h-11 rounded-lg border border-red-900/80 bg-red-950/60 text-red-300 hover:text-red-200 hover:border-red-800 hover:bg-red-950 text-app-caption font-bold tracking-wider transition-colors disabled:opacity-50"
        onclick={() => onConfirm(close)}
        disabled={busy}
      >
        {confirmLabel}
      </button>
    </div>
  </div>
{/if}
