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

export type ScaleConnection = {
	/** Advertised device name, stored with the reading as provenance. */
	label: string;
	disconnect(): Promise<void>;
	/** Best-effort battery percentage from the standard 0x180f service. */
	readBattery(): Promise<number | null>;
};

export type ScaleTransportKind = "native" | "web" | "sim";

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
}
