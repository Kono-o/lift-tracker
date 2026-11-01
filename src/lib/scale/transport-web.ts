/**
 * Web Bluetooth transport — Chrome/Edge on desktop and Android.
 *
 * Two constraints of the API shape this file:
 *   - `requestDevice()` needs a user activation, so it can only ever run from the
 *     Measure button's click handler.
 *   - it needs a secure context; a plain http:// LAN origin silently cannot see
 *     Bluetooth at all, which is worth telling the user instead of failing on a
 *     spinner.
 *
 * Safari and the Android Capacitor WebView do not implement Web Bluetooth at all;
 * iOS only reaches a scale through the Bluefy browser, so the UI offers manual
 * entry whenever this transport reports itself unsupported.
 *
 * Full 128-bit UUID strings are used rather than 16-bit integers: Bluefy's WebKit
 * stack rejects the short form, Chrome accepts both.
 */

import {
	BATTERY_CHAR_UUID,
	BATTERY_SERVICE_UUID,
	MEASUREMENT_CHAR_UUID,
	NAME_PREFIXES,
	SCALE_SERVICE_UUID,
} from "./protocol";
import type { ScaleConnection, ScaleTransport, ScaleConnectHandlers } from "./transport";

type BluetoothCharacteristic = {
	addEventListener(type: string, listener: (event: Event) => void): void;
	removeEventListener(type: string, listener: (event: Event) => void): void;
	startNotifications(): Promise<BluetoothCharacteristic>;
	stopNotifications(): Promise<BluetoothCharacteristic>;
	readValue(): Promise<DataView>;
};

type BluetoothService = {
	getCharacteristic(uuid: string): Promise<BluetoothCharacteristic>;
};

type BluetoothGATTServer = {
	connected: boolean;
	connect(): Promise<BluetoothGATTServer>;
	disconnect(): void;
	getPrimaryService(uuid: string): Promise<BluetoothService>;
};

type BluetoothDevice = {
	id: string;
	name?: string;
	gatt?: BluetoothGATTServer;
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
};

type Bluetooth = {
	requestDevice(options: Record<string, unknown>): Promise<BluetoothDevice>;
};

const getBluetooth = (): Bluetooth | null => {
	if (typeof navigator === "undefined") return null;
	const candidate = (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth;
	return candidate ?? null;
};

export class WebBluetoothTransport implements ScaleTransport {
	readonly kind = "web" as const;

	isSupported(): boolean {
		return getBluetooth() != null && typeof window !== "undefined" && window.isSecureContext;
	}

	unsupportedReason(): string | null {
		const bluetooth = getBluetooth();
		if (!bluetooth) {
			return "This browser cannot reach Bluetooth. Chrome or Edge on Android and desktop work; on iPhone use the Bluefy browser, or add the weigh-in manually.";
		}
		if (typeof window !== "undefined" && !window.isSecureContext) {
			return "Web Bluetooth only runs over HTTPS (or localhost). Open the app at its secure address, or add the weigh-in manually.";
		}
		return null;
	}

	async connect(handlers: ScaleConnectHandlers): Promise<ScaleConnection> {
		const bluetooth = getBluetooth();
		if (!bluetooth) throw new Error(this.unsupportedReason() ?? "Web Bluetooth unavailable");

		const device = await bluetooth.requestDevice({
			filters: [
				...NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
				{ services: [SCALE_SERVICE_UUID] },
			],
			optionalServices: [SCALE_SERVICE_UUID, BATTERY_SERVICE_UUID],
		});

		let closed = false;
		const onDisconnected = () => {
			closed = true;
			handlers.onDisconnected();
		};
		device.addEventListener("gattserverdisconnected", onDisconnected);
		let server: BluetoothGATTServer | null = null;
		let characteristic: BluetoothCharacteristic | null = null;
		const onValue = (event: Event) => {
			// The event target is the characteristic that owns the new DataView.
			const value = (event.target as unknown as { value?: DataView } | null)?.value;
			if (!closed && value) handlers.onFrame(value);
		};

		try {
			server = await device.gatt?.connect() ?? null;
			if (!server) throw new Error("Could not connect to the scale");

			const service = await server.getPrimaryService(SCALE_SERVICE_UUID);
			characteristic = await service.getCharacteristic(MEASUREMENT_CHAR_UUID);
			characteristic.addEventListener("characteristicvaluechanged", onValue);
			await characteristic.startNotifications();

			const activeServer = server;
			const activeCharacteristic = characteristic;
			let disconnected = false;
			return {
				label: device.name || "Cult scale",
				disconnect: async () => {
					if (disconnected) return;
					disconnected = true;
					closed = true;
					activeCharacteristic.removeEventListener("characteristicvaluechanged", onValue);
					activeCharacteristic.stopNotifications().catch(() => {});
					device.removeEventListener("gattserverdisconnected", onDisconnected);
					if (activeServer.connected) activeServer.disconnect();
				},
				readBattery: async () => {
					try {
						const batteryService = await activeServer.getPrimaryService(BATTERY_SERVICE_UUID);
						const battery = await batteryService.getCharacteristic(BATTERY_CHAR_UUID);
						const value = await battery.readValue();
						if (value.byteLength < 1) return null;
						const percent = value.getUint8(0);
						return percent <= 100 ? percent : null;
					} catch {
						// Most firmware in this family has no battery service; not an error.
						return null;
					}
				},
			};
		} catch (err) {
			closed = true;
			device.removeEventListener("gattserverdisconnected", onDisconnected);
			characteristic?.removeEventListener("characteristicvaluechanged", onValue);
			characteristic?.stopNotifications().catch(() => {});
			if (server?.connected) server.disconnect();
			throw err;
		}
	}
}

export const webTransport = new WebBluetoothTransport();
