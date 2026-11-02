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
 *
 * ## Why the list here is thinner than the one in the app
 *
 * `getDevices()` only returns devices this origin has already been granted, and
 * Chrome will not let one be connected by its token until it has been seen
 * advertising — so `watchAdvertisements()` is both the scan and a prerequisite for
 * `connectTo()`. A browser that refuses either call is not an error to report: the
 * scan resolves with nothing and the system picker stays on screen as the fallback.
 */

import {
	BATTERY_CHAR_UUID,
	BATTERY_SERVICE_UUID,
	MEASUREMENT_CHAR_UUID,
	NAME_PREFIXES,
	SCALE_SERVICE_UUID,
} from "./protocol";
import { SCAN_WINDOW_MS } from "./discovery";
import type { ScaleConnectHandlers, ScaleConnection, ScaleDeviceHandler, ScaleDeviceSeed, ScaleTransport } from "./transport";

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
	/** Chrome only: makes a saved device connectable, and the only way to see it nearby. */
	watchAdvertisements?(): Promise<void>;
	stopAdvertisements?(): void;
	addEventListener(type: string, listener: (event: Event) => void): void;
	removeEventListener(type: string, listener: (event: Event) => void): void;
};

type AdvertisementEvent = Event & { rssi?: number };

type Bluetooth = {
	requestDevice(options: Record<string, unknown>): Promise<BluetoothDevice>;
	/** Devices this origin was already allowed to reconnect to. */
	getDevices?(): Promise<BluetoothDevice[]>;
};

const getBluetooth = (): Bluetooth | null => {
	if (typeof navigator === "undefined") return null;
	const candidate = (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth;
	return candidate ?? null;
};

/** The device a `advertisementreceived` event belongs to. */
const eventDevice = (event: Event): BluetoothDevice | null =>
	((event.target as unknown as { device?: BluetoothDevice } | null)?.device) ?? null;

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

	/**
	 * Grants from earlier visits. Nothing new is discovered here — a scale that was
	 * never picked does not appear, which is why the picker stays on the sheet.
	 */
	async listDevices(): Promise<ScaleDeviceSeed[]> {
		const devices = await this.#saved();
		return devices.map((device) => ({
			id: device.id,
			name: device.name ?? null,
			remembered: true,
		}));
	}

	async #saved(): Promise<BluetoothDevice[]> {
		const bluetooth = getBluetooth();
		if (!bluetooth?.getDevices) return [];
		try {
			return await bluetooth.getDevices();
		} catch {
			return [];
		}
	}

	/**
	 * Watch every saved device for advertisements. Resolves to a stop function even
	 * when nothing could be watched, because "this browser will not tell us what is
	 * nearby" is a normal outcome here rather than a failure to report.
	 */
	async startScan(onDevice: ScaleDeviceHandler): Promise<() => void> {
		const devices = await this.#saved();
		const watched: BluetoothDevice[] = [];

		const onAdvertisement = (event: Event) => {
			const device = eventDevice(event);
			if (!device) return;
			const rssi = (event as AdvertisementEvent).rssi;
			onDevice({
				id: device.id,
				name: device.name ?? null,
				remembered: true,
				rssi: typeof rssi === "number" ? rssi : null,
			});
		};

		for (const device of devices) {
			if (!device.watchAdvertisements) continue;
			try {
				await device.watchAdvertisements();
			} catch {
				// Needs a user gesture, or the browser has the API but not the permission.
				continue;
			}
			device.addEventListener("advertisementreceived", onAdvertisement);
			watched.push(device);
		}

		return () => {
			for (const device of watched) {
				device.removeEventListener("advertisementreceived", onAdvertisement);
				device.stopAdvertisements?.();
			}
		};
	}

	/**
	 * Chrome will not open a GATT server for a saved device it has not recently seen,
	 * so a tap on a row has to wait for one advertisement first.
	 */
	async connectTo(deviceId: string, handlers: ScaleConnectHandlers): Promise<ScaleConnection> {
		const device = (await this.#saved()).find((candidate) => candidate.id === deviceId);
		if (!device) {
			throw new Error("That scale is not saved in this browser. Choose it from the list.");
		}
		if (!device.gatt?.connected) await this.#waitForAdvert(device);
		return this.#open(device, handlers);
	}

	async #waitForAdvert(device: BluetoothDevice): Promise<void> {
		const watch = device.watchAdvertisements;
		if (!watch) return;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				device.removeEventListener("advertisementreceived", onAdvert);
				device.stopAdvertisements?.();
				fn();
			};
			const onAdvert = (event: Event) => {
				if (eventDevice(event)?.id === device.id) finish(resolve);
			};
			const timer = setTimeout(
				() => finish(() => reject(new Error("The scale is not in range. Bring it closer and try again."))),
				SCAN_WINDOW_MS,
			);
			device.addEventListener("advertisementreceived", onAdvert);
			watch.call(device).catch(() => finish(() => reject(new Error("This browser will not show nearby scales. Pick it from the dialog instead."))));
		});
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
		return this.#open(device, handlers);
	}

	/** Link layer shared by the picker's choice and a tap on a row of the list. */
	async #open(device: BluetoothDevice, handlers: ScaleConnectHandlers): Promise<ScaleConnection> {
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
