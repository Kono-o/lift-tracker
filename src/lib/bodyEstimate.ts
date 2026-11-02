/**
 * Vendor body-composition algorithms, ported.
 *
 * Lifted from openScale (GPL-3.0-only, Copyright (C) olie.xdev),
 * `android_app/app/src/main/java/com/health/openscale/core/bluetooth/libs/`:
 *   OneByoneNewLib.kt   — the foot-to-foot scale family (Cult CS-BF01 is one)
 *   OneByoneLib.kt      — its older sibling, kept for the activity coefficients
 *   Wla25BodyComposition.kt — the 8-electrode vendor library, whose scalar
 *                             relations (bone, subcutaneous, protein, visceral,
 *                             metabolic age) need only fat-free mass, not the
 *                             ten impedances its fat regression wants.
 *
 * These are the equations the scales' own firmware uses, so the numbers here
 * match what the display on the device says. They are still population
 * regressions over weight/height/age/sex plus one resistance reading: ±4
 * percentage points on body fat is normal. Trends, not truth, not medical advice.
 *
 * Everything below is pure arithmetic. Which equation gets used, and what that
 * makes a measurement versus an estimate, is `bodyComp.ts`.
 */

import type { Sex } from "./bodyComp";

/** A resting pulse is not enough to run the foot-to-foot equations on a child. */
const MIN_ADULT_AGE_YEARS = 10;

/** The published validity window for these equations' resistance input. */
export const BIA_OHMS_MIN = 150;
export const BIA_OHMS_MAX = 1200;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const isMale = (sex: Sex): boolean => sex === "male";
/**
 * The vendor code branches on `sex == 1` (male) versus everything else. `other`
 * therefore follows the female branch — the same choice openScale makes for any
 * sex it cannot tell apart, and the reason the UI labels these values estimates.
 */
const vendorSex = (sex: Sex): 0 | 1 => (isMale(sex) ? 1 : 0);

/**
 * Lean body mass coefficient, the shared trunk of the foot-to-foot family:
 * `H²·0.0009058·100 + 12.226 + 0.32·W − 0.0068·R − 0.0542·A`.
 * It is a mass in kilograms, and every other value below is a step off it.
 */
export function biaLbmCoefficient(
	weightKg: number,
	heightCm: number,
	ageYears: number,
	resistanceOhms: number,
): number {
	const h = heightCm / 100;
	return h * h * 9.058 + 12.226 + weightKg * 0.32 - resistanceOhms * 0.0068 - ageYears * 0.0542;
}

/**
 * Body fat %, foot-to-foot BIA. The LBM coefficient is treated as the fat-free
 * mass, then corrected for sex/age/size bands and expressed as the complement.
 */
export function bodyFatBia(
	weightKg: number,
	heightCm: number,
	ageYears: number,
	sex: Sex,
	resistanceOhms: number,
): number | null {
	if (!isPlausibleBia(weightKg, heightCm, ageYears, resistanceOhms)) return null;
	let lbm = biaLbmCoefficient(weightKg, heightCm, ageYears, resistanceOhms);
	// The vendor's fat-free offset: a flat 0.8 for men, age-split for everyone else.
	lbm -= isMale(sex) ? 0.8 : ageYears < 50 ? 9.25 : 7.25;
	if (vendorSex(sex) === 0) {
		if (weightKg < 50) lbm *= 1.02;
		else if (weightKg > 60) lbm *= 0.96;
		if (heightCm > 160) lbm *= 1.03;
	} else if (weightKg < 61) {
		lbm *= 0.98;
	}
	return clamp(100 * (1 - lbm / weightKg), 1, 60);
}

/** Total body water %, derived from fat % — the vendor's own shortcut. */
export function bodyWaterPctFromFat(bodyFatPct: number): number {
	const water = (100 - bodyFatPct) * 0.7;
	return clamp(water > 50 ? water * 0.98 : water * 1.02, 35, 75);
}

/**
 * Bone mass, kg, from the fat-free coefficient: `0.05158·LBM − sexConst`, then
 * ±0.1 to round the way the vendor library does. Only reachable with a resistance
 * reading; `boneMassFromFfm` is the impedance-free fallback the caller uses instead.
 */
export function boneMassBia(
	weightKg: number,
	heightCm: number,
	ageYears: number,
	sex: Sex,
	resistanceOhms: number,
): number | null {
	if (!isPlausibleBia(weightKg, heightCm, ageYears, resistanceOhms)) return null;
	const lbm = biaLbmCoefficient(weightKg, heightCm, ageYears, resistanceOhms);
	const sexConst = isMale(sex) ? 0.18016894 : 0.245691014;
	const base = lbm * 0.05158 - sexConst;
	return clamp(base <= 2.2 ? base - 0.1 : base + 0.1, 0.5, 8);
}

/** Bone mass from fat-free mass alone — the impedance-free fallback. */
export function boneMassFromFfm(ffmKg: number): number {
	return clamp(ffmKg * 0.067, 0.5, 8);
}

/** Muscle mass = weight − fat − bone, the vendor's definition of the remainder. */
export function muscleMassKg(weightKg: number, bodyFatPct: number, boneKg: number): number {
	return clamp(weightKg - (bodyFatPct / 100) * weightKg - boneKg, 3, 120);
}

/**
 * Skeletal muscle %: `0.8422` of body water is contractile tissue, minus a fixed
 * 2.9903 kg offset, expressed against body weight.
 */
export function skeletalMusclePct(weightKg: number, bodyWaterPct: number): number {
	const waterKg = (bodyWaterPct / 100) * weightKg;
	return clamp(((waterKg * 0.8422 - 2.9903) / weightKg) * 100, 5, 75);
}

/** Skeletal muscle mass in kg, from the same relation. */
export function skeletalMuscleKg(weightKg: number, bodyWaterPct: number): number {
	const waterKg = (bodyWaterPct / 100) * weightKg;
	return clamp(waterKg * 0.8422 - 2.9903, 3, 120);
}

/**
 * Visceral fat *level* (not a percentage) — the vendor's sex-split regression over
 * height, weight and age. Levels are what these scales print; 1–9 is the healthy
 * band on the Tanita-style ladder this family copies.
 */
export function visceralFatLevel(
	weightKg: number,
	heightCm: number,
	ageYears: number,
	sex: Sex,
): number {
	let level: number;
	if (sex === "male") {
		level =
			heightCm < weightKg * 1.6 + 63
				? ageYears * 0.15 + ((weightKg * 305) / (heightCm * 0.0826 * heightCm - heightCm * 0.4 + 48) - 2.9)
				: ageYears * 0.15 + (weightKg * (heightCm * -0.0015 + 0.765) - heightCm * 0.143) - 5;
	} else {
		level =
			weightKg <= heightCm * 0.5 - 13
				? ageYears * 0.07 + (weightKg * (heightCm * -0.0024 + 0.691) - heightCm * 0.027) - 10.5
				: ageYears * 0.07 + ((weightKg * 500) / (heightCm * 1.45 + heightCm * 0.1158 * heightCm) - 6);
	}
	return Math.round(clamp(level, 1, 50));
}

/** Subcutaneous fat %, from body fat % — the 8-electrode library's relation. */
export function subcutaneousFatPct(bodyFatPct: number): number {
	return clamp((bodyFatPct * -0.0002 + 0.72) * bodyFatPct, 0.5, 60);
}

/**
 * Protein %. With a resistance reading: the vendor's remainder of fat-free mass
 * after water and mineral. Without one: `0.2·FFM`, which is the same idea with the
 * bone term folded into the constant.
 */
export function proteinPctFromComponents(
	weightKg: number,
	bodyFatPct: number,
	bodyWaterPct: number,
	boneKg: number,
): number {
	return clamp(100 - bodyFatPct - bodyWaterPct * 1.08 - (boneKg / weightKg) * 100, 4, 25);
}

export function proteinPctFromFfm(weightKg: number, ffmKg: number): number {
	return clamp((ffmKg * 0.2 * 100) / weightKg, 4, 25);
}

/** Katch-McArdle resting energy from lean mass: `370 + 21.6·FFM`. */
export function bmrKatch(ffmKg: number): number {
	return clamp(370 + 21.6 * ffmKg, 800, 4000);
}

/**
 * Metabolic ("body") age: chronological age nudged by the body-fat band. The
 * offsets skip zero, and the female band singles out 45–46 % as neutral — both are
 * the vendor library's real behaviour, not transcription slips.
 */
export function bodyAgeYears(ageYears: number, bodyFatPct: number, sex: Sex): number | null {
	const age = Math.round(ageYears);
	if (age < MIN_ADULT_AGE_YEARS) return null;
	const bands: Array<[number, number]> =
		sex === "male"
			? [[14, -3], [19, -2], [24, -1], [27, 1], [30, 2], [33, 3], [36, 4]]
			: [[24, -3], [28, -2], [32, -1], [35, 1], [38, 2], [42, 3], [45, 4], [46, 0]];
	for (const [upper, delta] of bands) {
		if (bodyFatPct < upper) return age + delta;
	}
	return age + 5;
}

/** The equations only hold inside their published inputs. */
export function isPlausibleBia(
	weightKg: number,
	heightCm: number,
	ageYears: number,
	resistanceOhms: number,
): boolean {
	return (
		Number.isFinite(weightKg) &&
		weightKg >= 20 &&
		weightKg <= 250 &&
		Number.isFinite(heightCm) &&
		heightCm >= 80 &&
		heightCm <= 250 &&
		Number.isFinite(ageYears) &&
		ageYears >= MIN_ADULT_AGE_YEARS &&
		ageYears <= 120 &&
		Number.isFinite(resistanceOhms) &&
		resistanceOhms >= BIA_OHMS_MIN &&
		resistanceOhms <= BIA_OHMS_MAX
	);
}
