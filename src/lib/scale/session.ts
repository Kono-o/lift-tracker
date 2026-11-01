/**
 * The weigh-in state machine — pure, no timers and no I/O, so the exact sequence a
 * scale produces can be replayed from captured frames.
 *
 * Ported from occult (MIT): js/ble/client.js and daemon/internal/protocol/session.go.
 *
 * A weigh-in is two phases on the wire:
 *   1. weigh — the number settles, then repeats. We "lock" it after it is stable.
 *   2. body  — heart rate converges (and impedance lands on an 8-electrode unit),
 *              then the scale flashes the HR and powers itself off.
 *
 * Finishing on the weight lock alone would lose the heart rate, so after locking we
 * wait for HR to converge — and then make absolutely sure a reading still happens:
 * a scale that powers off (disconnect), a user who steps off early, and a scale that
 * streams forever each have their own exit. There is no path where the user stood
 * on the scale, the weight locked, and nothing was saved.
 */

import { parseScaleFrame, type ScaleFrame, type ScalePhase } from "./protocol";

/** Identical weight frames in a row before the weight counts as settled. */
export const WEIGHT_LOCK_FRAMES = 3;
/** Identical heart-rate frames (body phase) before the HR counts as converged. */
export const HR_LOCK_FRAMES = 3;
/** After the weight locks, force a reading if the scale lingers past this. */
export const MEASURE_TIMEOUT_MS = 30_000;
/** Frames stopped arriving (scale powered off mid-session) after lock. */
export const FRAME_IDLE_MS = 6_000;
/** Zero-weight frames after a lock: the user has stepped off. */
export const STEP_OFF_FRAMES = 2;

export type CompleteReason = "hr-stable" | "stepped-off" | "idle" | "timeout" | "disconnect" | "manual";

export type ScaleReading = {
	weightKg: number;
	heartRate: number | null;
	impedanceRaw: number | null;
	reason: CompleteReason;
};

export type ScaleSessionEvent =
	| { kind: "live"; weightKg: number; heartRate: number | null; phase: ScalePhase; locked: boolean }
	| { kind: "locked"; weightKg: number }
	| { kind: "measuring"; heartRate: number; hasImpedance: boolean; ticks: number }
	| { kind: "complete"; reading: ScaleReading };

export class ScaleSession {
	#lastWeight: number | null = null;
	#weightCount = 0;
	#locked = false;

	#latestHeartRate: number | null = null;
	#latestImpedance: number | null = null;

	#lastHeartRate: number | null = null;
	#heartRateCount = 0;

	#zeroWeightCount = 0;
	#completed = false;

	get weightLocked(): boolean {
		return this.#locked;
	}

	get completed(): boolean {
		return this.#completed;
	}

	/** Best-known values, for the live read-out before a reading is finalised. */
	peek(): { weightKg: number; heartRate: number | null; impedanceRaw: number | null; locked: boolean } {
		return {
			weightKg: this.#lastWeight ?? 0,
			heartRate: this.#latestHeartRate,
			impedanceRaw: this.#latestImpedance,
			locked: this.#locked,
		};
	}

	handle(raw: Uint8Array | DataView): ScaleSessionEvent[] {
		const frame: ScaleFrame | null = parseScaleFrame(raw);
		// A bad checksum means a corrupted notification: drop it rather than let it
		// break a lock that is already counting up.
		if (!frame || !frame.checksumOk) return [];

		const events: ScaleSessionEvent[] = [];
		events.push({
			kind: "live",
			weightKg: frame.weightKg,
			heartRate: frame.heartRate,
			phase: frame.phase,
			locked: this.#locked,
		});

		// Carry the latest body-phase values: the frames that lock the weight may
		// predate the HR read entirely.
		if (frame.phase === "body") {
			if (frame.heartRate != null) this.#latestHeartRate = frame.heartRate;
			if (frame.impedanceRaw != null) this.#latestImpedance = frame.impedanceRaw;
		}

		if (this.#locked && frame.weightKg <= 0) {
			if (++this.#zeroWeightCount >= STEP_OFF_FRAMES) {
				const done = this.#finish("stepped-off");
				if (done) events.push(done);
				return events;
			}
		} else {
			this.#zeroWeightCount = 0;
		}

		if (frame.weightKg > 0) {
			if (frame.weightKg === this.#lastWeight) this.#weightCount += 1;
			else {
				this.#lastWeight = frame.weightKg;
				this.#weightCount = 1;
			}
			if (!this.#locked && this.#weightCount >= WEIGHT_LOCK_FRAMES && this.#lastWeight != null) {
				this.#locked = true;
				events.push({ kind: "locked", weightKg: this.#lastWeight });
			}
		}

		// Foot-only scales hold status 0x00 the whole time, so gate on a heart rate
		// arriving rather than on a phase transition — and do not wait for impedance,
		// which occult proved such units never really report.
		if (this.#locked && frame.heartRate != null) {
			if (frame.heartRate === this.#lastHeartRate) this.#heartRateCount += 1;
			else {
				this.#lastHeartRate = frame.heartRate;
				this.#heartRateCount = 1;
			}
			events.push({
				kind: "measuring",
				heartRate: frame.heartRate,
				hasImpedance: this.#latestImpedance != null,
				ticks: this.#heartRateCount,
			});
			if (this.#heartRateCount >= HR_LOCK_FRAMES) {
				const done = this.#finish("hr-stable");
				if (done) events.push(done);
			}
		}

		return events;
	}

	/** The BLE layer calls this on disconnect, timeout, or a user hitting Done. */
	finalize(reason: CompleteReason): ScaleSessionEvent[] {
		const done = this.#finish(reason);
		return done ? [done] : [];
	}

	#finish(reason: CompleteReason): ScaleSessionEvent | null {
		if (this.#completed || !this.#locked || this.#lastWeight == null) return null;
		this.#completed = true;
		return {
			kind: "complete",
			reading: {
				weightKg: this.#lastWeight,
				heartRate: this.#latestHeartRate,
				impedanceRaw: this.#latestImpedance,
				reason,
			},
		};
	}
}
