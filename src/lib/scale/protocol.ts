/**
 * Wire format for the Cult Smart Scale (CS-BF01) and the OneByone / CF36x family
 * it is white-labelled from.
 *
 * Ported from `anshuman852/occult` (MIT), js/ble/parser.js + js/ble/uuids.js, and
 * cross-checked against the same author's Go daemon (daemon/internal/protocol/frame.go).
 * The reverse engineering behind it credits openScale (GPLv3); only the protocol
 * knowledge is carried over here, not its code.
 *
 * GATT layout
 *   0xfff0 / 0xfff1  write   command pipe (OneByone FD/F1/F2 — unused, see note below)
 *   0xfff0 / 0xfff4  notify  every measurement frame
 *   0x180f / 0x2a19  read    standard battery level
 *
 * `0xCF` frame, 11 bytes, little-endian. For the verified foot-only CS-BF01, only
 * weight and the settling flag are reliable. Bytes that look like heart rate or
 * impedance are noise on this model and must not be stored as measurements.
 *
 * `0xCF` frame:
 *   0      marker  always 0xCF
 *   1-2    undocumented / unstable
 *   3-4    weight, uint16 LE, 0.01 kg units
 *   5-7    reserved / noise on the foot-only CS-BF01
 *   8      unknown
 *   9      status  0x01 = settling, 0x00 = locked (the Pro also uses 0x05/0x08)
 *   10     XOR of bytes 0..9
 *
 * Subscribing to 0xfff4 is enough; the scale streams without a handshake. occult
 * confirmed the OneByone `FD`/`F1`/`F2` handshake is accepted but changes nothing
 * (live frames stay weight-only and history comes back empty), so we do not send it.
 *
 * Honest limitation: an 8-electrode Cult *Pro* uses additional `0xBE` and `0xDF`
 * packets. Those packets are not decoded here. The client therefore records only
 * the verified weight from `0xCF`; it never interprets the other bytes as heart
 * rate or impedance.
 */

export const uuid16 = (short: number): string =>
	`0000${short.toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;

export const SCALE_SERVICE = 0xfff0;
export const WRITE_CHAR = 0xfff1;
export const MEASUREMENT_CHAR = 0xfff4;
export const BATTERY_SERVICE = 0x180f;
export const BATTERY_CHAR = 0x2a19;

export const SCALE_SERVICE_UUID = uuid16(SCALE_SERVICE);
export const WRITE_CHAR_UUID = uuid16(WRITE_CHAR);
export const MEASUREMENT_CHAR_UUID = uuid16(MEASUREMENT_CHAR);
export const BATTERY_SERVICE_UUID = uuid16(BATTERY_SERVICE);
export const BATTERY_CHAR_UUID = uuid16(BATTERY_CHAR);

/** Advertised name prefixes for this family. */
export const NAME_PREFIXES = ["Cult", "CULT"] as const;

const FRAME_LENGTH = 11;
const MARKER = 0xcf;
const STATUS_SETTLING = 0x01;
const STATUS_STABLE = 0x00;
const STATUS_HANDLE_MEASUREMENT = new Set([0x05, 0x08]);

export type ScalePhase = "weigh" | "body";

export type ScaleFrame = {
	phase: ScalePhase;
	/** 0.01 kg resolution, rounded to 2 dp. */
	weightKg: number;
	heartRate: number | null;
	/** Raw scale units, NOT ohms. Null on a unit with nothing real to report. */
	impedanceRaw: number | null;
	status: number;
	checksumOk: boolean;
};

const toBytes = (input: Uint8Array | DataView): Uint8Array =>
	input instanceof DataView
		? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
		: input;

/** Null for anything that is not a `0xCF` measurement frame. */
export function parseScaleFrame(raw: Uint8Array | DataView): ScaleFrame | null {
	const b = toBytes(raw);
	if (b.length !== FRAME_LENGTH || b[0] !== MARKER) return null;

	let xor = 0;
	for (let i = 0; i < FRAME_LENGTH - 1; i++) xor ^= b[i];

	const weightKg = Math.round((b[3] | (b[4] << 8)) / 100 * 100) / 100;
	const status = b[9];
	// 0x05/0x08 are used during handle measurement on the 8-electrode Pro. Keep
	// those weight frames visible as transitional only; without a verified 0x00
	// stable frame, the session must not offer a save. Unknown values are dropped.
	if (
		status !== STATUS_SETTLING &&
		status !== STATUS_STABLE &&
		!STATUS_HANDLE_MEASUREMENT.has(status)
	) return null;

	if (status !== STATUS_STABLE) {
		return { phase: "weigh", weightKg, heartRate: null, impedanceRaw: null, status, checksumOk: xor === b[10] };
	}
	return {
		phase: "body",
		weightKg,
		heartRate: null,
		impedanceRaw: null,
		status,
		checksumOk: xor === b[10],
	};
}

export function frameToHex(raw: Uint8Array | DataView): string {
	return Array.from(toBytes(raw))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join(" ");
}

/** Reference frames captured by occult (75.0 kg, then the same in body phase). */
export const REFERENCE_FRAMES = {
	weigh: new Uint8Array([0xcf, 0x00, 0x00, 0x4c, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x01, 0x9f]),
	body: new Uint8Array([0xcf, 0x3c, 0xc0, 0x4c, 0x1d, 0xf4, 0x01, 0x00, 0x00, 0x00, 0x97]),
	corrupt: new Uint8Array([0xcf, 0x00, 0x00, 0x92, 0x27, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00]),
};

/** Returns the list of decoder regressions; empty means the parser still matches the capture. */
export function cultSelfTest(): string[] {
	const failures: string[] = [];

	const weigh = parseScaleFrame(REFERENCE_FRAMES.weigh);
	if (!weigh || weigh.phase !== "weigh" || weigh.weightKg !== 75 || weigh.heartRate !== null || weigh.impedanceRaw !== null || weigh.checksumOk !== true) {
		failures.push("weigh frame decoded incorrectly");
	}

	const body = parseScaleFrame(REFERENCE_FRAMES.body);
	if (!body || body.phase !== "body" || body.weightKg !== 75 || body.heartRate !== null || body.impedanceRaw !== null || body.checksumOk !== true) {
		failures.push("body frame decoded incorrectly");
	}

	// The captured body frame has plausible-looking values in undocumented bytes.
	// They must stay unavailable rather than being presented as HR/impedance.
	const padded = new Uint8Array(REFERENCE_FRAMES.body.length + 4);
	padded.set(REFERENCE_FRAMES.body, 2);
	const view = parseScaleFrame(new DataView(padded.buffer, 2, REFERENCE_FRAMES.body.length));
	if (!view || view.weightKg !== 75 || view.heartRate !== null || view.impedanceRaw !== null) {
		failures.push("DataView offsets or unverified fields decoded incorrectly");
	}

	const corrupt = parseScaleFrame(REFERENCE_FRAMES.corrupt);
	if (!corrupt || corrupt.checksumOk !== false) failures.push("corrupt frame did not fail its checksum");

	if (parseScaleFrame(new Uint8Array([0xbe, ...REFERENCE_FRAMES.weigh.slice(1)])) !== null) {
		failures.push("a non-CF frame must not decode");
	}
	if (parseScaleFrame(REFERENCE_FRAMES.weigh.slice(0, 10)) !== null) {
		failures.push("a short frame must not decode");
	}

	return failures;
}
