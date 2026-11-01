/**
 * Weight capture state machine. The supported Cult `0xCF` stream reliably carries
 * weight and a settling flag; it does not reliably carry heart-rate or impedance.
 * A reading is ready after three identical, checksum-valid frames in the stable
 * phase. The transport and database are deliberately outside this pure module.
 */

import { parseScaleFrame, type ScalePhase } from "./protocol";

export const WEIGHT_LOCK_FRAMES = 3;
export const MAX_SCALE_WEIGHT_KG = 500;

export type ScaleReading = {
	weightKg: number;
	/** Not available from the verified Cult `0xCF` packet. */
	heartRate: null;
	/** Not available from the verified Cult `0xCF` packet. */
	impedanceRaw: null;
};

export type ScaleSessionEvent =
	| { kind: "live"; weightKg: number; heartRate: null; phase: ScalePhase; locked: boolean }
	| { kind: "locked"; weightKg: number }
	| { kind: "complete"; reading: ScaleReading };

export class ScaleSession {
	#candidateWeight: number | null = null;
	#candidateCount = 0;
	#locked = false;
	#completed = false;

	get weightLocked(): boolean {
		return this.#locked;
	}

	get completed(): boolean {
		return this.#completed;
	}

	/** Best-known live weight and whether it has passed the stable-frame check. */
	peek(): { weightKg: number; locked: boolean } {
		return { weightKg: this.#candidateWeight ?? 0, locked: this.#locked };
	}

	handle(raw: Uint8Array | DataView): ScaleSessionEvent[] {
		if (this.#completed) return [];

		const frame = parseScaleFrame(raw);
		if (!frame || !frame.checksumOk || frame.weightKg > MAX_SCALE_WEIGHT_KG) {
			// A bad frame must never contribute to the stable-weight count.
			this.#candidateWeight = null;
			this.#candidateCount = 0;
			return [];
		}

		const events: ScaleSessionEvent[] = [
			{
				kind: "live",
				weightKg: frame.weightKg,
				heartRate: null,
				phase: frame.phase,
				locked: this.#locked,
			},
		];

		// A changing/settling frame breaks the run. Count only identical positive
		// weights after the scale reports its stable/body phase.
		if (frame.phase !== "body" || frame.weightKg <= 0) {
			this.#candidateWeight = null;
			this.#candidateCount = 0;
			return events;
		}

		if (frame.weightKg === this.#candidateWeight) this.#candidateCount += 1;
		else {
			this.#candidateWeight = frame.weightKg;
			this.#candidateCount = 1;
		}

		if (this.#candidateCount >= WEIGHT_LOCK_FRAMES) {
			this.#locked = true;
			this.#completed = true;
			events.push({ kind: "locked", weightKg: frame.weightKg });
			events.push({
				kind: "complete",
				reading: { weightKg: frame.weightKg, heartRate: null, impedanceRaw: null },
			});
		}

		return events;
	}
}
