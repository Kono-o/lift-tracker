<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<title>Lift Tracker</title>
	<meta name="description" content="Track workouts, routines, and logs" />
	<link rel="icon" href={favicon} />
</svelte:head>
{@render children()}
