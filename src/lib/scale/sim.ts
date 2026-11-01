/**
 * Scripted transport for developing the weigh-in flow without hardware.
 *
 * Enabled with `?scalesim=1` (kept on for the tab via localStorage) and it replays
 * captured `0xCF` frames on a realistic cadence. Each connect runs the next
 * scenario in turn so stable capture, bad frames, and disconnect recovery can be
 * rehearsed without a physical scale.
 */

import type { ScaleConnectHandlers, ScaleConnection, ScaleTransport } from "./transport";

const SIM_KEY = "lift-tracker-scale-sim";
export const SIM_FLAG = "scalesim";

/** Frame cadence of the real unit, roughly. */
const TICK_MS = 200;

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

type Step = { weightKg: number; status?: number; noise?: number; corrupt?: boolean };

type Scenario = {
	name: string;
	/** Frames streamed at TICK_MS intervals. */
	steps: Step[];
	/** Then the scale drops the link — the normal end of a real weigh-in. */
	powersOffAfterMs: number | null;
};

function frame(step: Step): Uint8Array {
	const raw = new Uint8Array(11);
	raw[0] = 0xcf;
	// These undocumented bytes intentionally look like plausible HR/impedance in
	// some frames. The parser must ignore them and capture only weight.
	raw[1] = step.noise ?? 0x3c;
	raw[2] = 0xc0;
	const weight = Math.round(step.weightKg * 100);
	raw[3] = weight & 0xff;
	raw[4] = (weight >> 8) & 0xff;
	raw[5] = step.noise ?? 0xf4;
	raw[6] = 0x01;
	raw[9] = step.status ?? 0x00;
	// A foot-only unit publishes noise where an 8-electrode Pro would put impedance.
	raw[7] = 0xba;
	raw[8] = 0xb5;
	let xor = 0;
	for (let i = 0; i < 10; i++) xor ^= raw[i];
	raw[10] = step.corrupt ? xor ^ 0x55 : xor;
	return raw;
}

const SCENARIOS: Scenario[] = [
	{
		name: "stable-weight",
		steps: [
			{ weightKg: 74.2, status: 0x01 },
			{ weightKg: 74.9, status: 0x01 },
			{ weightKg: 75.3, status: 0x01 },
			{ weightKg: 75.4 },
			{ weightKg: 75.4, noise: 0xc8 },
			{ weightKg: 75.4, noise: 0x3a },
		],
		powersOffAfterMs: 1_200,
	},
	{
		name: "checksum-noise",
		steps: [
			{ weightKg: 75.4 },
			{ weightKg: 75.4 },
			{ weightKg: 99.9, corrupt: true }, // resets the stable-frame candidate
			{ weightKg: 75.4 },
			{ weightKg: 75.4 },
			{ weightKg: 75.4 },
		],
		powersOffAfterMs: 1_200,
	},
	{
		name: "never-stable",
		steps: [
			{ weightKg: 81.0, status: 0x01 },
			{ weightKg: 81.0, status: 0x01 },
			{ weightKg: 81.0, status: 0x01 },
			{ weightKg: 81.0, status: 0x01 },
		],
		powersOffAfterMs: 500,
	},
];

export class ScaleSimTransport implements ScaleTransport {
	readonly kind = "sim" as const;
	#attempt = 0;

	isSupported(): boolean {
		return scaleSimEnabled();
	}

	unsupportedReason(): string | null {
		return scaleSimEnabled() ? null : "Add ?scalesim=1 to the URL to replay scale frames without hardware.";
	}

	async connect(handlers: ScaleConnectHandlers): Promise<ScaleConnection> {
		const scenario = SCENARIOS[this.#attempt % SCENARIOS.length];
		this.#attempt += 1;

		const timers: ReturnType<typeof setTimeout>[] = [];
		let disposed = false;

		scenario.steps.forEach((step, index) => {
			timers.push(
				setTimeout(() => {
					if (!disposed) handlers.onFrame(frame(step));
				}, (index + 1) * TICK_MS),
			);
		});

		if (scenario.powersOffAfterMs != null) {
			timers.push(
				setTimeout(() => {
					if (!disposed) handlers.onDisconnected();
				}, scenario.steps.length * TICK_MS + scenario.powersOffAfterMs),
			);
		}

		return {
			label: `Simulated scale (${scenario.name})`,
			async disconnect() {
				disposed = true;
				for (const timer of timers) clearTimeout(timer);
				timers.length = 0;
			},
			async readBattery() {
				return 84;
			},
		};
	}
}

export const simTransport = new ScaleSimTransport();
