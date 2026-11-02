/**
 * Stabilization primitives for a streaming sensor that flickers.
 *
 * A scale does not send one true number: it sends a stream that jitters while the
 * user is still settling, then repeats itself. Taking the first frame — or the
 * loudest one — is what makes a weigh-in bounce. Every value this app publishes
 * goes through here, so it is the median of an agreeing cluster, never a sample.
 *
 * The cluster rule instead of "N consecutive equal frames" (what occult does) is
 * deliberate: one dropout, one 0.1 kg flicker, or one corrupt frame mid-standing
 * must not reset the count and strand the user on "hold still" forever. Values
 * that drift more than `tolerance` apart never agree, so a slow drift is refused
 * rather than averaged into something that looks stable.
 */

export type StabilityRule = {
	/** Frames that must agree before a value is published. */
	needed: number;
	/** Max distance between two samples for them to count as the same reading. */
	tolerance: number;
	/** Rolling window kept; older samples drop out so a step-off is noticed. */
	window: number;
	/** Reject anything outside this band — noise, not a measurement. */
	min?: number;
	max?: number;
};

export class StableSignal {
	#samples: number[] = [];
	#cluster: number[] = [];
	/** Size of the best agreeing run right now, so a UI can show "3 of 4". */
	#best = 0;
	#locked = false;
	#rejected = 0;
	#rule: StabilityRule;

	constructor(rule: StabilityRule) {
		this.#rule = rule;
	}

	get rule(): StabilityRule {
		return this.#rule;
	}

	/** Samples seen, including out-of-band ones that were thrown away. */
	get seen(): number {
		return this.#samples.length + this.#rejected;
	}

	get locked(): boolean {
		return this.#locked;
	}

	/** The published value, or null while it is still settling. */
	get value(): number | null {
		return this.#locked ? median(this.#cluster) : null;
	}

	/** Latest in-band reading, for the live ticker — never offered as a result. */
	get latest(): number | null {
		return this.#samples.length ? this.#samples[this.#samples.length - 1] : null;
	}

	get progress(): { have: number; need: number } {
		return { have: this.#locked ? this.#cluster.length : this.#best, need: this.#rule.needed };
	}

	/** The agreeing samples behind the published median. */
	get agreeing(): number[] {
		return [...this.#cluster];
	}

	/**
	 * Add a sample. `null` and out-of-band values count as "nothing to see" and
	 * leave the cluster alone; a corrupt frame is the caller's job to skip.
	 */
	push(value: number | null | undefined): void {
		if (value == null || !Number.isFinite(value)) return;
		const { min, max } = this.#rule;
		if (min != null && value < min) {
			this.#rejected += 1;
			return;
		}
		if (max != null && value > max) {
			this.#rejected += 1;
			return;
		}

		this.#samples.push(value);
		if (this.#samples.length > this.#rule.window) this.#samples.shift();
		if (this.#locked) {
			// Keep refining with every frame that still agrees; late samples are the
			// most settled ones, and the median stops moving once they do.
			if (this.#cluster.every((v) => Math.abs(v - value) <= this.#rule.tolerance)) {
				this.#cluster.push(value);
				if (this.#cluster.length > this.#rule.window) this.#cluster.shift();
			}
			return;
		}

		const cluster = largestCluster(this.#samples, this.#rule.tolerance);
		this.#best = cluster.length;
		if (cluster.length >= this.#rule.needed) {
			this.#cluster = cluster;
			this.#locked = true;
		}
	}

	/** True once the stream stopped agreeing with the published value. */
	drifted(): boolean {
		const value = this.value;
		const latest = this.latest;
		return value != null && latest != null && Math.abs(latest - value) > this.#rule.tolerance;
	}

	reset(): void {
		this.#samples = [];
		this.#cluster = [];
		this.#best = 0;
		this.#locked = false;
		this.#rejected = 0;
	}
}

export function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Longest subset of `values` whose spread fits inside `tolerance`. Sorting makes
 * this a two-pointer sweep: any cluster in 1-D is contiguous once sorted.
 */
export function largestCluster(values: number[], tolerance: number): number[] {
	if (values.length === 0) return [];
	const sorted = [...values].sort((a, b) => a - b);
	let best: number[] = [];
	let left = 0;
	for (let right = 0; right < sorted.length; right++) {
		while (sorted[right] - sorted[left] > tolerance) left += 1;
		const run = sorted.slice(left, right + 1);
		if (run.length > best.length) best = run;
	}
	return best;
}

/** Weight jitters by ~0.1 kg while settling; 0.05 keeps agreement honest. */
export const WEIGHT_RULE: StabilityRule = { needed: 3, tolerance: 0.05, window: 8, min: 0.5 };
/** A resting pulse repeats itself; ±2 bpm absorbs the odd missed beat. */
export const HEART_RATE_RULE: StabilityRule = { needed: 4, tolerance: 2, window: 8, min: 30, max: 220 };
/** Ohms are byte-exact when real, so agreement is tight by design. */
export const IMPEDANCE_RULE: StabilityRule = { needed: 4, tolerance: 5, window: 8, min: 150, max: 1200 };
