/**
 * Shape + coercion for the two body-data tables.
 *
 * PostgREST hands back `numeric` as a string and `smallint` as a number, and the
 * profile snapshot is free-form jsonb, so every row goes through these converters
 * before the UI sees it. Nothing here validates user input — the `save_profile` /
 * `save_body_reading` RPCs own that, and their errors surface to the caller.
 */

import { isActivity, type Activity, type Sex } from "./bodyComp";

export type BodyReadingSource = "scale" | "manual";

/**
 * Rows written by the staged capture protocol declare their provenance. Anything
 * older (null here) kept heart rate and impedance in bytes the Cult `0xCF` frame
 * does not actually define, so those columns stay distrusted for those rows.
 */
export const CAPTURE_VERSION_STAGED = 2;

/** Sex / DOB / height. Age is never stored: it is derived from `date_of_birth`. */
export interface BodyProfile {
	sex: Sex | null;
	/** ISO calendar date, YYYY-MM-DD. */
	date_of_birth: string | null;
	height_cm: number | null;
	/** Optional; TDEE is withheld until the user picks one. */
	activity: Activity | null;
}

export type BodyProfileInput = {
	sex: Sex | null;
	date_of_birth: string | null;
	height_cm: number | null;
	/** Required so a caller cannot wipe a chosen level by forgetting to carry it over. */
	activity: Activity | null;
};

/** The profile in force when a reading was taken — history stays pinned to it. */
export type BodyReadingSnapshot = {
	sex: Sex | null;
	date_of_birth: string | null;
	height_cm: number | null;
	activity: Activity | null;
};

export interface BodyReading {
	id: string;
	user_id: string;
	/** ISO timestamp with zone, as stored. */
	measured_at: string;
	weight_kg: number;
	heart_rate: number | null;
	/** Whole-body resistance in ohms, band-checked at capture. */
	impedance_ohms: number | null;
	/** Which byte map produced `impedance_ohms`, e.g. `be-wholebody`. */
	impedance_source: string | null;
	/** `CAPTURE_VERSION_STAGED` on rows that may be trusted, null on legacy ones. */
	captured_version: number | null;
	source: BodyReadingSource;
	device_label: string | null;
	profile_snapshot: BodyReadingSnapshot;
}

export type BodyReadingInput = {
	/** Null/omitted inserts a new reading; an id updates that row. */
	id?: string | null;
	measured_at?: string | null;
	weight_kg: number;
	heart_rate?: number | null;
	impedance_ohms?: number | null;
	impedance_source?: string | null;
	captured_version?: number | null;
	source?: BodyReadingSource;
	device_label?: string | null;
};

export const DEVICE_LABEL_MAX = 40;

function num(value: unknown): number | null {
	if (value == null || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function int(value: unknown): number | null {
	const parsed = num(value);
	return parsed == null ? null : Math.round(parsed);
}

function isoDate(value: unknown): string | null {
	if (typeof value !== "string") return null;
	return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function sexValue(value: unknown): Sex | null {
	return value === "male" || value === "female" || value === "other" ? value : null;
}

function activityValue(value: unknown): Activity | null {
	return isActivity(value) ? value : null;
}

export function toBodyProfile(row: Record<string, unknown> | null | undefined): BodyProfile {
	return {
		sex: sexValue(row?.sex),
		date_of_birth: isoDate(row?.date_of_birth),
		height_cm: num(row?.height_cm),
		activity: activityValue(row?.activity),
	};
}

function toSnapshot(value: unknown): BodyReadingSnapshot {
	const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	return {
		sex: sexValue(row.sex),
		date_of_birth: isoDate(row.date_of_birth),
		height_cm: num(row.height_cm),
		activity: activityValue(row.activity),
	};
}

/** Null when the row is unusable (no id, no weight) rather than a half-row the chart trips over. */
export function toBodyReading(row: Record<string, unknown>): BodyReading | null {
	const weightKg = num(row.weight_kg);
	if (typeof row.id !== "string" || typeof row.measured_at !== "string" || weightKg == null) return null;
	const source = row.source === "scale" ? "scale" : "manual";
	const label = typeof row.device_label === "string" ? row.device_label.slice(0, DEVICE_LABEL_MAX) : null;
	const capturedVersion = int(row.captured_version);
	// The verified Cult 0xCF BLE packet has no heart rate or impedance. App versions
	// before the staged capture protocol wrote undocumented frame bytes into those
	// columns, so only a row that declares its provenance is believed. The legacy
	// bytes stay in the database but never reach the UI.
	const trusted = source === "manual" || (capturedVersion ?? 0) >= CAPTURE_VERSION_STAGED;
	const ohms = trusted ? num(row.impedance_ohms) : null;
	return {
		id: row.id,
		user_id: typeof row.user_id === "string" ? row.user_id : "",
		measured_at: row.measured_at,
		weight_kg: weightKg,
		heart_rate: trusted ? int(row.heart_rate) : null,
		impedance_ohms: ohms != null && ohms > 0 ? ohms : null,
		impedance_source: ohms != null && typeof row.impedance_source === "string" ? row.impedance_source : null,
		captured_version: capturedVersion,
		source,
		device_label: label && label.trim() ? label.trim() : null,
		profile_snapshot: toSnapshot(row.profile_snapshot),
	};
}

export function toBodyReadingList(rows: Array<Record<string, unknown>> | null | undefined): BodyReading[] {
	return (rows ?? []).map(toBodyReading).filter((r): r is BodyReading => r != null);
}

/** Truncated to the column's limit so the label never bounces off a CHECK. */
export function clampDeviceLabel(value: string | null | undefined): string | null {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return null;
	return trimmed.slice(0, DEVICE_LABEL_MAX);
}
