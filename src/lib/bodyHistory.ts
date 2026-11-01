/**
 * Reading-row → chart-ready data for the BODY tab.
 *
 * The database stores one row per weigh-in (weight, HR, raw impedance) plus the
 * profile that was in force at the time; every other metric is derived here, so a
 * formula fix re-derives history instead of leaving stale stored numbers. Age is
 * derived *as of the measurement*, which is what makes a two-year-old row still
 * meaningful after a birthday.
 */

import {
	deriveReading,
	impedanceOhms,
	type BodyMetrics,
	type Sex,
} from "./bodyComp";
import { ageFromDob, ageYearsDecimal, type Age } from "./age";
import { formatBodyMass, massUnit, toDisplayMass, type BodyUnits } from "./units";
import type { BodyProfile, BodyReading } from "./bodySanitize";

export type BodyMetricKey =
	| "weight_kg"
	| "heart_rate"
	| "bmi"
	| "body_fat_pct"
	| "fat_mass_kg"
	| "ffm_kg"
	| "body_water_pct"
	| "bmr_kcal"
	| "smm_kg"
	| "impedance_ohms";

export type BodyRange = "3weeks" | "3m" | "6m" | "ytd" | "all";

type Format = "mass" | "percent" | "count" | "energy" | "ohms" | "index";

export interface BodyMetric {
	key: BodyMetricKey;
	label: string;
	format: Format;
	/** Raw units only — the display conversion is per-reading, in `formatMetric`. */
	hint: string;
}

/** Order is the pill order; weight first because it is the only measured truth. */
export const BODY_METRICS: BodyMetric[] = [
	{ key: "weight_kg", label: "WEIGHT", format: "mass", hint: "From the scale" },
	{ key: "heart_rate", label: "HEART RATE", format: "count", hint: "During measurement" },
	{ key: "bmi", label: "BMI", format: "index", hint: "Weight ÷ height²" },
	{ key: "body_fat_pct", label: "BODY FAT", format: "percent", hint: "Deurenberg, from BMI + age" },
	{ key: "fat_mass_kg", label: "FAT MASS", format: "mass", hint: "Weight × body-fat %" },
	{ key: "ffm_kg", label: "LEAN MASS", format: "mass", hint: "Weight − fat mass" },
	{ key: "body_water_pct", label: "BODY WATER", format: "percent", hint: "Watson, from weight + height + age" },
	{ key: "bmr_kcal", label: "BMR", format: "energy", hint: "Mifflin-St Jeor, kcal/day" },
	{ key: "smm_kg", label: "MUSCLE", format: "mass", hint: "Janssen — needs a real impedance reading" },
	{ key: "impedance_ohms", label: "IMPEDANCE", format: "ohms", hint: "Only scales that report it" },
];

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
} {
	const s = reading.profile_snapshot;
	// Rows taken before a profile existed fall back to today's profile — an estimate
	// beats nothing, and the row still keeps its own weight and timestamp.
	return {
		sex: s.sex ?? fallback?.sex ?? null,
		date_of_birth: s.date_of_birth ?? fallback?.date_of_birth ?? null,
		height_cm: s.height_cm ?? fallback?.height_cm ?? null,
	};
}

export function deriveBodyReading(reading: BodyReading, fallback: BodyProfile | null = null): DerivedReading {
	// Old scale records contain undocumented CF-frame bytes in the HR/impedance
	// columns. Normalize at the history boundary so no downstream view can expose
	// them, even when a caller supplied a raw row rather than `toBodyReading` output.
	const normalizedReading = reading.source === "scale"
		? { ...reading, heart_rate: null, impedance_raw: null }
		: reading;
	const profile = snapshotProfile(normalizedReading, fallback);
	const age = profile.date_of_birth ? ageFromDob(profile.date_of_birth, new Date(normalizedReading.measured_at)) : null;
	const ageYears = age != null ? ageYearsDecimal(age) : null;
	const impedanceRaw = normalizedReading.impedance_raw;
	const ohms = impedanceOhms(impedanceRaw);
	const metrics = deriveReading({
		weightKg: normalizedReading.weight_kg,
		impedanceRaw,
		ageYears,
		sex: profile.sex,
		heightCm: profile.height_cm,
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
			return derived.reading.source === "scale" ? null : derived.reading.heart_rate;
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
		case "bmr_kcal":
			return derived.metrics.bmrKcal;
		case "smm_kg":
			return derived.metrics.smmKg;
	}
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

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Display-formatted value, unit included, `—` when the metric is unavailable. */
export function formatMetric(key: BodyMetricKey, value: number | null, units: BodyUnits): string {
	if (value == null || !Number.isFinite(value)) return "—";
	const metric = metricByKey(key);
	switch (metric.format) {
		case "mass":
			return formatBodyMass(value, units);
		case "percent":
			return `${r1(value)}%`;
		case "count":
			return `${Math.round(value)} bpm`;
		case "energy":
			return `${Math.round(value)} kcal`;
		case "ohms":
			return `${Math.round(value)} Ω`;
		case "index":
			return r1(value).toFixed(1);
	}
}

/** Delta with its sign, used for the trend chips (an unchanged value reads as flat). */
export function formatMetricDelta(key: BodyMetricKey, delta: number | null, units: BodyUnits): string {
	if (delta == null || !Number.isFinite(delta)) return "—";
	const metric = metricByKey(key);
	const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
	const abs = Math.abs(delta);
	switch (metric.format) {
		case "mass":
			return `${sign}${formatBodyMass(abs, units, { withUnit: true })}`;
		case "percent":
			return `${sign}${r1(abs)}%`;
		case "count":
			return `${sign}${Math.round(abs)} bpm`;
		case "energy":
			return `${sign}${Math.round(abs)} kcal`;
		case "ohms":
			return `${sign}${Math.round(abs)} Ω`;
		case "index":
			return `${sign}${r1(abs).toFixed(1)}`;
	}
}

/** Unit label for the axis / summary strip of a metric. */
export function metricUnit(key: BodyMetricKey, units: BodyUnits): string {
	switch (metricByKey(key).format) {
		case "mass":
			return massUnit(units);
		case "percent":
			return "%";
		case "count":
			return "bpm";
		case "energy":
			return "kcal";
		case "ohms":
			return "Ω";
		case "index":
			return "";
	}
}

export function formatAxisValue(key: BodyMetricKey, value: number, units: BodyUnits): string {
	const { format } = metricByKey(key);
	const decimals = format === "mass" || format === "index" || format === "percent" ? 1 : 0;
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
