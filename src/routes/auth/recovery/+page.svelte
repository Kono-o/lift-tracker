<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { CircleAlert, Dumbbell, LockKeyhole, RefreshCw } from '@lucide/svelte';
	import { db, supabase, validatePassword, MAX_PASSWORD_LEN } from '$lib/db';

	let ready = $state(false);
	let checking = $state(true);
	let saving = $state(false);
	let password = $state('');
	let confirmation = $state('');
	let error = $state<string | null>(null);

	onMount(() => {
		void (async () => {
			try {
				const { data, error: sessionError } = await supabase.auth.getSession();
				if (sessionError) throw sessionError;
				ready = !!data.session;
				if (!ready) error = 'This reset link has expired or was already used. Request a new one and try again.';
			} catch {
				error = 'We could not verify this reset link. Request a new one and try again.';
			} finally {
				checking = false;
			}
		})();
	});

	async function savePassword(event: SubmitEvent) {
		event.preventDefault();
		if (saving) return;
		const passwordError = validatePassword(password);
		if (passwordError) {
			error = passwordError;
			return;
		}
		if (password !== confirmation) {
			error = 'Passwords do not match.';
			return;
		}
		saving = true;
		error = null;
		try {
			await db.setPasswordAfterRecovery(password);
			await goto('/', { replaceState: true });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not update your password. Request a new link and try again.';
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>Reset password · Lift Tracker</title>
	<meta name="description" content="Choose a new password for your Lift Tracker account." />
</svelte:head>

<main class="auth-recovery-screen">
	<section class="auth-recovery-card" aria-labelledby="recovery-title">
		<div class="auth-recovery-brand"><span><Dumbbell class="size-5" aria-hidden="true" /></span><b>LIFT<small>TRACKER</small></b></div>
		<p class="auth-story__eyebrow"><span></span> ACCOUNT RECOVERY</p>
		<h1 id="recovery-title">Choose a new password</h1>
		<p class="auth-recovery-copy">Use at least 8 characters. Your other devices may ask you to sign in again.</p>

		{#if checking}
			<div class="auth-recovery-loading" role="status"><RefreshCw class="size-4 animate-spin" aria-hidden="true" /> Checking your secure link…</div>
		{:else if ready}
			<form class="auth-recovery-form" onsubmit={savePassword}>
				<label>
					<span>NEW PASSWORD</span>
					<div><LockKeyhole class="size-4" aria-hidden="true" /><input type="password" autocomplete="new-password" maxlength={MAX_PASSWORD_LEN} bind:value={password} oninput={() => error = null} /></div>
				</label>
				<label>
					<span>CONFIRM NEW PASSWORD</span>
					<div><LockKeyhole class="size-4" aria-hidden="true" /><input type="password" autocomplete="new-password" maxlength={MAX_PASSWORD_LEN} bind:value={confirmation} oninput={() => error = null} /></div>
				</label>
				{#if error}<p class="auth-recovery-error" role="alert"><CircleAlert class="size-4 shrink-0" aria-hidden="true" />{error}</p>{/if}
				<button class="auth-recovery-submit" type="submit" disabled={saving || !password || !confirmation}>
					{#if saving}<RefreshCw class="size-4 animate-spin" aria-hidden="true" />{:else}SAVE NEW PASSWORD{/if}
				</button>
			</form>
		{:else}
			<p class="auth-recovery-error" role="alert"><CircleAlert class="size-4 shrink-0" aria-hidden="true" />{error}</p>
		{/if}
		<a class="auth-recovery-back" href="/">Back to sign in</a>
	</section>
</main>
