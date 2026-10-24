import { Capacitor } from '@capacitor/core';

type LocalNotificationsModule = typeof import('@capacitor/local-notifications');

let modulePromise: Promise<LocalNotificationsModule | null> | null = null;
let channelReady = false;

const REST_NOTIFICATION_ID = 4100;
const REMINDER_ID_BASE = 4200;

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

async function loadModule(): Promise<LocalNotificationsModule | null> {
  if (!isNative()) return null;
  modulePromise ??= import('@capacitor/local-notifications').catch(() => null);
  return modulePromise;
}

async function ensureChannels(): Promise<LocalNotificationsModule | null> {
  const mod = await loadModule();
  if (!mod) return null;
  if (channelReady) return mod;
  try {
    await mod.LocalNotifications.createChannel({
      id: 'lift-rest',
      name: 'Rest timer',
      description: 'Alerts when a rest period ends',
      importance: 4,
      visibility: 1,
      vibration: true,
    });
    await mod.LocalNotifications.createChannel({
      id: 'lift-reminders',
      name: 'Workout reminders',
      description: 'Weekly reminders to train',
      importance: 3,
      visibility: 1,
      vibration: true,
    });
    channelReady = true;
  } catch {
    /* channels are Android-only; ignore elsewhere */
  }
  return mod;
}

/** Ask for notification permission if needed. Returns true when notifications can be posted. */
export async function ensureNotificationPermission(): Promise<boolean> {
  const mod = await ensureChannels();
  if (!mod) return false;
  try {
    const current = await mod.LocalNotifications.checkPermissions();
    if (current.display === 'granted') return true;
    const requested = await mod.LocalNotifications.requestPermissions();
    return requested.display === 'granted';
  } catch {
    return false;
  }
}

/** Schedule a one-off alert for the end of the current rest period. */
export async function scheduleRestEndNotification(seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const mod = await ensureChannels();
  if (!mod) return;
  if (!(await ensureNotificationPermission())) return;
  try {
    await mod.LocalNotifications.cancel({
      notifications: [{ id: REST_NOTIFICATION_ID }],
    });
  } catch {
    /* nothing scheduled */
  }
  try {
    await mod.LocalNotifications.schedule({
      notifications: [
        {
          id: REST_NOTIFICATION_ID,
          title: 'Rest complete',
          body: 'Time for your next set.',
          channelId: 'lift-rest',
          schedule: {
            at: new Date(Date.now() + Math.round(seconds * 1000)),
            allowWhileIdle: true,
          },
        },
      ],
    });
  } catch {
    /* exact alarms can be blocked by the OS; the in-app timer still runs */
  }
}

export async function cancelRestEndNotification(): Promise<void> {
  const mod = await loadModule();
  if (!mod) return;
  try {
    await mod.LocalNotifications.cancel({
      notifications: [{ id: REST_NOTIFICATION_ID }],
    });
  } catch {
    /* ignore */
  }
}

/**
 * Replace weekly workout reminders.
 * `days` uses JS weekday numbers (0 = Sunday). Returns false when permission
 * was denied or the platform has no native scheduler.
 */
export async function syncWorkoutReminders(
  enabled: boolean,
  time: string,
  days: number[],
): Promise<boolean> {
  const mod = await ensureChannels();
  if (!mod) return false;
  const ids = Array.from({ length: 7 }, (_, index) => ({
    id: REMINDER_ID_BASE + index,
  }));
  try {
    await mod.LocalNotifications.cancel({ notifications: ids });
  } catch {
    /* nothing scheduled */
  }
  if (!enabled) return true;
  if (!(await ensureNotificationPermission())) return false;

  const [hourRaw, minuteRaw] = time.split(':').map(Number);
  const hour = Number.isFinite(hourRaw) ? Math.min(23, Math.max(0, Math.round(hourRaw))) : 18;
  const minute = Number.isFinite(minuteRaw) ? Math.min(59, Math.max(0, Math.round(minuteRaw))) : 0;
  const uniqueDays = [...new Set(days.filter((day) => day >= 0 && day <= 6))];
  if (uniqueDays.length === 0) return true;

  try {
    await mod.LocalNotifications.schedule({
      notifications: uniqueDays.map((day) => ({
        id: REMINDER_ID_BASE + day,
        title: 'Time to train',
        body: 'Your workout is waiting. Open Lift Tracker to get started.',
        channelId: 'lift-reminders',
        schedule: {
          on: { weekday: day + 1, hour, minute },
          repeats: true,
          allowWhileIdle: true,
        },
      })),
    });
    return true;
  } catch {
    return false;
  }
}

export function notificationsAvailable(): boolean {
  return isNative();
}
