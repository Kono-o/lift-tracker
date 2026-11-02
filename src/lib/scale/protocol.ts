/**
 * Wire format for the Cult Smart Scale (CS-BF01) and the OneByone / CF36x family
 * it is white-labelled from.
 *
 * Ported from `anshuman852/occult` (MIT), js/ble/parser.js + js/ble/uuids.js, and
 * cross-checked against the same author's Go daemon (daemon/internal/protocol/frame.go).
 * The reverse engineering behind it credits openScale (GPLv3); the impedance byte
 * maps below are taken from that family's public decoders.
 *
 * GATT layout
 *   0xfff0 / 0xfff1  write   command pipe (OneByone FD/F1/F2 — unused, see note below)
 *   0xfff0 / 0xfff4  notify  every measurement frame
 *   0x180f / 0x2a19  read    standard battery level
 *
 * `0xCF` frame, 11 bytes, little-endian:
 *   0      marker  always 0xCF
 *   1-2    disputed — see "what is honest about these bytes" below
 *   3-4    weight, uint16 LE, 0.01 kg units
 *   5-7    reserved / claimed noise on the foot-only CS-BF01
 *   8      unknown
 *   9      status  0x01 = settling, 0x00 = locked (the Pro also uses 0x05/0x08)
 *   10     XOR of bytes 0..9
 *
 * `0xBE` packet (8-electrode Cult Pro only): five uint16 LE impedance values at
 * bytes 2..11. Index 2 is the whole-body leg-to-leg value. The foot-only unit
 * never emits it.
 *
 * Subscribing to 0xfff4 is enough; the scale streams without a handshake. occult
 * confirmed the OneByone `FD`/`F1`/`F2` handshake is accepted but changes nothing,
 * so we do not send it.
 *
 * ## What is honest about bytes 1, 2 and 5-6
 *
 * The sources disagree with each other, and we cannot audit the hardware:
 *   - occult's `research/cult_scale_protocol.md` says byte 1 "often lands in the
 *     heart-rate range but is not a stable value" and bytes 5-7 are "different
 *     garbage every session — NOT a usable impedance".
 *   - occult's own shipping `parser.js` and `frame.go` read byte 1 as heart rate
 *     and bytes 5-6 as raw impedance.
 *   - openScale's `OneByoneHandler` reads impedance as big-endian bytes 1-2 × 0.1
 *     and treats byte 1 as a flag byte (`0x80` = handle measurement) — no heart
 *     rate at all for this family.
 *
 * So this module does not pick a winner. It publishes *candidates*: every reading
 * a byte map could produce, tagged with which map produced it. Bytes that are
 * genuinely garbage fail two independent filters — the physiologic band and, in
 * `stabilize.ts`, agreement across several frames — and disappear. A real signal
 * survives both. Nothing here is stored as a measurement until it does.
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
const MARKER_CF = 0xcf;
const MARKER_BE = 0xbe;
const STATUS_SETTLING = 0x01;
const STATUS_STABLE = 0x00;
const STATUS_HANDLE_MEASUREMENT = new Set([0x05, 0x08]);

/** Heart rate is only meaningful inside a resting weigh-in window. */
export const HEART_RATE_MIN = 30;
export const HEART_RATE_MAX = 220;
/** The Janssen/Sun BIA equations are only used inside their published data range. */
export const OHMS_MIN = 150;
export const OHMS_MAX = 1200;

export type ScalePhase = "weigh" | "body";

/** Which byte map a candidate came from, ordered by how well documented it is. */
export type ImpedanceHypothesis =
	| "be-wholebody"
	| "b1b2-be-x0.1"
	| "b5b6-x1"
	| "b5b6-x0.1"
	| "b5b6-x0.03036";

/** Trust order — used to break ties when several maps agree. */
export const HYPOTHESIS_RANK: Record<ImpedanceHypothesis, number> = {
	"be-wholebody": 0,
	"b1b2-be-x0.1": 1,
	"b5b6-x1": 2,
	"b5b6-x0.1": 3,
	"b5b6-x0.03036": 4,
};

export const HYPOTHESIS_LABEL: Record<ImpedanceHypothesis, string> = {
	"be-wholebody": "0xBE whole-body (8-electrode Pro)",
	"b1b2-be-x0.1": "bytes 1–2 big-endian ×0.1",
	"b5b6-x1": "bytes 5–6, ohms as published",
	"b5b6-x0.1": "bytes 5–6 ×0.1",
	"b5b6-x0.03036": "bytes 5–6 ×0.03036",
};

/**
 * One possible reading of this frame's impedance bytes. `raw` is the value the
 * device actually sent, un-scaled, so the resolved ohms keep their provenance and
 * a later reinterpretation does not have to guess which factor produced them.
 */
export type ImpedanceCandidate = { hypothesis: ImpedanceHypothesis; ohms: number; raw: number };

export type ScaleFrame = {
	/** `be` packets carry composition only — no weight, no status semantics. */
	packet: "cf" | "be";
	phase: ScalePhase;
	/** Null for a `0xBE` packet: it never restates the weight. */
	weightKg: number | null;
	/** Candidate, not a measurement — byte 1 is disputed (see header). */
	heartRate: number | null;
	/** All in-band impedance readings this packet supports, best-ranked first. */
	impedance: ImpedanceCandidate[];
	status: number;
	checksumOk: boolean;
};

const toBytes = (input: Uint8Array | DataView): Uint8Array =>
	input instanceof DataView
		? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
		: input;

const inBand = (ohms: number): boolean => Number.isFinite(ohms) && ohms >= OHMS_MIN && ohms <= OHMS_MAX;

/** Ranked, de-duplicated, band-checked — worst rank last, no duplicate values. */
function candidates(entries: Array<ImpedanceCandidate | null>): ImpedanceCandidate[] {
	const seen = new Map<number, ImpedanceCandidate>();
	for (const entry of entries) {
		if (!entry || !inBand(entry.ohms)) continue;
		const key = Math.round(entry.ohms * 10) / 10;
		const current = seen.get(key);
		if (!current || HYPOTHESIS_RANK[entry.hypothesis] < HYPOTHESIS_RANK[current.hypothesis]) {
			seen.set(key, entry);
		}
	}
	return [...seen.values()].sort(
		(a, b) => HYPOTHESIS_RANK[a.hypothesis] - HYPOTHESIS_RANK[b.hypothesis],
	);
}
/**
 * A `0xBE` body-composition packet: five uint16 LE impedances at bytes 2..11.
 * Index 2 is the whole-body value. Byte 1 holds a count/scale tag on the units
 * that send these, so it is deliberately not read as anything else here.
 */
function parseBePacket(b: Uint8Array, checksumOk: boolean): ScaleFrame {
	const whole = b[2 + 2 * 2] | (b[2 + 2 * 2 + 1] << 8);
	const segment = b[2] | (b[3] << 8);
	return {
		packet: "be",
		phase: "body",
		weightKg: null,
		heartRate: null,
		impedance: candidates([
			{ hypothesis: "be-wholebody", ohms: whole, raw: whole },
			{ hypothesis: "be-wholebody", ohms: whole * 0.1, raw: whole },
			{ hypothesis: "be-wholebody", ohms: segment, raw: segment },
		]),
		status: 0,
		checksumOk,
	};
}

/** Null for anything that is not a `0xCF` or `0xBE` packet. */
export function parseScaleFrame(raw: Uint8Array | DataView): ScaleFrame | null {
	const b = toBytes(raw);
	if (b.length < FRAME_LENGTH) return null;

	let xor = 0;
	for (let i = 0; i < FRAME_LENGTH - 1; i++) xor ^= b[i];

	if (b[0] === MARKER_BE) {
		// The XOR convention is only verified for 0xCF. Asserting one here would
		// silently disable the 8-electrode path, so BE packets pass the byte-level
		// check and are filtered by band + frame agreement instead.
		return parseBePacket(b, true);
	}
	if (b[0] !== MARKER_CF) return null;

	const weightKg = Math.round((b[3] | (b[4] << 8)) / 100 * 100) / 100;
	const status = b[9];
	if (
		status !== STATUS_SETTLING &&
		status !== STATUS_STABLE &&
		!STATUS_HANDLE_MEASUREMENT.has(status)
	) {
		return null;
	}

	// Byte 1 doubles as a flag byte in openScale's decoder; the two values that
	// mean "handle measurement" are never a plausible resting heart rate.
	const hrByte = b[1];
	const heartRate =
		hrByte >= HEART_RATE_MIN && hrByte <= HEART_RATE_MAX && hrByte !== 0x80 && hrByte !== 0xff
			? hrByte
			: null;

	const raw56 = b[5] | (b[6] << 8);
	const be12 = ((b[2] << 8) | b[1]) * 0.1;

	return {
		packet: "cf",
		phase: status === STATUS_STABLE ? "body" : "weigh",
		weightKg,
		heartRate,
		impedance: candidates([
			{ hypothesis: "b1b2-be-x0.1", ohms: be12, raw: (b[2] << 8) | b[1] },
			{ hypothesis: "b5b6-x1", ohms: raw56, raw: raw56 },
			{ hypothesis: "b5b6-x0.1", ohms: raw56 * 0.1, raw: raw56 },
			{ hypothesis: "b5b6-x0.03036", ohms: raw56 * 0.03036, raw: raw56 },
		]),
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
	// 8-electrode Pro: whole-body (index 2) = 4550 raw -> 455.0 ohms.
	pro: new Uint8Array([0xbe, 0x05, 0x00, 0x00, 0x00, 0x00, 0xc6, 0x11, 0x00, 0x00, 0x00, 0x00]),
};

/** Returns the list of decoder regressions; empty means the parser still matches the capture. */
export function cultSelfTest(): string[] {
	const failures: string[] = [];
	const check = (label: string, ok: boolean) => {
		if (!ok) failures.push(label);
	};

	const weigh = parseScaleFrame(REFERENCE_FRAMES.weigh);
	check("weigh frame must decode at 75 kg", weigh != null && weigh.weightKg === 75);
	check("weigh phase stays transitional", weigh?.phase === "weigh");
	// Byte 1 is 0x00 while settling, so there is no heart-rate candidate to publish.
	check("weigh frame has no heart rate", weigh?.heartRate === null);
	check("weigh frame has no in-band impedance", weigh?.impedance.length === 0);
	check("weigh checksum ok", weigh?.checksumOk === true);

	const body = parseScaleFrame(REFERENCE_FRAMES.body);
	check("body frame decodes at 75 kg", body?.weightKg === 75);
	check("body frame is the body phase", body?.phase === "body");
	// byte1 = 0x3c: a candidate, not a promise.
	check("body frame offers a 60 bpm candidate", body?.heartRate === 60);
	// b5|b6<<8 = 500 raw. Unscaled that is 500 ohms, which is exactly where
	// openScale says this family's BIA equations are valid (500 ± 100).
	check(
		"body frame offers the unscaled 500 ohm reading",
		body?.impedance.some((c) => c.hypothesis === "b5b6-x1" && Math.abs(c.ohms - 500) < 0.05) === true,
	);
	// Bytes 1-2 big-endian x0.1 on the same frame is 4921 ohms: out of band, gone.
	check(
		"out-of-band byte maps are dropped",
		body?.impedance.every((c) => c.hypothesis !== "b1b2-be-x0.1") === true,
	);

	const pro = parseScaleFrame(REFERENCE_FRAMES.pro);
	check("0xBE packet parses", pro?.packet === "be");
	check("0xBE carries no weight", pro?.weightKg === null);
	check(
		"0xBE whole-body reads 455 ohms",
		pro?.impedance.some((c) => Math.abs(c.ohms - 455) < 0.05) === true,
	);

	const padded = new Uint8Array(REFERENCE_FRAMES.body.length + 4);
	padded.set(REFERENCE_FRAMES.body, 2);
	const view = parseScaleFrame(new DataView(padded.buffer, 2, REFERENCE_FRAMES.body.length));
	check("DataView offsets decode", view?.weightKg === 75);

	const corrupt = parseScaleFrame(REFERENCE_FRAMES.corrupt);
	check("corrupt frame fails its checksum", corrupt?.checksumOk === false);
	check("a 0xCC frame must not decode", parseScaleFrame(new Uint8Array([0xcc, ...REFERENCE_FRAMES.weigh.slice(1)])) === null);
	check("a short frame must not decode", parseScaleFrame(REFERENCE_FRAMES.weigh.slice(0, 10)) === null);

	// 0x80 means "handle measurement" in openScale; it must never become 128 bpm.
	const flagged = new Uint8Array(REFERENCE_FRAMES.body);
	flagged[1] = 0x80;
	check("flag byte is not a heart rate", parseScaleFrame(flagged)?.heartRate === null);

	return failures;
}
