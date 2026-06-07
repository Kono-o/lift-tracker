<script lang="ts">
	import { onMount } from 'svelte';

	let clockTimeStr = $state('');

	function updateClock() {
		const now = new Date();
		const next = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
		if (next !== clockTimeStr) clockTimeStr = next;
	}

	onMount(() => {
		updateClock();
		const clockInterval = setInterval(updateClock, 1000);
		return () => clearInterval(clockInterval);
	});
</script>

<span class="font-header-clock font-header-clock--fixed text-[10px] text-zinc-500 leading-none">{clockTimeStr}</span>