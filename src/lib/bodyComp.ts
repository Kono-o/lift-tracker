/**
 * Body-composition derivation from a weigh-in plus the user's anthropometrics.
 *
 * Ported from `anshuman852/occult` (MIT) — js/metrics/bodycomp.js — which in turn
 * ports the published formulas:
 *   Mifflin MD et al., Am J Clin Nutr 1990;51:241-247      (BMR)
 *   Deurenberg P et al., Br J Nutr 1991;65:105-114         (body fat %)
 *   Watson PE et al., Am J Clin Nutr 1980;33:27-39         (total body water)
 *   Janssen I et al., J Appl Physiol 2000;89:465-471       (skeletal muscle, needs R)
 *
 * These are population regressions over weight/height/age/sex, not measurements:
 * ±4 percentage points on body fat is normal. They are trends, not truth, and are
 * not medical advice.
 */

export type Sex = "male" | "female" | "other";

export type BodyMetrics = {
	bmi: number | null;
	bmiClass: string | null;
	bodyFatPct: number | null;
	fatMassKg: number | null;
	ffmKg: number | null;
	tbwL: number | null;
	bodyWaterPct: number | null;
	bmrKcal: number | null;
	smmKg: number | null;
	smmPct: number | null;
};

/**
 * Provisional raw-unit → ohms factor carried over from occult. Only 8-electrode
 * hardware sends a usable impedance; the foot-only Cult scale's bytes 5-7 are
 * documented as noise, so this is a best-effort calibration, not a measurement.
 */
export const DEFAULT_IMPEDANCE_SCALE = 0.03036;

/** Resistance band in which the Janssen equation is being used inside its data. */
const OHMS_MIN = 150;
const OHMS_MAX = 1200;

const r1 = (v: number | null): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const ri = (v: number | null): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(v));

export function bmi(weightKg: number, heightCm: number): number {
	const h = heightCm / 100;
	return weightKg / (h * h);
}

export function bmiClass(b: number): string {
	if (b < 18.5) return "underweight";
	if (b < 25) return "normal";
	if (b < 30) return "overweight";
	if (b < 35) return "obese I";
	if (b < 40) return "obese II";
	return "obese III";
}

/**
 * These equations only have a male and a female coefficient set. For `other` we
 * average both branches rather than silently picking one; the result is still an
 * estimate built on a binary model, and the UI says so.
 */
function blend(male: number, female: number, sex: Sex): number {
	if (sex === "male") return male;
	if (sex === "female") return female;
	return (male + female) / 2;
}

export function bmrMifflin(weightKg: number, heightCm: number, ageYears: number, sex: Sex): number {
	const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
	return blend(base + 5, base - 161, sex);
}

export function bodyFatDeurenberg(bmiValue: number, ageYears: number, sex: Sex): number {
	const core = 1.2 * bmiValue + 0.23 * ageYears - 5.4;
	// The −10.8 term belongs to the male branch (occult: `− 10.8·(male?1:0)`).
	return blend(core - 10.8, core, sex);
}

export function tbwWatson(weightKg: number, heightCm: number, ageYears: number, sex: Sex): number {
	const male = 2.447 - 0.09156 * ageYears + 0.1074 * heightCm + 0.3362 * weightKg;
	const female = -2.097 + 0.1069 * heightCm + 0.2466 * weightKg;
	return blend(male, female, sex);
}

export function smmJanssen(heightCm: number, resistanceOhms: number, ageYears: number, sex: Sex): number {
	const core = ((heightCm * heightCm) / resistanceOhms) * 0.401 - ageYears * 0.071 + 5.102;
	return core + (sex === "male" ? 3.825 : sex === "female" ? 0 : 3.825 / 2);
}

/** Raw scale impedance units → ohms, or null when the number is not usable. */
export function impedanceOhms(
	impedanceRaw: number | null | undefined,
	scale = DEFAULT_IMPEDANCE_SCALE,
): number | null {
	if (impedanceRaw == null || !Number.isFinite(impedanceRaw) || impedanceRaw <= 0) return null;
	const ohms = impedanceRaw * scale;
	return ohms >= OHMS_MIN && ohms <= OHMS_MAX ? ohms : null;
}

export type DeriveInput = {
	weightKg: number | null | undefined;
	impedanceRaw?: number | null;
	/** Fractional years, from age.totalDays / 365.2425. */
	ageYears?: number | null;
	sex?: Sex | null;
	heightCm?: number | null;
};

/**
 * Any metric whose inputs are missing comes back null rather than a plausible-
 * looking number, so an incomplete profile degrades to weight + heart rate only.
 */
export function deriveReading(input: DeriveInput): BodyMetrics {
	const weightKg = input.weightKg != null && Number.isFinite(input.weightKg) ? input.weightKg : null;
	const heightCm = input.heightCm != null && Number.isFinite(input.heightCm) && input.heightCm > 0 ? input.heightCm : null;
	const ageYears =
		input.ageYears != null && Number.isFinite(input.ageYears) && input.ageYears >= 0 ? input.ageYears : null;
	const sex = input.sex ?? null;

	const bmiValue = weightKg != null && heightCm != null ? r1(bmi(weightKg, heightCm)) : null;
	const hasAgeSex = ageYears != null && sex != null;

	const bodyFatPct = bmiValue != null && hasAgeSex ? r1(bodyFatDeurenberg(bmiValue, ageYears!, sex!)) : null;
	const fatMassKg = weightKg != null && bodyFatPct != null ? r1((weightKg * bodyFatPct) / 100) : null;
	const ffmKg = weightKg != null && fatMassKg != null ? r1(weightKg - fatMassKg) : null;

	const canUseProfile = weightKg != null && heightCm != null && hasAgeSex;
	const tbwL = canUseProfile ? r1(tbwWatson(weightKg!, heightCm!, ageYears!, sex!)) : null;
	const bodyWaterPct = weightKg != null && tbwL != null ? r1((tbwL / weightKg) * 100) : null;
	const bmrKcal = canUseProfile ? ri(bmrMifflin(weightKg!, heightCm!, ageYears!, sex!)) : null;

	let smmKg: number | null = null;
	let smmPct: number | null = null;
	const ohms = impedanceOhms(input.impedanceRaw);
	if (canUseProfile && ohms != null) {
		const smm = smmJanssen(heightCm!, ohms, ageYears!, sex!);
		smmKg = r1(smm);
		smmPct = weightKg != null ? r1((smm / weightKg) * 100) : null;
	}

	return {
		bmi: bmiValue,
		bmiClass: bmiValue != null ? bmiClass(bmiValue) : null,
		bodyFatPct,
		fatMassKg,
		ffmKg,
		tbwL,
		bodyWaterPct,
		bmrKcal,
		smmKg,
		smmPct,
	};
}

/** True when every profile field the derived metrics need is present. */
export function canDerive(input: {
	sex?: Sex | null;
	ageYears?: number | null;
	heightCm?: number | null;
}): boolean {
	return input.sex != null && input.ageYears != null && input.heightCm != null;
}

/**
 * Reference values from occult plus the hand-checks its self-test carried.
 * Returns the list of failures so a UI can surface them instead of only passing
 * or failing silently.
 */
export function bodyCompSelfTest(): string[] {
	const failures: string[] = [];
	const near = (label: string, actual: number, expected: number, tol = 1e-6) => {
		if (Math.abs(actual - expected) > tol) failures.push(`${label}: got ${actual}, want ${expected}`);
	};

	near("bmi", bmi(100, 200), 25.0);
	near("bmrMifflin male", bmrMifflin(80, 180, 30, "male"), 1780);
	near("bmrMifflin female", bmrMifflin(80, 180, 30, "female"), 1614);
	near("bodyFatDeurenberg male", bodyFatDeurenberg(25, 40, "male"), 23.0);

	// Deurenberg female at the same inputs keeps no −10.8 term: 30 + 9.2 − 5.4 = 33.8
	near("bodyFatDeurenberg female", bodyFatDeurenberg(25, 40, "female"), 33.8);
	// 'other' is the mean of the two branches.
	near("bodyFatDeurenberg other", bodyFatDeurenberg(25, 40, "other"), 28.4);
	near("bmrMifflin other", bmrMifflin(80, 180, 30, "other"), 1697);

	// 75 kg / 180 cm / 30 y male:
	//   2.447 − 0.09156·30 + 0.1074·180 + 0.3362·75
	near("tbwWatson male", tbwWatson(75, 180, 30, "male"), 44.2472, 1e-4);

	if (bmiClass(24.9) !== "normal") failures.push("bmiClass 24.9 should be normal");
	if (bmiClass(25.0) !== "overweight") failures.push("bmiClass 25 should be overweight");

	// A raw value that does not calibrate into a plausible resistance must yield
	// no muscle mass rather than a confident wrong number.
	if (impedanceOhms(0) !== null) failures.push("impedanceOhms(0) should be null");
	if (impedanceOhms(999999) !== null) failures.push("impedanceOhms(absurd) should be null");
	if (impedanceOhms(20000) === null) failures.push("impedanceOhms(20000) should calibrate");

	const incomplete = deriveReading({ weightKg: 80 });
	if (incomplete.bmi !== null || incomplete.bodyFatPct !== null || incomplete.bmrKcal !== null) {
		failures.push("deriveReading without a profile must return nulls");
	}
	const weightOnly = deriveReading({ weightKg: 80, heightCm: 175 });
	if (weightOnly.bmi === null || weightOnly.bodyFatPct !== null) {
		failures.push("deriveReading with height only should give BMI but no body fat");
	}

	return failures;
}
