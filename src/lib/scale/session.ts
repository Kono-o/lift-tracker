/**
 * Three-stage weigh-in state machine: weight, then heart rate, then composition.
 *
 * The order is not a UI choice — it is how these scales behave. A foot-only unit
 * streams weight while you settle; only once the weight is stable does it inject
 * the bioelectrical current, which is also when any heart-rate value appears. So
 * heart-rate and impedance samples are collected from the moment the weight locks
 * (dropping those frames would just make the user stand there longer), while the
 * stages name what the user is currently waiting on.
 *
 * Nothing is published until `stabilize.ts` agrees, so the saved number is the
 * median of an agreeing cluster rather than the first frame that arrived.
 *
 * Pure: no transport, no timers, no database. The client owns the clock and calls
 * `advance()` and `finalize()`; this turns frames into events.
 */

import {
	HYPOTHESIS_RANK,
	parseScaleFrame,
	type ImpedanceCandidate,
	type ImpedanceHypothesis,
	type ScalePhase,
} from "./protocol";
import {
	HEART_RATE_RULE,
	IMPEDANCE_RULE,
	StableSignal,
	WEIGHT_RULE,
} from "./stabilize";

export const MAX_SCALE_WEIGHT_KG = 500;

export type ScaleStage = "weigh" | "heart" | "composition" | "done";

export type MetricQuality = "locked" | "absent";

export type SettleMetric = "heart_rate" | "impedance";

export type ScaleReading = {
	weightKg: number;
	/** Stabilized device value, or null. Never a guess. */
	heartRate: number | null;
	/** Resolved ohms, or null when no byte map held still inside the band. */
	impedanceOhms: number | null;
	/** Which byte map produced `impedanceOhms`, so the UI can state its provenance. */
	impedanceSource: ImpedanceHypothesis | null;
	/** Raw device units behind the resolved ohms, kept for re-interpretation later. */
	impedanceRaw: number | null;
	quality: {
		weight: MetricQuality;
		heartRate: MetricQuality;
		impedance: MetricQuality;
	};
	/** Frames consumed — surfaced when a reading feels off and the user wants context. */
	frames: number;
};

export type StageSnapshot = {
	weightKg: number;
	locked: boolean;
	stage: ScaleStage;
	heart: SettleSnapshot;
	impedance: SettleSnapshot;
};

export type SettleSnapshot = {
	value: number | null;
	have: number;
	need: number;
	locked: boolean;
};

export type ScaleSessionEvent =
	| {
			kind: "live";
			weightKg: number;
			heartRate: number | null;
			impedanceOhms: number | null;
			phase: ScalePhase;
			locked: boolean;
	  }
	| { kind: "locked"; weightKg: number }
	| { kind: "stage"; stage: ScaleStage }
	| { kind: "settle"; metric: SettleMetric; have: number; need: number; value: number | null }
	| { kind: "complete"; reading: ScaleReading };

type ImpedanceReading = { hypothesis: ImpedanceHypothesis; ohms: number; raw: number };

export class ScaleSession {
	#weight = new StableSignal(WEIGHT_RULE);
	#heart = new StableSignal(HEART_RATE_RULE);
	/** One tracker per byte map: agreement must be agreement about the same reading. */
	#impedance = new Map<ImpedanceHypothesis, StableSignal>();
	#stage: ScaleStage = "weigh";
	#completed = false;
	#frames = 0;
	#bestImpedance: ImpedanceReading | null = null;

	get stage(): ScaleStage {
		return this.#stage;
	}

	get weightLocked(): boolean {
		return this.#weight.locked;
	}

	get heartLocked(): boolean {
		return this.#heart.locked;
	}

	get impedanceLocked(): boolean {
		return this.#bestImpedance != null;
	}

	get completed(): boolean {
		return this.#completed;
	}

	/** Everything the readout needs, including the unsettled live values. */
	peek(): StageSnapshot {
		const leading = this.#leadingImpedance();
		return {
			weightKg: this.#weight.value ?? this.#weight.latest ?? 0,
			locked: this.#weight.locked,
			stage: this.#stage,
			heart: settle(this.#heart),
			impedance: leading
				? { ...settle(leading.signal), value: this.#bestImpedance?.ohms ?? leading.signal.value ?? leading.signal.latest }
				: { value: null, have: 0, need: IMPEDANCE_RULE.needed, locked: false },
		};
	}

	handle(raw: Uint8Array | DataView): ScaleSessionEvent[] {
		if (this.#completed) return [];

		const frame = parseScaleFrame(raw);
		if (!frame) return [];

		if (frame.packet === "cf") {
			if (!frame.checksumOk) {
				// A corrupt frame must not count toward agreement for anything.
				return [];
			}
			this.#frames += 1;
		} else {
			this.#frames += 1;
		}

		const events: ScaleSessionEvent[] = [];
		const weightKg = frame.weightKg ?? 0;

		if (frame.packet === "cf" && !this.#weight.locked) {
			this.#weight.push(weightKg > MAX_SCALE_WEIGHT_KG ? null : weightKg);
			if (this.#weight.locked) {
				events.push({ kind: "locked", weightKg: this.#weight.value! });
				this.#enter("heart", events);
			}
		}

		// Composition and heart rate only start mattering once you are standing still.
		if (this.#weight.locked && !this.#completed) {
			if (frame.packet === "cf") {
				const wasLocked = this.#heart.locked;
				this.#heart.push(frame.heartRate);
				if (!wasLocked && this.#heart.locked) {
					events.push(settleEvent("heart_rate", this.#heart));
					this.#enter("composition", events);
				} else if (!this.#heart.locked) {
					events.push(settleEvent("heart_rate", this.#heart));
				}
			}
			if (frame.impedance.length) events.push(...this.#feedImpedance(frame.impedance));
		}

		if (this.#heart.locked && this.#bestImpedance && !this.#completed) {
			// Both optional signals are in. Waiting longer adds nothing.
			return events.concat(this.finalize("both"));
		}

		if (!this.#completed && frame.packet === "cf") {
			const leading = this.#leadingImpedance();
			events.push({
				kind: "live",
				weightKg: this.#weight.value ?? weightKg,
				heartRate: this.#heart.value ?? this.#heart.latest,
				impedanceOhms: this.#bestImpedance?.ohms ?? leading?.signal.value ?? leading?.signal.latest ?? null,
				phase: frame.phase,
				locked: this.#weight.locked,
			});
		}

		return events;
	}

	/**
	 * Client-driven stage advance: the heart-rate window has run out, so the readout
	 * moves on to composition even if no pulse ever agreed.
	 */
	advance(stage: Exclude<ScaleStage, "done">): ScaleSessionEvent[] {
		if (this.#completed) return [];
		const events: ScaleSessionEvent[] = [];
		if (rank(stage) > rank(this.#stage)) this.#enter(stage, events);
		return events;
	}

	/**
	 * Close the reading with whatever actually stabilized. Called on the body-phase
	 * timeout, an idle stream, or a link drop — a half-measurement is still a weigh-in.
	 */
	finalize(reason: "both" | "timeout" | "disconnect" | "idle"): ScaleSessionEvent[] {
		if (this.#completed) return [];
		if (!this.#weight.locked) {
			// No stable weight means no reading. The client reports "step on and hold
			// still" rather than offering a zero-kg save.
			return [];
		}
		this.#completed = true;
		const reading: ScaleReading = {
			weightKg: round3(this.#weight.value ?? 0),
			heartRate: this.#heart.locked ? Math.round(this.#heart.value!) : null,
			impedanceOhms: this.#bestImpedance ? round1(this.#bestImpedance.ohms) : null,
			impedanceSource: this.#bestImpedance?.hypothesis ?? null,
			impedanceRaw: this.#bestImpedance ? round1(this.#bestImpedance.raw) : null,
			quality: {
				weight: "locked",
				heartRate: this.#heart.locked ? "locked" : "absent",
				impedance: this.#bestImpedance ? "locked" : "absent",
			},
			frames: this.#frames,
		};
		this.#stage = "done";
		return [
			{ kind: "stage", stage: "done" },
			{ kind: "complete", reading },
		];
	}

	#feedImpedance(candidates: ImpedanceCandidate[]): ScaleSessionEvent[] {
		const events: ScaleSessionEvent[] = [];
		for (const candidate of candidates) {
			let signal = this.#impedance.get(candidate.hypothesis);
			if (!signal) {
				signal = new StableSignal(IMPEDANCE_RULE);
				this.#impedance.set(candidate.hypothesis, signal);
			}
			signal.push(candidate.ohms);
			if (!signal.locked) continue;
			// The frame that completed the lock carries the raw units. A signal that
			// agrees to within 5 ohms makes the pair consistent by definition.
			const next: ImpedanceReading = {
				hypothesis: candidate.hypothesis,
				ohms: signal.value!,
				raw: candidate.raw,
			};
			const incumbent = this.#bestImpedance;
			if (!incumbent || HYPOTHESIS_RANK[next.hypothesis] < HYPOTHESIS_RANK[incumbent.hypothesis]) {
				this.#bestImpedance = next;
				events.push(settleEvent("impedance", signal, next.ohms));
			}
		}
		if (!this.#bestImpedance) {
			const leading = this.#leadingImpedance();
			if (leading) events.push(settleEvent("impedance", leading.signal));
		}
		return events;
	}

	/** The byte map currently closest to agreement, for the live "2/4 stable" hint. */
	#leadingImpedance(): { hypothesis: ImpedanceHypothesis; signal: StableSignal } | null {
		let best: { hypothesis: ImpedanceHypothesis; signal: StableSignal } | null = null;
		for (const [hypothesis, signal] of this.#impedance) {
			if (!best || signal.progress.have > best.signal.progress.have) best = { hypothesis, signal };
		}
		return best;
	}

	#enter(stage: ScaleStage, events: ScaleSessionEvent[]): void {
		if (rank(stage) <= rank(this.#stage)) return;
		this.#stage = stage;
		events.push({ kind: "stage", stage });
	}
}

const STAGE_RANK: Record<ScaleStage, number> = { weigh: 0, heart: 1, composition: 2, done: 3 };
const rank = (stage: ScaleStage): number => STAGE_RANK[stage];

function settle(signal: StableSignal): SettleSnapshot {
	return {
		value: signal.value ?? signal.latest,
		have: signal.progress.have,
		need: signal.rule.needed,
		locked: signal.locked,
	};
}

function settleEvent(
	metric: SettleMetric,
	signal: StableSignal,
	override?: number,
): ScaleSessionEvent {
	return {
		kind: "settle",
		metric,
		have: signal.progress.have,
		need: signal.rule.needed,
		value: override ?? signal.value ?? signal.latest,
	};
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
