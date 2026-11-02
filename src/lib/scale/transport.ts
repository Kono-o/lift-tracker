/**
 * Transport contract shared by the two ways this app reaches the scale:
 * the Capacitor BLE plugin (Android APK) and Web Bluetooth (Chrome/Edge desktop
 * and Android Chrome). Everything above this line — frame decoding, the weigh-in
 * state machine, saving — is identical for both.
 *
 * The Android WebView implements neither CoreBluetooth nor Web Bluetooth, so a
 * native build always uses the plugin transport; a browser tab always uses
 * navigator.bluetooth.
 */

export type ScaleFrameHandler = (bytes: Uint8Array | DataView) => void;

export type ScaleConnectHandlers = {
	onFrame: ScaleFrameHandler;
	onDisconnected: () => void;
};

/**
 * What one platform reported about one device. Each has a different idea of what it
 * knows: the plugin gives a bonded MAC and sometimes no signal, Web Bluetooth gives an
 * opaque per-origin token and no signal at all until an advertisement arrives.
 * `discovery.ts` turns these into one list.
 */
export type ScaleDeviceSeed = {
	id: string;
	name?: string | null;
	/** Paired at the OS level, so it can be listed before it ever advertises. */
	bonded?: boolean;
	/** The browser already has permission to reach this one without a picker. */
	remembered?: boolean;
	/** Present-only signal, dBm. Absent for bonded devices that are switched off. */
	rssi?: number | null;
};

/** Called for every sighting, including repeated ones — the board de-duplicates. */
export type ScaleDeviceHandler = (seed: ScaleDeviceSeed) => void;

export type ScaleConnection = {
	/** Advertised device name, stored with the reading as provenance. */
	label: string;
	disconnect(): Promise<void>;
	/** Best-effort battery percentage from the standard 0x180f service. */
	readBattery(): Promise<number | null>;
};

export type ScaleTransportKind = "native" | "web" | "sim";

/**
 * Enumeration is optional everywhere, because it is optional on the platforms:
 * a browser that cannot list or watch devices omits the members and the UI falls
 * back to `connect()`, which opens that platform's own picker. Callers must check
 * for the function rather than assume the kind.
 */
export interface ScaleTransport {
	readonly kind: ScaleTransportKind;
	/** False when this build/browser cannot possibly reach a scale. */
	isSupported(): boolean;
	/** Human explanation for `isSupported() === false`, surfaced in the UI. */
	unsupportedReason(): string | null;
	/**
	 * Must be called from a user activation: Web Bluetooth rejects a
	 * requestDevice() outside a click, and the plugin opens a picker.
	 */
	connect(handlers: ScaleConnectHandlers): Promise<ScaleConnection>;
	/** Devices this platform already knows about. No radio work, no picker. */
	listDevices?(): Promise<ScaleDeviceSeed[]>;
	/**
	 * Live advertisements, from a user activation. Resolves to a stop function and
	 * must also stop itself after its own window; the caller cannot hear a radio.
	 */
	startScan?(onDevice: ScaleDeviceHandler): Promise<() => void>;
	/** Reach a device the board already named, without putting up a picker. */
	connectTo?(id: string, handlers: ScaleConnectHandlers): Promise<ScaleConnection>;
}
