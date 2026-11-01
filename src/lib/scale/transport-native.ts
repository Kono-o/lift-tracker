/**
 * Android/iOS transport via the Capacitor BLE plugin.
 *
 * The native WebView has no `navigator.bluetooth`, so the APK needs this path.
 * The plugin mirrors Web Bluetooth (`requestDevice` opens a picker, then
 * notifications on a characteristic), and the module is imported lazily so a web
 * build never ships it.
 *
 * Scan filter is the `0xfff0` service alone — deliberately not the "Cult" name
 * prefix. The plugin ANDs its filters, and white-label units in this family
 * advertise under several names (CS-BF01, Smart Scale, ...); a wrong name would
 * hide the user's scale. Frames that are not `0xCF` are dropped by the parser, so
 * picking an unrelated device shows up as "no reading" instead of corrupt data.
 */

import { Capacitor } from "@capacitor/core";
import {
	BATTERY_CHAR_UUID,
	BATTERY_SERVICE_UUID,
	MEASUREMENT_CHAR_UUID,
	SCALE_SERVICE_UUID,
} from "./protocol";
import type { ScaleConnectHandlers, ScaleConnection, ScaleTransport } from "./transport";

type BleClientApi = typeof import("@capacitor-community/bluetooth-le").BleClient;

let bleClient: Promise<BleClientApi> | null = null;
let initialized: Promise<void> | null = null;

async function loadBleClient(): Promise<BleClientApi> {
	if (!bleClient) {
		bleClient = import("@capacitor-community/bluetooth-le").then((m) => m.BleClient);
	}
	return bleClient;
}

/**
 * `initialize()` asserts that we never derive location from scan results, which is
 * what lets Android 12+ grant BLUETOOTH_SCAN without a location prompt. A failure
 * (permission denied, no radio) must not be cached, or every later attempt reuses
 * the rejected promise and the user can never recover without a reload.
 */
async function ensureInitialized(client: BleClientApi): Promise<void> {
	if (!initialized) {
		initialized = client.initialize({ androidNeverForLocation: true }).catch((err) => {
			initialized = null;
			throw bluetoothSetupError(err);
		});
	}
	await initialized;
}

function bluetoothSetupError(err: unknown): Error {
	const message = err instanceof Error ? err.message : String(err);
	if (/permission|rejected|denied/i.test(message)) {
		return new Error("Bluetooth permission was declined. Allow it in Settings → Apps → Lift Tracker → Permissions.");
	}
	if (/unavailable|not available|no bluetooth/i.test(message)) {
		return new Error("This device has no Bluetooth LE support.");
	}
	return err instanceof Error ? err : new Error(message);
}

export class NativeBleTransport implements ScaleTransport {
	readonly kind = "native" as const;

	isSupported(): boolean {
		return Capacitor.isNativePlatform();
	}

	unsupportedReason(): string | null {
		if (this.isSupported()) return null;
		return "Not running inside the app — this browser will use Web Bluetooth instead.";
	}

	async connect(handlers: ScaleConnectHandlers): Promise<ScaleConnection> {
		const client = await loadBleClient();
		await ensureInitialized(client);

		if (!(await client.isEnabled())) {
			// Android's system "turn on Bluetooth" prompt; ignored elsewhere.
			await client.requestEnable().catch(() => {});
			if (!(await client.isEnabled())) {
				throw new Error("Bluetooth is switched off. Turn it on and try again.");
			}
		}

		const device = await client.requestDevice({
			services: [SCALE_SERVICE_UUID],
			optionalServices: [BATTERY_SERVICE_UUID],
		});

		let onFrame: ScaleConnectHandlers["onFrame"] = handlers.onFrame;
		let onDisconnected: ScaleConnectHandlers["onDisconnected"] = handlers.onDisconnected;
		let closed = false;

		await client.connect(
			device.deviceId,
			() => {
				if (closed) return;
				onDisconnected();
			},
			{ timeout: 15_000 },
		);

		await client.startNotifications(device.deviceId, SCALE_SERVICE_UUID, MEASUREMENT_CHAR_UUID, (value) => {
			if (closed) return;
			onFrame(value);
		});

		return {
			label: device.name || "Cult Smart Scale",
			async disconnect() {
				if (closed) return;
				closed = true;
				// Detach the callbacks first: a teardown race must not surface a
				// "disconnected before a weight was captured" error for a session
				// the user already ended.
				onFrame = () => {};
				onDisconnected = () => {};
				await client
					.stopNotifications(device.deviceId, SCALE_SERVICE_UUID, MEASUREMENT_CHAR_UUID)
					.catch(() => {});
				await client.disconnect(device.deviceId).catch(() => {});
			},
			async readBattery() {
				// Optional standard service; most of these scales do not expose it.
				const value = await client
					.read(device.deviceId, BATTERY_SERVICE_UUID, BATTERY_CHAR_UUID, { timeout: 3_000 })
					.catch(() => null);
				if (!value || value.byteLength < 1) return null;
				const level = value.getUint8(0);
				return level <= 100 ? level : null;
			},
		};
	}
}

export const nativeTransport = new NativeBleTransport();
