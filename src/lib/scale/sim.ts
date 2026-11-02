/**
 * Scripted transport for developing the weigh-in flow without hardware.
 *
 * Enabled with `?scalesim=1` (kept on for the tab via localStorage) and it replays
 * `0xCF`/`0xBE` frames on the real unit's cadence. Each connect runs the next
 * scenario in turn, so the full read, the weight-only foot plate, corrupt frames,
 * a refused drift and an 8-electrode Pro can all be rehearsed on a laptop — including
 * the paths where the scale gives nothing extra and the reading still has to finish.
 */

import type {
	ScaleConnectHandlers,
	ScaleConnection,
	ScaleDeviceHandler,
	ScaleDeviceSeed,
	ScaleTransport,
} from "./transport";

const SIM_KEY = "lift-tracker-scale-sim";
export const SIM_FLAG = "scalesim";

/** Frame cadence of the real unit, roughly. */
const TICK_MS = 200;

/** Bytes 7-8 of a foot-only frame: documented as garbage, so it must never decode. */
const NOISE_RAW = 0xb5ba;

export function scaleSimEnabled(): boolean {
	if (typeof window === "undefined") return false;
	try {
		if (new URLSearchParams(window.location.search).get(SIM_FLAG) === "1") {
			window.localStorage.setItem(SIM_KEY, "1");
			return true;
		}
		return window.localStorage.getItem(SIM_KEY) === "1";
	} catch {
		return false;
	}
}

/** A weight-streaming frame. `heartRate` and `impedanceRaw` sit in the disputed slots. */
type CfStep = {
	packet?: "cf";
	weightKg: number;
	/** 0x01 = settling, 0x00 = stable. The Pro also uses 0x05/0x08. */
	status?: number;
	heartRate?: number;
	/** Bytes 5-6 little-endian, exactly as the device sends them. */
	impedanceRaw?: number;
	/** Break the XOR so the frame must be thrown away, not averaged. */
	corrupt?: boolean;
};

/** An 8-electrode composition packet: no weight, impedances only. */
type BeStep = { packet: "be"; wholeRaw: number; segmentRaw?: number };

type Step = CfStep | BeStep;

type Scenario = {
	name: string;
	/** Human summary shown in the readout so a pass can be followed without source. */
	expect: string;
	steps: Step[];
	/** Then the scale drops the link — the normal end of a real weigh-in. */
	powersOffAfterMs: number | null;
};

function cfFrame(step: CfStep): Uint8Array {
	const raw = new Uint8Array(11);
	const status = step.status ?? 0x00;
	const settling = status !== 0x00 && status !== 0x05 && status !== 0x08;
	raw[0] = 0xcf;
	raw[1] = step.heartRate ?? 0x00;
	// The capture this replays holds 0xc0 in byte 2 once the body phase starts, which
	// is what pushes the big-endian byte-map reading far outside the valid band.
	raw[2] = settling ? 0x00 : 0xc0;
	const weight = Math.round(step.weightKg * 100);
	raw[3] = weight & 0xff;
	raw[4] = (weight >> 8) & 0xff;
	const impedance = step.impedanceRaw ?? NOISE_RAW;
	raw[5] = impedance & 0xff;
	raw[6] = (impedance >> 8) & 0xff;
	raw[7] = 0xba;
	raw[8] = 0xb5;
	raw[9] = status;
	let xor = 0;
	for (let i = 0; i < 10; i++) xor ^= raw[i];
	raw[10] = step.corrupt ? xor ^ 0x55 : xor;
	return raw;
}

function beFrame(step: BeStep): Uint8Array {
	const raw = new Uint8Array(12);
	raw[0] = 0xbe;
	raw[1] = 0x05;
	const values = [step.segmentRaw ?? 0, 0, step.wholeRaw, 0, 0];
	values.forEach((value, index) => {
		raw[2 + index * 2] = value & 0xff;
		raw[3 + index * 2] = (value >> 8) & 0xff;
	});
	return raw;
}

const buildFrame = (step: Step): Uint8Array =>
	step.packet === "be" ? beFrame(step) : cfFrame(step);

/** Weight marching toward the plateau while the scale is still settling. */
function settling(weights: number[]): Step[] {
	return weights.map((weightKg) => ({ weightKg, status: 0x01 }));
}

/** `count` stable-phase frames repeating one weight, with the optional signals given. */
function holding(
	weightKg: number,
	count: number,
	options: { heartRate?: number[]; impedanceRaw?: number; corruptEvery?: number } = {},
): Step[] {
	return Array.from({ length: count }, (_, index) => ({
		weightKg,
		status: 0x00,
		heartRate: options.heartRate?.[index % (options.heartRate.length || 1)],
		impedanceRaw: options.impedanceRaw,
		corrupt: options.corruptEvery != null && (index + 1) % options.corruptEvery === 0,
	}));
}

/** Interleave composition packets between the weight frames. */
function withBe(steps: Step[], every: number, wholeRaw: number): Step[] {
	const out: Step[] = [];
	steps.forEach((step, index) => {
		out.push(step);
		if ((index + 1) % every === 0) out.push({ packet: "be", wholeRaw });
	});
	return out;
}

const SCENARIOS: Scenario[] = [
	{
		name: "full-read",
		expect: "weight, pulse and resistance all lock",
		steps: [
			...settling([74.2, 75.0, 75.4, 75.3]),
			...holding(75.3, 9, { heartRate: [62, 62, 63, 61, 62, 62, 62], impedanceRaw: 500 }),
		],
		powersOffAfterMs: 1_500,
	},
	{
		name: "weight-only",
		expect: "foot plate: weight locks, nothing else ever agrees",
		steps: [
			...settling([74.2, 75.0, 75.4, 75.3, 75.3]),
			...holding(75.3, 12, { heartRate: [0], impedanceRaw: NOISE_RAW }),
		],
		powersOffAfterMs: 1_000,
	},
	{
		name: "corrupt-frames",
		expect: "checksum failures are skipped, pulse still locks, resistance times out",
		steps: [
			...settling([80.0, 79.2, 78.6, 78.4]),
			...holding(78.4, 16, { heartRate: [68], corruptEvery: 4 }),
		],
		// Keeps streaming so the composition window has to be what closes the reading.
		powersOffAfterMs: null,
	},
	{
		name: "drifting-weight",
		// One step per frame, always past the 0.05 kg tolerance: the cluster rule must
		// refuse it instead of averaging a march into something that looks settled.
		expect: "a marching weight is never published",
		steps: [
			...settling([81.0]),
			...Array.from({ length: 10 }, (_, index) => ({ weightKg: 81 + index * 0.1, status: 0x00 })),
		],
		powersOffAfterMs: 300,
	},
	{
		name: "pro-8-electrode",
		expect: "0xBE whole-body resistance locks at 455 ohms",
		steps: withBe(
			[...settling([70.0, 71.2, 71.8, 71.8, 71.8, 71.8, 71.8, 71.8]), ...holding(71.8, 8, { heartRate: [58] })],
			2,
			4550,
		),
		powersOffAfterMs: 1_500,
	},
	{
		name: "never-stable",
		expect: "settling forever then link drop: an error, not a zero-kg reading",
		steps: [...settling([82.0, 82.6, 82.3, 82.9, 82.4, 82.8])],
		powersOffAfterMs: 200,
	},
];

export const SCENARIO_NAMES = SCENARIOS.map((s) => s.name);

/**
 * A roster to rehearse the device list with, including the cases that only make
 * sense as a group: somebody else's headphones in the pairings, an unnamed pairing,
 * a saved unit, and one scale that reaches the board twice — paired once and
 * advertised once — and must stay a single row.
 */
const PAIRED_DEVICES: ScaleDeviceSeed[] = [
	{ id: "F0:D8:03:2A:BC:01", name: "Cult Smart Scale", bonded: true },
	{ id: "9C:04:8B:11:22:33", name: "WH-1000XM4", bonded: true },
	{ id: "74:BC:20:00:00:00", bonded: true },
	{ id: "E8:EB:1B:44:55:66", name: "Qingzhimai S2", remembered: true },
];

const ADVERTISING_DEVICES: ScaleDeviceSeed[] = [
	{ id: "CF:EE:12:34:56:78", name: "CS-BF01", rssi: -58 },
	{ id: "F0:D8:03:2A:BC:01", name: "Cult Smart Scale", rssi: -64 },
	{ id: "A5:B6:C7:D8:E9:FA", rssi: -77 },
];

export class ScaleSimTransport implements ScaleTransport {
	readonly kind = "sim" as const;
	#attempt: number;
	#tickMs: number;

	constructor(options: { startAt?: number; tickMs?: number } = {}) {
		this.#attempt = options.startAt ?? 0;
		this.#tickMs = options.tickMs ?? TICK_MS;
	}

	isSupported(): boolean {
		return scaleSimEnabled();
	}

	unsupportedReason(): string | null {
		return scaleSimEnabled() ? null : "Add ?scalesim=1 to the URL to replay scale frames without hardware.";
	}

	get scenarioName(): string {
		return SCENARIOS[this.#attempt % SCENARIOS.length].name;
	}

	async listDevices(): Promise<ScaleDeviceSeed[]> {
		return PAIRED_DEVICES.map((device) => ({ ...device }));
	}

	async startScan(onDevice: ScaleDeviceHandler): Promise<() => void> {
		const timers: Array<ReturnType<typeof setTimeout>> = [];
		let stopped = false;
		// The second sighting of one unit is the point: it must land on the same row.
		[...ADVERTISING_DEVICES, ADVERTISING_DEVICES[1]].forEach((device, index) => {
			timers.push(
				setTimeout(() => {
					if (stopped) return;
					onDevice({ ...device, rssi: (device.rssi ?? -70) + (index % 3) });
				}, (index + 1) * this.#tickMs * 4),
			);
		});
		return () => {
			stopped = true;
			for (const timer of timers) clearTimeout(timer);
			timers.length = 0;
		};
	}

	async connect(handlers: ScaleConnectHandlers): Promise<ScaleConnection> {
		return this.#run("Cult Smart Scale", handlers);
	}

	async connectTo(deviceId: string, handlers: ScaleConnectHandlers): Promise<ScaleConnection> {
		const known = [...PAIRED_DEVICES, ...ADVERTISING_DEVICES].find((device) => device.id === deviceId);
		if (!known) throw new Error(`The simulated roster has no ${deviceId}.`);
		return this.#run(known.name ?? "Unnamed scale", handlers);
	}

	#run(label: string, handlers: ScaleConnectHandlers): Promise<ScaleConnection> {
		const scenario = SCENARIOS[this.#attempt % SCENARIOS.length];
		this.#attempt += 1;

		const timers: ReturnType<typeof setTimeout>[] = [];
		let disposed = false;

		scenario.steps.forEach((step, index) => {
			timers.push(
				setTimeout(() => {
					if (!disposed) handlers.onFrame(buildFrame(step));
				}, (index + 1) * this.#tickMs),
			);
		});

		if (scenario.powersOffAfterMs != null) {
			timers.push(
				setTimeout(() => {
					if (!disposed) handlers.onDisconnected();
				}, scenario.steps.length * this.#tickMs + scenario.powersOffAfterMs),
			);
		}

		return Promise.resolve({
			label: `${label} (${scenario.name})`,
			async disconnect() {
				disposed = true;
				for (const timer of timers) clearTimeout(timer);
				timers.length = 0;
			},
			async readBattery() {
				return 84;
			},
		});
	}
}

export const simTransport = new ScaleSimTransport();
