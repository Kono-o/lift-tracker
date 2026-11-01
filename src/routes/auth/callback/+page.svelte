<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { CircleAlert, Dumbbell, RefreshCw } from '@lucide/svelte';
  import { db, formatAuthError } from '$lib/db';

  let errorMessage = $state<string | null>(null);

  onMount(() => {
    void (async () => {
      const url = new URL(window.location.href);
      const hashParams = new URLSearchParams(url.hash.slice(1));
      const isRecovery = url.searchParams.get('type') === 'recovery' || hashParams.get('type') === 'recovery';
      try {
        await db.handleAuthCallback();
      } catch (e) {
        console.error('Auth callback failed', e);
        errorMessage = formatAuthError(e);
        return;
      }
      await goto(isRecovery ? '/auth/recovery' : '/', { replaceState: true });
    })();
  });
</script>

<svelte:head>
  <title>Completing secure sign-in · Lift Tracker</title>
  <meta name="description" content="Finishing your secure Lift Tracker sign-in." />
</svelte:head>

<main class="auth-recovery-screen">
  <section class="auth-recovery-card" aria-live="polite">
    <div class="auth-recovery-brand"><span><Dumbbell class="app-icon-nav" aria-hidden="true" /></span><b>LIFT<small>TRACKER</small></b></div>
  {#if errorMessage}
      <p class="auth-recovery-error" role="alert"><CircleAlert class="app-icon-control shrink-0" aria-hidden="true" />{errorMessage}</p>
      <a href="/" class="auth-recovery-back">Back to sign in</a>
  {:else}
      <div class="auth-recovery-loading" role="status"><RefreshCw class="app-icon-control animate-spin" aria-hidden="true" />Verifying your secure sign-in…</div>
  {/if}
  </section>
</main>
