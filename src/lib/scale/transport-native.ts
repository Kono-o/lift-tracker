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
 *
 * Because the service filter is trusted, the scan results go straight on the board
 * unfiltered, and `bonded` devices — which are listed by the OS with no service
 * information at all — are the ones `discovery.ts` has to name-check.
 */

import { Capacitor } from "@capacitor/core";
import {
	BATTERY_CHAR_UUID,
	BATTERY_SERVICE_UUID,
	MEASUREMENT_CHAR_UUID,
	SCALE_SERVICE_UUID,
} from "./protocol";
import type {
	ScaleConnectHandlers,
	ScaleConnection,
	ScaleDeviceHandler,
	ScaleDeviceSeed,
	ScaleTransport,
} from "./transport";

type BleClientApi = typeof import("@capacitor-community/bluetooth-le").BleClient;
type BleDevice = Awaited<ReturnType<BleClientApi["getBondedDevices"]>>[number];

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

/** Everything but the picker: the stack is up and the radio is on. */
async function prepare(): Promise<BleClientApi> {
	const client = await loadBleClient();
	await ensureInitialized(client);
	if (!(await client.isEnabled())) {
		// Android's system "turn on Bluetooth" prompt; ignored elsewhere.
		await client.requestEnable().catch(() => {});
		if (!(await client.isEnabled())) {
			throw new Error("Bluetooth is switched off. Turn it on and try again.");
		}
	}
	return client;
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

/**
 * Link layer shared by both ways onto a device: the picker's choice and a tap on a
 * row of the in-app list. Disconnect ordering matters — the callbacks are detached
 * before teardown so an intentional cancel cannot arrive as a connection error.
 */
async function open(
	client: BleClientApi,
	deviceId: string,
	name: string | null,
	handlers: ScaleConnectHandlers,
): Promise<ScaleConnection> {
	let connected = false;
	let notificationsStarted = false;
	let closed = false;
	let onFrame = handlers.onFrame;
	let onDisconnected = handlers.onDisconnected;

	const stop = async () => {
		if (notificationsStarted) {
			await client.stopNotifications(deviceId, SCALE_SERVICE_UUID, MEASUREMENT_CHAR_UUID).catch(() => {});
		}
		if (connected) await client.disconnect(deviceId).catch(() => {});
	};

	try {
		await client.connect(
			deviceId,
			() => {
				if (closed) return;
				onDisconnected();
			},
			{ timeout: 15_000 },
		);
		connected = true;

		await client.startNotifications(deviceId, SCALE_SERVICE_UUID, MEASUREMENT_CHAR_UUID, (value) => {
			if (closed) return;
			onFrame(value);
		});
		notificationsStarted = true;

		return {
			label: name || "Cult Smart Scale",
			async disconnect() {
				if (closed) return;
				closed = true;
				onFrame = () => {};
				onDisconnected = () => {};
				await stop();
			},
			async readBattery() {
				// Optional standard service; most of these scales do not expose it.
				const value = await client
					.read(deviceId, BATTERY_SERVICE_UUID, BATTERY_CHAR_UUID, { timeout: 3_000 })
					.catch(() => null);
				if (!value || value.byteLength < 1) return null;
				const level = value.getUint8(0);
				return level <= 100 ? level : null;
			},
		};
	} catch (err) {
		closed = true;
		onFrame = () => {};
		onDisconnected = () => {};
		await stop();
		throw bluetoothSetupError(err);
	}
}

/** The OS knows the name; a scan result does not always, and the token does not at all. */
const seedFor = (device: BleDevice, bonded: boolean): ScaleDeviceSeed => ({
	id: device.deviceId,
	name: device.name ?? null,
	bonded,
});

export class NativeBleTransport implements ScaleTransport {
	readonly kind = "native" as const;

	isSupported(): boolean {
		return Capacitor.isNativePlatform();
	}

	unsupportedReason(): string | null {
		if (this.isSupported()) return null;
		return "Not running inside the app — this browser will use Web Bluetooth instead.";
	}

	/**
	 * Android keeps pairings the app did not make, so this is the one list that can
	 * name the user's scale before it switches on. Deliberately without the radio
	 * check: bonded devices are readable while Bluetooth is off, and the row tap is
	 * where "turn it on" belongs.
	 */
	async listDevices(): Promise<ScaleDeviceSeed[]> {
		const client = await loadBleClient();
		await ensureInitialized(client);
		const devices = await client.getBondedDevices();
		return devices.map((device) => seedFor(device, true));
	}

	async startScan(onDevice: ScaleDeviceHandler): Promise<() => void> {
		const client = await prepare();
		let stopped = false;
		await client.requestLEScan(
			{ services: [SCALE_SERVICE_UUID], optionalServices: [BATTERY_SERVICE_UUID] },
			(result) => {
				if (stopped) return;
				onDevice({
					id: result.device.deviceId,
					name: result.localName ?? result.device.name ?? null,
					rssi: typeof result.rssi === "number" ? result.rssi : null,
				});
			},
		);
		return () => {
			if (stopped) return;
			stopped = true;
			void client.stopLEScan().catch(() => {});
		};
	}

	async connectTo(deviceId: string, handlers: ScaleConnectHandlers): Promise<ScaleConnection> {
		const client = await prepare();
		// A scan result or pairing carries the name; the id alone does not, and the
		// label is stored with the reading as provenance.
		const known = await client.getDevices([deviceId]).catch(() => []);
		return open(client, deviceId, known[0]?.name ?? null, handlers);
	}

	async connect(handlers: ScaleConnectHandlers): Promise<ScaleConnection> {
		const client = await prepare();
		const device = await client.requestDevice({
			services: [SCALE_SERVICE_UUID],
			optionalServices: [BATTERY_SERVICE_UUID],
		});
		return open(client, device.deviceId, device.name ?? null, handlers);
	}
}

export const nativeTransport = new NativeBleTransport();
