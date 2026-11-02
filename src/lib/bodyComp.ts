/**
 * Body-composition derivation from a weigh-in plus the user's anthropometrics.
 *
 * Two families of equations, and the whole point of `tiers` is to never let them
 * pretend to be each other:
 *
 *  - `estimate` — published population regressions over weight/height/age/sex,
 *    ported from `anshuman852/occult` (MIT) `js/metrics/bodycomp.js`:
 *      Mifflin MD et al., Am J Clin Nutr 1990;51:241-247   (BMR)
 *      Deurenberg P et al., Br J Nutr 1991;65:105-114      (body fat %)
 *      Watson PE et al., Am J Clin Nutr 1980;33:27-39      (total body water)
 *  - `bia` — the vendor equations the scales' own firmware runs, from
 *    `./bodyEstimate` (openScale, GPL-3.0). These consume a real resistance
 *    reading, which is why they are the ones that agree with the number printed
 *    on the device.
 *
 * Every metric is always produced when its inputs exist — a foot-only scale with
 * nothing to say about impedance still yields the full grid, tagged `estimate`.
 * A value inherits the weakest tier of its inputs, so a body-fat number that came
 * from BMI alone cannot promote the muscle mass computed from it.
 *
 * ±4 percentage points on body fat is normal for either family. These are trends,
 * not truth, and not medical advice.
 */

import {
	biaLbmCoefficient,
	bodyAgeYears,
	bodyFatBia,
	bodyWaterPctFromFat,
	boneMassBia,
	boneMassFromFfm,
	bmrKatch,
	isPlausibleBia,
	muscleMassKg,
	proteinPctFromComponents,
	proteinPctFromFfm,
	skeletalMuscleKg,
	subcutaneousFatPct,
	visceralFatLevel,
	BIA_OHMS_MAX,
	BIA_OHMS_MIN,
} from "./bodyEstimate";

export type Sex = "male" | "female" | "other";

/** How a number came to be. `measured` is the only one a sensor reported. */
export type MetricTier = "measured" | "bia" | "estimate";

/** Every metric the BODY tab can chart, including the three direct readings. */
export type BodyMetricKey =
	| "weight_kg"
	| "heart_rate"
	| "impedance_ohms"
	| "bmi"
	| "body_fat_pct"
	| "fat_mass_kg"
	| "ffm_kg"
	| "body_water_pct"
	| "tbw_l"
	| "bone_mass_kg"
	| "muscle_mass_kg"
	| "muscle_pct"
	| "smm_kg"
	| "smm_pct"
	| "visceral_fat_level"
	| "subcutaneous_fat_pct"
	| "subcutaneous_fat_kg"
	| "protein_pct"
	| "protein_mass_kg"
	| "bmr_kcal"
	| "tdee_kcal"
	| "body_age";

export type Activity = "sedentary" | "light" | "moderate" | "high" | "athlete";

/** The ladder Mifflin's own paper was validated against. */
const TDEE_FACTOR: Record<Activity, number> = {
	sedentary: 1.2,
	light: 1.375,
	moderate: 1.55,
	high: 1.725,
	athlete: 1.9,
};

/** Ordered, for the profile picker. `hint` is what the option says about itself. */
export const ACTIVITY_LEVELS: Array<{ key: Activity; label: string; hint: string }> = [
	{ key: "sedentary", label: "Sedentary", hint: "Desk job, little planned exercise" },
	{ key: "light", label: "Light", hint: "1-3 training days a week" },
	{ key: "moderate", label: "Moderate", hint: "3-5 training days a week" },
	{ key: "high", label: "High", hint: "6-7 training days a week" },
	{ key: "athlete", label: "Athlete", hint: "Twice daily, or physical labour" },
];

export function isActivity(value: unknown): value is Activity {
	return typeof value === "string" && value in TDEE_FACTOR;
}

const TIER_RANK: Record<MetricTier, number> = { estimate: 0, bia: 1, measured: 2 };

/** A derived number is only as good as the worst thing it was built from. */
function weakest(...tiers: MetricTier[]): MetricTier {
	return tiers.reduce((worst, t) => (TIER_RANK[t] < TIER_RANK[worst] ? t : worst), "measured");
}

export type BodyMetrics = {
	bmi: number | null;
	bmiClass: string | null;
	bodyFatPct: number | null;
	fatMassKg: number | null;
	/** Lean body mass: weight − fat mass. */
	ffmKg: number | null;
	bodyWaterPct: number | null;
	tbwL: number | null;
	boneMassKg: number | null;
	muscleMassKg: number | null;
	musclePct: number | null;
	smmKg: number | null;
	smmPct: number | null;
	/** Visceral fat *level* on the 1-20 ladder these scales print, not a percentage. */
	visceralFatLevel: number | null;
	subcutaneousFatPct: number | null;
	subcutaneousFatKg: number | null;
	proteinPct: number | null;
	proteinMassKg: number | null;
	bmrKcal: number | null;
	tdeeKcal: number | null;
	bodyAge: number | null;
	tiers: Record<BodyMetricKey, MetricTier>;
};

const r1 = (v: number | null): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const ri = (v: number | null): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(v));

function positive(value: number | null | undefined): number | null {
	return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

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

/** Ohms outside the equations' published window are refused, not clamped. */
export function plausibleResistance(ohms: number | null | undefined): number | null {
	if (ohms == null || !Number.isFinite(ohms)) return null;
	return ohms >= BIA_OHMS_MIN && ohms <= BIA_OHMS_MAX ? ohms : null;
}

export type DeriveInput = {
	weightKg: number | null | undefined;
	/** Whole-body resistance in ohms, already resolved by the scale layer. */
	resistanceOhms?: number | null;
	/** Fractional years, from `age.totalDays / 365.2425`. */
	ageYears?: number | null;
	sex?: Sex | null;
	heightCm?: number | null;
	activity?: Activity | null;
};

/**
 * Any metric whose inputs are missing comes back null rather than a plausible-
 * looking number, so an incomplete profile degrades to weight + heart rate only.
 * Intermediates stay unrounded and only the published value is rounded: rounding
 * body fat before deriving fat mass would drift the whole grid by a tenth.
 */
export function deriveReading(input: DeriveInput): BodyMetrics {
	const weightKg = positive(input.weightKg);
	const heightCm = positive(input.heightCm);
	const ageYears = input.ageYears != null && Number.isFinite(input.ageYears) && input.ageYears >= 0 ? input.ageYears : null;
	const sex = input.sex ?? null;
	const activity = isActivity(input.activity) ? input.activity : null;
	const ohms = plausibleResistance(input.resistanceOhms);
	const measured = weightKg != null && heightCm != null && ageYears != null && sex != null;

	const bmiValue = weightKg != null && heightCm != null ? r1(bmi(weightKg, heightCm)) : null;

	// Body fat first: everything downstream hangs off it, so its tier propagates.
	let fat: number | null = null;
	let fatTier: MetricTier = "estimate";
	if (measured && ohms != null) {
		fat = bodyFatBia(weightKg!, heightCm!, ageYears!, sex!, ohms);
		// `bodyFatBia` refuses implausible inputs; Deurenberg still applies to them.
		if (fat != null) fatTier = "bia";
	}
	if (fat == null && bmiValue != null && ageYears != null && sex != null) {
		fat = bodyFatDeurenberg(bmiValue, ageYears, sex);
	}
	const fatTierOf = (value: number | null): MetricTier => (value == null ? "estimate" : fatTier);

	const fatMassKg = fat != null && weightKg != null ? (fat / 100) * weightKg : null;
	const ffmKg = fatMassKg != null && weightKg != null ? weightKg - fatMassKg : null;

	// One switch decides the whole grid: with a real measurement of lean tissue the
	// vendor relations apply (and the numbers track the scale's own display), and
	// without one the population regressions do.
	const viaBia = fat != null && fatTier === "bia";

	let water: number | null = null;
	let tbwL: number | null = null;
	let waterTier: MetricTier = "estimate";
	if (viaBia && fat != null && weightKg != null) {
		water = bodyWaterPctFromFat(fat);
		tbwL = (water / 100) * weightKg;
		waterTier = "bia";
	} else if (measured) {
		tbwL = tbwWatson(weightKg!, heightCm!, ageYears!, sex!);
		water = (tbwL / weightKg!) * 100;
	}
	const waterTierOf = (value: number | null): MetricTier => (value == null ? "estimate" : waterTier);

	let bone: number | null = null;
	if (viaBia && measured && ohms != null) {
		bone = boneMassBia(weightKg!, heightCm!, ageYears!, sex!, ohms);
	} else if (ffmKg != null) {
		bone = boneMassFromFfm(ffmKg);
	}
	const boneTier: MetricTier = bone == null ? "estimate" : viaBia ? "bia" : fatTierOf(fat);

	const muscle = weightKg != null && fat != null && bone != null ? muscleMassKg(weightKg, fat, bone) : null;
	const muscleTier: MetricTier = muscle == null ? "estimate" : weakest(fatTierOf(fat), boneTier);

	const smm = weightKg != null && water != null ? skeletalMuscleKg(weightKg, water) : null;
	const smmTier: MetricTier = smm == null ? "estimate" : waterTierOf(water);

	const protein =
		viaBia && fat != null && water != null && bone != null && weightKg != null
			? proteinPctFromComponents(weightKg, fat, water, bone)
			: ffmKg != null && weightKg != null
				? proteinPctFromFfm(weightKg, ffmKg)
				: null;
	const proteinTier: MetricTier = protein == null ? "estimate" : viaBia ? "bia" : fatTierOf(fat);

	const subPct = fat != null ? subcutaneousFatPct(fat) : null;
	const subKg = subPct != null && weightKg != null ? (subPct / 100) * weightKg : null;

	// Visceral level needs no resistance, so the vendor's height/weight/age
	// regression is the only version of it — the level stays an estimate even on a
	// scale that prints it, because our number never saw the measurement.
	const visceral = measured ? visceralFatLevel(weightKg!, heightCm!, ageYears!, sex!) : null;

	// BMR follows the machine when lean mass was measured, and otherwise uses the
	// population equation that does not need it.
	const bmr = viaBia && ffmKg != null ? bmrKatch(ffmKg) : measured ? bmrMifflin(weightKg!, heightCm!, ageYears!, sex!) : null;
	const bmrTier: MetricTier = bmr == null ? "estimate" : viaBia ? "bia" : "estimate";
	const tdee = bmr != null && activity != null ? bmr * TDEE_FACTOR[activity] : null;

	const bodyAge = fat != null && ageYears != null && sex != null ? bodyAgeYears(ageYears, fat, sex) : null;

	return {
		bmi: bmiValue,
		bmiClass: bmiValue != null ? bmiClass(bmiValue) : null,
		bodyFatPct: r1(fat),
		fatMassKg: r1(fatMassKg),
		ffmKg: r1(ffmKg),
		bodyWaterPct: r1(water),
		tbwL: r1(tbwL),
		boneMassKg: r1(bone),
		muscleMassKg: r1(muscle),
		musclePct: muscle != null && weightKg != null ? r1((muscle / weightKg) * 100) : null,
		smmKg: r1(smm),
		smmPct: smm != null && weightKg != null ? r1((smm / weightKg) * 100) : null,
		visceralFatLevel: ri(visceral),
		subcutaneousFatPct: r1(subPct),
		subcutaneousFatKg: r1(subKg),
		proteinPct: r1(protein),
		proteinMassKg: protein != null && weightKg != null ? r1((protein / 100) * weightKg) : null,
		bmrKcal: ri(bmr),
		tdeeKcal: ri(tdee),
		bodyAge,
		tiers: {
			weight_kg: "measured",
			heart_rate: "measured",
			impedance_ohms: "measured",
			bmi: "estimate",
			body_fat_pct: fatTierOf(fat),
			fat_mass_kg: fatTierOf(fatMassKg),
			ffm_kg: fatTierOf(ffmKg),
			body_water_pct: waterTierOf(water),
			tbw_l: waterTierOf(tbwL),
			bone_mass_kg: boneTier,
			muscle_mass_kg: muscleTier,
			muscle_pct: muscleTier,
			smm_kg: smmTier,
			smm_pct: smmTier,
			visceral_fat_level: "estimate",
			subcutaneous_fat_pct: fatTierOf(subPct),
			subcutaneous_fat_kg: fatTierOf(subKg),
			protein_pct: proteinTier,
			protein_mass_kg: proteinTier,
			bmr_kcal: bmrTier,
			tdee_kcal: tdee == null ? "estimate" : bmrTier,
			body_age: fatTierOf(bodyAge),
		},
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
 * The 75 kg / 180 cm / 30 y male at 500 Ω is worked through against the vendor
 * source: LBM coefficient 60.54792, minus the 0.8 male constant = 59.74792. The
 * ×0.98 male nudge does *not* apply — it is gated on weight < 61 kg — so fat-free
 * mass stays 59.74792 and body fat is 100·(1 − 59.74792/75) = 20.34 %.
 * Returns the list of failures so a UI or a check script can surface them instead
 * of only passing or failing silently.
 */
export function bodyCompSelfTest(): string[] {
	const failures: string[] = [];
	const near = (label: string, actual: number | null, expected: number, tol = 1e-6) => {
		if (actual == null || Math.abs(actual - expected) > tol) failures.push(`${label}: got ${actual}, want ${expected}`);
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

	// 75 kg / 180 cm / 30 y male: 2.447 − 0.09156·30 + 0.1074·180 + 0.3362·75
	near("tbwWatson male", tbwWatson(75, 180, 30, "male"), 44.2472, 1e-4);

	if (bmiClass(24.9) !== "normal") failures.push("bmiClass 24.9 should be normal");
	if (bmiClass(25.0) !== "overweight") failures.push("bmiClass 25 should be overweight");

	// A resistance outside the equations' window must yield the estimate chain,
	// not a confident wrong number.
	if (plausibleResistance(0) !== null) failures.push("plausibleResistance(0) should be null");
	if (plausibleResistance(1500) !== null) failures.push("plausibleResistance(1500) should be null");
	if (plausibleResistance(500) === null) failures.push("plausibleResistance(500) should pass");

	const profile = { weightKg: 75, heightCm: 180, ageYears: 30, sex: "male" as Sex };

	// The BIA chain, one step per vendor equation.
	const bia = deriveReading({ ...profile, resistanceOhms: 500 });
	near("bia lbm coefficient", biaLbmCoefficient(75, 180, 30, 500), 60.54792, 1e-4);
	near("bia body fat", bia.bodyFatPct, 20.3, 0.05);
	near("bia fat mass", bia.fatMassKg, 15.3, 0.05);
	near("bia lean mass", bia.ffmKg, 59.7, 0.05);
	near("bia water", bia.bodyWaterPct, 54.6, 0.05);
	near("bia total body water", bia.tbwL, 41.0, 0.05);
	near("bia bone", bia.boneMassKg, 3.0, 0.05);
	near("bia muscle", bia.muscleMassKg, 56.7, 0.05);
	near("bia muscle share", bia.musclePct, 75.6, 0.05);
	near("bia skeletal muscle", bia.smmPct, 42.0, 0.05);
	near("bia visceral level", bia.visceralFatLevel, 10);
	near("bia subcutaneous", bia.subcutaneousFatPct, 14.6, 0.05);
	near("bia protein", bia.proteinPct, 16.6, 0.05);
	near("bia body age", bia.bodyAge, 29);
	near("bia katch bmr", bia.bmrKcal, 1661, 1);
	if (bia.tiers.body_fat_pct !== "bia") failures.push("a resistance reading must promote body fat to the bia tier");
	if (bia.tiers.muscle_mass_kg !== "bia") failures.push("muscle built from BIA fat and bone must stay bia");
	if (bia.tiers.bmr_kcal !== "bia") failures.push("katch bmr from measured lean mass is bia");
	if (bia.tiers.visceral_fat_level !== "estimate") failures.push("visceral fat never uses the resistance");

	// The same person with nothing on the impedance line: the full grid again, but
	// from the population equations. Body fat lands 3.5 points lower than the BIA
	// reading, which is exactly why the tier is shown next to the number.
	const est = deriveReading({ ...profile });
	near("estimate body fat", est.bodyFatPct, 18.4, 0.05);
	near("estimate fat mass", est.fatMassKg, 13.8, 0.05);
	near("estimate lean mass", est.ffmKg, 61.2, 0.05);
	near("estimate water", est.bodyWaterPct, 59.0, 0.05);
	near("estimate tbw", est.tbwL, 44.2, 0.05);
	near("estimate bone", est.boneMassKg, 4.1, 0.05);
	near("estimate muscle", est.muscleMassKg, 57.1, 0.05);
	near("estimate skeletal muscle", est.smmPct, 45.7, 0.05);
	near("estimate protein", est.proteinPct, 16.3, 0.05);
	near("estimate subcutaneous", est.subcutaneousFatPct, 13.2, 0.05);
	near("estimate visceral level", est.visceralFatLevel, 10);
	near("estimate body age", est.bodyAge, 28);
	near("estimate mifflin bmr", est.bmrKcal, 1730);
	if (est.tiers.body_fat_pct !== "estimate") failures.push("body fat without a resistance must be an estimate");
	if (est.tiers.ffm_kg !== "estimate") failures.push("lean mass from estimated fat must be an estimate");
	if (est.tiers.bmr_kcal !== "estimate") failures.push("mifflin bmr is an estimate");

	// Activity is optional; TDEE is absent rather than assumed.
	if (est.tdeeKcal !== null) failures.push("TDEE without an activity level must be null");
	near("tdee moderate", deriveReading({ ...profile, activity: "moderate" }).tdeeKcal, 2682, 1);

	// Degradation: a missing profile field takes its dependants with it.
	const incomplete = deriveReading({ weightKg: 80 });
	if (incomplete.bmi !== null || incomplete.bodyFatPct !== null || incomplete.bmrKcal !== null) {
		failures.push("deriveReading without a profile must return nulls");
	}
	const weightOnly = deriveReading({ weightKg: 80, heightCm: 175 });
	if (weightOnly.bmi === null || weightOnly.bodyFatPct !== null) {
		failures.push("deriveReading with height only should give BMI but no body fat");
	}
	if (weightOnly.tiers.body_fat_pct !== "estimate") failures.push("an absent metric must still carry a tier");
	// A child is inside the app but outside the vendor equations' validity window.
	const child = deriveReading({ weightKg: 30, heightCm: 140, ageYears: 8, sex: "male", resistanceOhms: 500 });
	if (child.bodyFatPct == null) failures.push("body fat should fall back to Deurenberg for a child");
	if (child.bodyAge !== null) failures.push("body age is not defined under 10 years");

	return failures;
}
