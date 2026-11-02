/**
 * Reading-row → chart-ready data for the BODY tab.
 *
 * The database stores one row per weigh-in (weight, HR, resistance in ohms) plus the
 * profile that was in force at the time; every other metric is derived here, so a
 * formula fix re-derives history instead of leaving stale stored numbers. Age is
 * derived *as of the measurement*, which is what makes a two-year-old row still
 * meaningful after a birthday. Each derived number also carries the tier that says
 * how it was produced — see `bodyComp.deriveReading`.
 */

import {
	deriveReading,
	plausibleResistance,
	type Activity,
	type BodyMetricKey,
	type BodyMetrics,
	type MetricTier,
	type Sex,
} from "./bodyComp";
import { CAPTURE_VERSION_STAGED, type BodyProfile, type BodyReading } from "./bodySanitize";
import { ageFromDob, ageYearsDecimal, type Age } from "./age";
import { formatBodyMass, massUnit, toDisplayMass, type BodyUnits } from "./units";

export type { BodyMetricKey } from "./bodyComp";
export type { MetricTier } from "./bodyComp";

export type BodyRange = "3weeks" | "3m" | "6m" | "ytd" | "all";

type Format = "mass" | "percent" | "count" | "energy" | "ohms" | "index" | "volume" | "level" | "years";

export interface BodyMetric {
	key: BodyMetricKey;
	label: string;
	format: Format;
	/** Raw units only — the display conversion is per-reading, in `formatMetric`. */
	hint: string;
}

/**
 * Pill order: what the scale measured, then the composition grid, then the two
 * energy numbers and body age. Weight is first because it is the only truth.
 */
export const BODY_METRICS: BodyMetric[] = [
	{ key: "weight_kg", label: "WEIGHT", format: "mass", hint: "Stable weight off the scale" },
	{ key: "heart_rate", label: "HEART RATE", format: "count", hint: "Pulse during the measurement" },
	{ key: "impedance_ohms", label: "IMPEDANCE", format: "ohms", hint: "Whole-body resistance, only on hardware that reports it" },
	{ key: "bmi", label: "BMI", format: "index", hint: "Weight ÷ height²" },
	{ key: "body_fat_pct", label: "BODY FAT", format: "percent", hint: "From the resistance, else Deurenberg over BMI + age" },
	{ key: "fat_mass_kg", label: "FAT MASS", format: "mass", hint: "Weight × body-fat %" },
	{ key: "ffm_kg", label: "LEAN MASS", format: "mass", hint: "Weight − fat mass" },
	{ key: "body_water_pct", label: "WATER", format: "percent", hint: "73% of lean mass, else Watson over height + age" },
	{ key: "tbw_l", label: "BODY WATER", format: "volume", hint: "Total body water in litres" },
	{ key: "bone_mass_kg", label: "BONE", format: "mass", hint: "Mineral mass from the lean coefficient, else 6.7% of lean mass" },
	{ key: "muscle_mass_kg", label: "MUSCLE", format: "mass", hint: "Weight − fat − bone" },
	{ key: "muscle_pct", label: "MUSCLE %", format: "percent", hint: "Muscle mass ÷ weight" },
	{ key: "smm_kg", label: "SKELETAL M", format: "mass", hint: "84% of body water − 3 kg" },
	{ key: "smm_pct", label: "SKELETAL %", format: "percent", hint: "Skeletal muscle mass ÷ weight" },
	{ key: "visceral_fat_level", label: "VISCERAL", format: "level", hint: "Organ-fat level on the 1-20 ladder, not a percentage" },
	{ key: "subcutaneous_fat_pct", label: "SUBCUT %", format: "percent", hint: "Under-skin fat share of weight" },
	{ key: "subcutaneous_fat_kg", label: "SUBCUT MASS", format: "mass", hint: "Weight × subcutaneous %" },
	{ key: "protein_pct", label: "PROTEIN", format: "percent", hint: "Lean remainder after water and mineral" },
	{ key: "protein_mass_kg", label: "PROTEIN MASS", format: "mass", hint: "Weight × protein %" },
	{ key: "bmr_kcal", label: "BMR", format: "energy", hint: "Katch over measured lean mass, else Mifflin-St Jeor" },
	{ key: "tdee_kcal", label: "TDEE", format: "energy", hint: "BMR × activity level — needs one set in Profile" },
	{ key: "body_age", label: "BODY AGE", format: "years", hint: "Age shifted by the body-fat band" },
];

/** Short chip label for a metric's provenance. */
export const TIER_LABEL: Record<MetricTier, string> = {
	measured: "SCALE",
	bia: "BIA",
	estimate: "DERIVED",
};

export const TIER_HINT: Record<MetricTier, string> = {
	measured: "Reported by the hardware",
	bia: "Computed from a real resistance measurement",
	estimate: "Computed from weight, height, age and sex only",
};

export function metricByKey(key: BodyMetricKey): BodyMetric {
	return BODY_METRICS.find((m) => m.key === key) ?? BODY_METRICS[0];
}

/** A reading plus everything derived from it and its captured profile. */
export type DerivedReading = {
	reading: BodyReading;
	metrics: BodyMetrics;
	/** Age at the measurement date, not today. */
	age: Age | null;
	ageYears: number | null;
	ohms: number | null;
	/** False when neither the snapshot nor the live profile can feed the formulas. */
	canDerive: boolean;
};

function snapshotProfile(reading: BodyReading, fallback: BodyProfile | null): {
	sex: Sex | null;
	date_of_birth: string | null;
	height_cm: number | null;
	activity: Activity | null;
} {
	const s = reading.profile_snapshot;
	// Rows taken before a profile existed fall back to today's profile — an estimate
	// beats nothing, and the row still keeps its own weight and timestamp.
	return {
		sex: s.sex ?? fallback?.sex ?? null,
		date_of_birth: s.date_of_birth ?? fallback?.date_of_birth ?? null,
		height_cm: s.height_cm ?? fallback?.height_cm ?? null,
		activity: s.activity ?? fallback?.activity ?? null,
	};
}

export function deriveBodyReading(reading: BodyReading, fallback: BodyProfile | null = null): DerivedReading {
	// Defence in depth for the same reason `toBodyReading` gates it: a caller can
	// hand us an unsanitized row, and pre-protocol scale rows hold undocumented
	// CF-frame bytes where the HR and impedance columns used to be.
	const trusted =
		reading.source === "manual" || (reading.captured_version ?? 0) >= CAPTURE_VERSION_STAGED;
	const normalizedReading: BodyReading = trusted
		? { ...reading, impedance_ohms: plausibleResistance(reading.impedance_ohms) }
		: { ...reading, heart_rate: null, impedance_ohms: null, impedance_source: null };
	const profile = snapshotProfile(normalizedReading, fallback);
	const age = profile.date_of_birth ? ageFromDob(profile.date_of_birth, new Date(normalizedReading.measured_at)) : null;
	const ageYears = age != null ? ageYearsDecimal(age) : null;
	const ohms = normalizedReading.impedance_ohms;
	const metrics = deriveReading({
		weightKg: normalizedReading.weight_kg,
		resistanceOhms: ohms,
		ageYears,
		sex: profile.sex,
		heightCm: profile.height_cm,
		activity: profile.activity,
	});
	return {
		reading: normalizedReading,
		metrics,
		age,
		ageYears,
		ohms,
		canDerive: profile.sex != null && ageYears != null && profile.height_cm != null,
	};
}

export function deriveBodyReadings(
	readings: BodyReading[],
	fallback: BodyProfile | null = null,
): DerivedReading[] {
	return readings.map((r) => deriveBodyReading(r, fallback));
}

export function metricValueOf(derived: DerivedReading, key: BodyMetricKey): number | null {
	switch (key) {
		case "weight_kg":
			return derived.reading.weight_kg;
		case "heart_rate":
			return derived.reading.heart_rate;
		case "impedance_ohms":
			return derived.ohms;
		case "bmi":
			return derived.metrics.bmi;
		case "body_fat_pct":
			return derived.metrics.bodyFatPct;
		case "fat_mass_kg":
			return derived.metrics.fatMassKg;
		case "ffm_kg":
			return derived.metrics.ffmKg;
		case "body_water_pct":
			return derived.metrics.bodyWaterPct;
		case "tbw_l":
			return derived.metrics.tbwL;
		case "bone_mass_kg":
			return derived.metrics.boneMassKg;
		case "muscle_mass_kg":
			return derived.metrics.muscleMassKg;
		case "muscle_pct":
			return derived.metrics.musclePct;
		case "smm_kg":
			return derived.metrics.smmKg;
		case "smm_pct":
			return derived.metrics.smmPct;
		case "visceral_fat_level":
			return derived.metrics.visceralFatLevel;
		case "subcutaneous_fat_pct":
			return derived.metrics.subcutaneousFatPct;
		case "subcutaneous_fat_kg":
			return derived.metrics.subcutaneousFatKg;
		case "protein_pct":
			return derived.metrics.proteinPct;
		case "protein_mass_kg":
			return derived.metrics.proteinMassKg;
		case "bmr_kcal":
			return derived.metrics.bmrKcal;
		case "tdee_kcal":
			return derived.metrics.tdeeKcal;
		case "body_age":
			return derived.metrics.bodyAge;
	}
}

/** How this row's value for `key` was produced. */
export function metricTier(derived: DerivedReading, key: BodyMetricKey): MetricTier {
	return derived.metrics.tiers[key];
}

/**
 * Provenance across a whole series: `mixed` is the honest answer when a scale that
 * reports impedance is introduced into a history of estimate-only rows, and the
 * chart says so instead of drawing one line as if it were one measurement.
 */
export function seriesTier(derived: DerivedReading[], key: BodyMetricKey): MetricTier | "mixed" | null {
	let seen: MetricTier | null = null;
	for (const row of derived) {
		if (metricValueOf(row, key) == null) continue;
		const tier = metricTier(row, key);
		if (seen == null) seen = tier;
		else if (seen !== tier) return "mixed";
	}
	return seen;
}

/** One point per reading that has a value for this metric, oldest first. */
export type BodyPoint = { id: string; at: number; value: number };

export function buildSeries(
	derived: DerivedReading[],
	key: BodyMetricKey,
): BodyPoint[] {
	const points: BodyPoint[] = [];
	for (const row of derived) {
		const value = metricValueOf(row, key);
		if (value == null || !Number.isFinite(value)) continue;
		points.push({ id: row.reading.id, at: new Date(row.reading.measured_at).getTime(), value });
	}
	// Oldest first: the chart draws left to right and the delta looks backwards.
	return points.sort((a, b) => a.at - b.at);
}

export function rangeStart(mode: BodyRange, today: Date): number {
	const dayMs = 24 * 60 * 60 * 1000;
	if (mode === "3weeks") return today.getTime() - 21 * dayMs;
	if (mode === "3m") return new Date(today.getFullYear(), today.getMonth() - 3, today.getDate()).getTime();
	if (mode === "6m") return new Date(today.getFullYear(), today.getMonth() - 6, today.getDate()).getTime();
	if (mode === "ytd") return new Date(today.getFullYear(), 0, 1).getTime();
	return 0;
}

export function filterRange(points: BodyPoint[], mode: BodyRange, today: Date): BodyPoint[] {
	if (mode === "all") return points;
	const start = rangeStart(mode, today);
	return points.filter((p) => p.at >= start);
}

export type BodySummary = {
	min: number | null;
	max: number | null;
	avg: number | null;
	latest: BodyPoint | null;
	first: BodyPoint | null;
	count: number;
};

export function summarize(points: BodyPoint[]): BodySummary {
	if (points.length === 0) return { min: null, max: null, avg: null, latest: null, first: null, count: 0 };
	const values = points.map((p) => p.value);
	const sum = values.reduce((a, b) => a + b, 0);
	return {
		min: Math.min(...values),
		max: Math.max(...values),
		avg: Math.round((sum / values.length) * 100) / 100,
		latest: points[points.length - 1],
		first: points[0],
		count: points.length,
	};
}

/**
 * Change over a trailing window: the newest point minus the newest point at least
 * `days` before it. A single weigh-in therefore has no trend at all (null) rather
 * than a delta measured against itself.
 */
export function trendDelta(points: BodyPoint[], days: number): number | null {
	if (points.length < 2) return null;
	const latest = points[points.length - 1];
	const dayMs = 24 * 60 * 60 * 1000;
	const cutoff = latest.at - days * dayMs;
	let baseline: BodyPoint | null = null;
	for (let i = points.length - 2; i >= 0; i--) {
		if (points[i].at <= cutoff) {
			baseline = points[i];
			break;
		}
	}
	if (!baseline) return null;
	return Math.round((latest.value - baseline.value) * 100) / 100;
}

/** Decimals shown per format — the integer-valued metrics must not read "10.0". */
const FORMAT_DECIMALS: Record<Format, number> = {
	mass: 1,
	percent: 1,
	index: 1,
	volume: 1,
	count: 0,
	energy: 0,
	ohms: 0,
	level: 0,
	years: 0,
};

/** Suffix per format. `mass` answers with the user's own unit system instead. */
const FORMAT_SUFFIX: Record<Format, string> = {
	mass: "",
	percent: "%",
	index: "",
	volume: " L",
	count: " bpm",
	energy: " kcal",
	ohms: " Ω",
	level: "",
	years: " yr",
};

function formatValue(format: Format, value: number, units: BodyUnits): string {
	if (format === "mass") return formatBodyMass(value, units);
	const shown = value.toFixed(FORMAT_DECIMALS[format]);
	return `${shown}${FORMAT_SUFFIX[format]}`;
}

/** Display-formatted value, unit included, `—` when the metric is unavailable. */
export function formatMetric(key: BodyMetricKey, value: number | null, units: BodyUnits): string {
	if (value == null || !Number.isFinite(value)) return "—";
	return formatValue(metricByKey(key).format, value, units);
}

/** Delta with its sign, used for the trend chips (an unchanged value reads as flat). */
export function formatMetricDelta(key: BodyMetricKey, delta: number | null, units: BodyUnits): string {
	if (delta == null || !Number.isFinite(delta)) return "—";
	const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
	return `${sign}${formatValue(metricByKey(key).format, Math.abs(delta), units)}`;
}

/** Unit label for the axis / summary strip of a metric. */
export function metricUnit(key: BodyMetricKey, units: BodyUnits): string {
	const { format } = metricByKey(key);
	return format === "mass" ? massUnit(units) : FORMAT_SUFFIX[format].trim();
}

export function formatAxisValue(key: BodyMetricKey, value: number, units: BodyUnits): string {
	const { format } = metricByKey(key);
	const decimals = FORMAT_DECIMALS[format];
	const shown = format === "mass" ? toDisplayMass(value, units) : value;
	return decimals ? shown.toFixed(decimals) : String(Math.round(shown));
}

/**
 * Metrics worth showing at all: a pill for a column that is every-null is noise
 * (muscle mass and impedance only exist on hardware that reports them).
 */
export function availableMetrics(derived: DerivedReading[]): BodyMetric[] {
	return BODY_METRICS.filter((metric) =>
		derived.some((row) => metricValueOf(row, metric.key) != null),
	);
}

export function formatMeasuredAt(iso: string, now = new Date()): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "—";
	const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	const isYesterday =
		at.getFullYear() === yesterday.getFullYear() &&
		at.getMonth() === yesterday.getMonth() &&
		at.getDate() === yesterday.getDate();
	const date = at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
	const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
	if (sameDay) return `Today ${time}`;
	if (isYesterday) return `Yesterday ${time}`;
	const withYear = at.getFullYear() !== now.getFullYear() ? ", " + at.getFullYear() : "";
	return `${date}${withYear} ${time}`;
}

/** Value for a datetime-local input, in the device's own zone. */
export function toLocalInputValue(iso: string): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
