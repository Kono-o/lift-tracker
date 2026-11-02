<script lang="ts">
  import { slide } from 'svelte/transition';
  import { Check, Search, Bluetooth } from '@lucide/svelte';
  import { deviceBadge, deviceTail, deviceTitle, type ScaleDevice } from '$lib/scale/discovery';

  /**
   * The scales this platform has reported, in the order the user should read them.
   *
   * Ranking is `discovery.ts`'s job and it never reshuffles on arrival, so a finger
   * that is on its way to a row lands on the row it left from. This component only
   * draws: badge, name, identifier tail, and how loud the thing is.
   */
  let {
    devices = [],
    scanning = false,
    busy = false,
    connectable = true,
    selectedId = null,
    onSelect = () => {},
    onScan = () => {},
  }: {
    devices?: ScaleDevice[];
    /** A scan in flight: the rows it has already produced stay on screen. */
    scanning?: boolean;
    /** One row is connecting, so the rest are not tappable. */
    busy?: boolean;
    /** False when only the platform's own picker can reach a device. */
    connectable?: boolean;
    selectedId?: string | null;
    onSelect?: (device: ScaleDevice) => void;
    onScan?: () => void;
  } = $props();

  const BADGES: Record<ReturnType<typeof deviceBadge>, string> = {
    USED: 'last used',
    PAIRED: 'paired',
    SAVED: 'saved',
    NEARBY: 'nearby',
  };

  /** Four bars is the whole vocabulary; the exact dBm belongs in the title. */
  function bars(rssi: number | null): number {
    if (rssi == null) return 0;
    if (rssi >= -55) return 4;
    if (rssi >= -65) return 3;
    if (rssi >= -75) return 2;
    return 1;
  }

  const rowHint = (device: ScaleDevice): string => {
    const signal = device.rssi == null ? BADGES[deviceBadge(device)] : `${device.rssi} dBm`;
    return connectable ? `${deviceTitle(device)} — ${signal}. Connect.` : `${deviceTitle(device)} — ${signal}. Choose from the system list.`;
  };

  const disabled = $derived(busy || !connectable);
</script>

<div class="device-board">
  {#each devices as device (device.id)}
    <button
      type="button"
      class="device-row"
      class:device-row--selected={selectedId === device.id}
      transition:slide={{ duration: 180 }}
      disabled={disabled}
      aria-label={rowHint(device)}
      onclick={() => onSelect(device)}
    >
      <span class="device-row__signal" aria-hidden="true" data-strength={bars(device.rssi)}>
        <i></i><i></i><i></i><i></i>
      </span>
      <span class="device-row__main">
        <span class="device-row__name">{deviceTitle(device)}</span>
        <span class="device-row__meta">
          <span class="device-row__badge" data-badge={deviceBadge(device)}>{deviceBadge(device)}</span>
          <span class="device-row__tail">{deviceTail(device)}</span>
        </span>
      </span>
      {#if selectedId === device.id}
        <span class="device-row__check"><Check class="app-icon-small" /></span>
      {/if}
    </button>
  {:else}
    <div class="device-board__empty">
      <Bluetooth class="app-icon-small" />
      <span>No scale yet. Switch the scale on and step onto it once to wake it.</span>
    </div>
  {/each}
</div>

<button type="button" class="device-board__scan" onclick={onScan} disabled={scanning || busy}>
  <span class="device-board__icon" class:device-board__spin={scanning}>
    <Search class="app-icon-small" />
  </span>
  <span>{scanning ? 'LOOKING…' : 'LOOK FOR SCALES'}</span>
</button>

<style>
  .device-board {
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--app-outline-subtle);
    border: 1px solid var(--app-outline-subtle);
    border-radius: var(--app-radius-card);
    overflow: hidden;
  }

  .device-row {
    display: flex;
    align-items: center;
    gap: var(--space-2-5);
    width: 100%;
    padding: var(--space-2-5);
    background: var(--app-surface-0);
    text-align: left;
    transition: background-color 140ms ease;
  }

  .device-row:hover:not(:disabled) {
    background: var(--app-surface-2);
  }

  .device-row:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .device-row--selected {
    background: var(--app-surface-3);
  }

  .device-row__signal {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    width: 1.1rem;
    height: 1rem;
    flex: 0 0 auto;
  }

  .device-row__signal i {
    flex: 1;
    border-radius: 1px;
    background: var(--app-outline);
    opacity: 0.18;
  }

  .device-row__signal i:nth-child(1) { height: 35%; }
  .device-row__signal i:nth-child(2) { height: 55%; }
  .device-row__signal i:nth-child(3) { height: 78%; }
  .device-row__signal i:nth-child(4) { height: 100%; }

  .device-row__signal[data-strength='1'] i:nth-child(-n+1),
  .device-row__signal[data-strength='2'] i:nth-child(-n+2),
  .device-row__signal[data-strength='3'] i:nth-child(-n+3),
  .device-row__signal[data-strength='4'] i:nth-child(-n+4) {
    opacity: 1;
  }

  .device-row__main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .device-row__name {
    font-size: var(--type-caption);
    color: var(--app-fg-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .device-row__meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--type-micro);
    letter-spacing: 0.1em;
    color: var(--app-fg-muted);
  }

  .device-row__badge {
    border: 1px solid var(--app-outline-subtle);
    border-radius: var(--app-radius-pill);
    padding: 1px var(--space-2);
    color: var(--app-fg-secondary);
  }

  .device-row__badge[data-badge='USED'],
  .device-row__badge[data-badge='PAIRED'] {
    border-color: rgb(101 230 172 / 0.35);
    color: #7ee0ab;
  }

  .device-row__check {
    display: inline-flex;
    flex: 0 0 auto;
    color: #7ee0ab;
  }

  .device-board__empty {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-2-5);
    background: var(--app-surface-0);
    font-size: var(--type-micro);
    line-height: 1.45;
    color: var(--app-fg-muted);
  }

  .device-board__scan {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1-5);
    width: 100%;
    height: 2.1rem;
    margin-top: var(--space-2);
    border: 1px solid var(--app-outline-subtle);
    border-radius: var(--app-radius-compact);
    background: transparent;
    font-size: var(--type-micro);
    font-weight: 500;
    letter-spacing: 0.08em;
    color: var(--app-fg-secondary);
    transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
  }

  .device-board__scan:hover:not(:disabled) {
    background: var(--app-surface-2);
    color: #fff;
    border-color: var(--app-outline-strong);
  }

  .device-board__scan:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .device-board__icon {
    display: inline-flex;
  }

  .device-board__spin {
    animation: device-board-spin 900ms linear infinite;
  }

  @keyframes device-board-spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .device-board__spin { animation: none; }
  }
</style>
