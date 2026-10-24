import { isNativeApp } from '$lib/native';
import { ImpactStyle, NotificationType } from '@capacitor/haptics';

let Haptics: typeof import('@capacitor/haptics') | null = null;

let hapticsEnabled = true;

/** Global preference gate — set once preferences load. */
export function setHapticsEnabled(enabled: boolean): void {
  hapticsEnabled = !!enabled;
}

async function load() {
  if (!hapticsEnabled) return null;
  if (Haptics) return Haptics;
  if (!isNativeApp()) return null;
  try {
    Haptics = await import('@capacitor/haptics');
  } catch {
    Haptics = null;
  }
  return Haptics;
}

/** Light tap — good for selections, tab switches, small confirmations. */
export async function hapticLight(): Promise<void> {
  const h = await load();
  try {
    await h?.Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    /* ignore — haptics unavailable */
  }
}

/** Medium tap — good for deletions, reorder engagements, mid-weight actions. */
export async function hapticMedium(): Promise<void> {
  const h = await load();
  try {
    await h?.Haptics.impact({ style: ImpactStyle.Medium });
  } catch {
    /* ignore */
  }
}

/** Success — good for completing a workout, creating an item. */
export async function hapticSuccess(): Promise<void> {
  const h = await load();
  try {
    await h?.Haptics.notification({ type: NotificationType.Success });
  } catch {
    /* ignore */
  }
}

/** Warning/error — good for failures or destructive confirmations. */
export async function hapticWarning(): Promise<void> {
  const h = await load();
  try {
    await h?.Haptics.notification({ type: NotificationType.Warning });
  } catch {
    /* ignore */
  }
}

/** Reorder drop — firm "placed" tick. */
export async function hapticPlace(): Promise<void> {
  const h = await load();
  try {
    await h?.Haptics.impact({ style: ImpactStyle.Heavy });
  } catch {
    /* ignore */
  }
}
