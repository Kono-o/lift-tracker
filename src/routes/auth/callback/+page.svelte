<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { db, formatAuthError } from '$lib/db';

  let errorMessage = $state<string | null>(null);

  onMount(() => {
    void (async () => {
      try {
        await db.handleAuthCallback();
      } catch (e) {
        console.error('Auth callback failed', e);
        errorMessage = formatAuthError(e);
        return;
      }
      await goto('/', { replaceState: true });
    })();
  });
</script>

<div class="min-h-screen flex flex-col items-center justify-center bg-[#0a0a0a] text-white p-6 text-center">
  {#if errorMessage}
    <p class="text-sm text-red-400 mb-4">{errorMessage}</p>
    <a href="/" class="text-xs tracking-[2px] text-zinc-400 hover:text-white">Back to sign in</a>
  {:else}
    <p class="text-xs tracking-[2px] text-zinc-500">COMPLETING SIGN IN...</p>
  {/if}
</div>