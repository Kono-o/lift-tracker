<script lang="ts">
  import { currentToast, dismissUndoToast } from '$lib/undo.svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut, cubicIn } from 'svelte/easing';

  let dismissTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const toast = currentToast();
    if (!toast) {
      if (dismissTimer) clearTimeout(dismissTimer);
      dismissTimer = undefined;
      return;
    }
    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => dismissUndoToast(), toast.durationMs ?? 4000);
  });
</script>

{#if currentToast()}
  <div
    class="undo-toast fixed z-[300] left-1/2 bottom-6 -translate-x-1/2 w-[min(92vw,380px)] flex items-center gap-2 pl-3 pr-1 py-1.5 rounded-xl border border-[#2a2a2a] bg-[#141414] shadow-xl shadow-black/50"
    role="status"
    aria-live="polite"
    in:fly={{ y: 16, duration: 180, easing: cubicOut }}
    out:fly={{ y: 16, duration: 140, easing: cubicIn }}
  >
    <span class="flex-1 min-w-0 text-xs text-zinc-200 leading-snug">{currentToast()?.label}</span>
    {#if currentToast()?.onUndo}
      <button
        type="button"
        class="shrink-0 h-9 px-3 rounded-lg border border-emerald-800/70 bg-emerald-950/50 text-emerald-300 text-[11px] font-bold tracking-wider hover:bg-emerald-900/40 hover:border-emerald-700 transition-colors"
        onclick={() => {
          currentToast()?.onUndo?.();
          dismissUndoToast();
        }}
      >
        UNDO
      </button>
    {/if}
    <button
      type="button"
      class="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-[#1a1a1a] transition-colors"
      aria-label="Dismiss"
      title="Dismiss"
      onclick={dismissUndoToast}
    >
      ✕
    </button>
  </div>
{/if}
