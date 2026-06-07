<script lang="ts">
	import { onMount } from 'svelte';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { initNativeShell } from '$lib/native';

	let { children } = $props();

	onMount(() => {
		void initNativeShell();
	});
</script>

<svelte:head>
	<title>Lift Tracker</title>
	<meta name="description" content="Track workouts, routines, and logs" />
	<link rel="icon" href={favicon} />
</svelte:head>
{@render children()}
