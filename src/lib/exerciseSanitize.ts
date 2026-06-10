/** Limits and sanitizers for template / exercise editor fields. */

export const MAX_SETS = 12;
export const MIN_REPS = 1;
export const MAX_REPS = 999;
export const MAX_BASE_KG = 500;
export const MAX_INCREMENT_KG = 500;
export const MAX_EXERCISE_NAME_LEN = 24;
export const MAX_TEMPLATE_NAME_LEN = 18;
export const MAX_MINS = 99;
export const MAX_SECS = 59;
export const MAX_INCREMENT_SEC = 1000;
export const MIN_INCREMENT_SEC = 1;
/** Default +s for new / normalized time exercises. */
export const DEFAULT_INCREMENT_SEC = 5;
export const DEFAULT_TARGET_MINUTES = 0;
export const DEFAULT_TARGET_REPS = 12;
export const DEFAULT_BASE_KG = 15;
export const DEFAULT_INCREMENT_KG = 2.5;
export const DEFAULT_TARGET_SECONDS = 30;
export const DEFAULT_REST_MINUTES = 0;
export const DEFAULT_REST_SECONDS = 0;
export const MIN_REST_SECONDS = 0;

export type ExerciseTypeFieldStash = {
	reps?: {
		target_reps: number;
		current_weight: number | null;
		increment: number;
	};
	time?: {
		target_minutes: number;
		target_seconds: number;
		increment: number;
	};
};

export type DraftExerciseLike = {
	name?: string;
	exercise_type: "reps" | "time";
	target_sets?: number;
	target_reps?: number;
	target_minutes?: number;
	target_seconds?: number;
	rest_minutes?: number;
	rest_seconds?: number;
	increment?: number;
	current_weight?: number | null;
};

function clampInt(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min;
	return Math.min(max, Math.max(min, Math.round(n)));
}

function clampNum(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min;
	return Math.min(max, Math.max(min, n));
}

/** Round to at most one decimal place (e.g. 2.55 → 2.6, 15 → 15). */
export function roundToOneDecimal(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.round(n * 10) / 10;
}

export function formatOneDecimal(n: number): string {
	const r = roundToOneDecimal(n);
	return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function clampDecimalNum(n: number, min: number, max: number): number {
	return clampNum(roundToOneDecimal(n), min, max);
}

export type ClampedFieldInput = { value: number; display: string };
export type ClampedTextFieldInput = { value: string; display: string };

/** Live typing: strip junk, clamp, return what the input must show. */
export function clampIntFieldInput(
	raw: string,
	min: number,
	max: number,
): ClampedFieldInput {
	const t = raw.trim();
	if (t === "" || t === "-") {
		return { value: min, display: "" };
	}
	const digits = t.replace(/\D/g, "");
	if (!digits) {
		return { value: min, display: "" };
	}
	const value = clampInt(parseInt(digits, 10), min, max);
	return { value, display: String(value) };
}

/** Live typing for kg fields (one decimal max). */
export function clampDecimalFieldInput(
	raw: string,
	min: number,
	max: number,
): ClampedFieldInput {
	const t = raw.trim();
	if (t === "" || t === "-") {
		return { value: min, display: "" };
	}
	let cleaned = t.replace(/[^\d.]/g, "");
	const firstDot = cleaned.indexOf(".");
	if (firstDot !== -1) {
		const intPart = cleaned.slice(0, firstDot);
		const decPart = cleaned.slice(firstDot + 1).replace(/\./g, "").slice(0, 1);
		cleaned = decPart.length > 0 ? `${intPart}.${decPart}` : `${intPart}.`;
	}
	if (cleaned === "" || cleaned === ".") {
		return { value: min, display: "" };
	}
	if (cleaned.endsWith(".")) {
		const intPart = cleaned.slice(0, -1);
		if (intPart === "") {
			return { value: min, display: "" };
		}
		const parsed = parseFloat(intPart);
		if (!Number.isFinite(parsed)) {
			return { value: min, display: "" };
		}
		const value = clampDecimalNum(parsed, min, max);
		return { value, display: `${formatOneDecimal(value)}.` };
	}
	const parsed = parseFloat(cleaned);
	if (!Number.isFinite(parsed)) {
		return { value: min, display: "" };
	}
	const value = clampDecimalNum(parsed, min, max);
	return { value, display: formatOneDecimal(value) };
}

export function syncClampedInput(input: HTMLInputElement, display: string) {
	if (input.value !== display) {
		input.value = display;
	}
}

export function clampSetsFieldInput(raw: string): ClampedFieldInput {
	return clampIntFieldInput(raw, 0, MAX_SETS);
}

export function clampRepsFieldInput(raw: string): ClampedFieldInput {
	return clampIntFieldInput(raw, MIN_REPS, MAX_REPS);
}

export function clampMinsFieldInput(raw: string): ClampedFieldInput {
	const t = raw.trim();
	if (t === "" || t === "-") {
		return {
			value: DEFAULT_TARGET_MINUTES,
			display: String(DEFAULT_TARGET_MINUTES),
		};
	}
	return clampIntFieldInput(raw, 0, MAX_MINS);
}

export function clampSecsFieldInput(raw: string): ClampedFieldInput {
	return clampIntFieldInput(raw, 0, MAX_SECS);
}

export function clampRestMinsFieldInput(raw: string): ClampedFieldInput {
	const t = raw.trim();
	if (t === "" || t === "-") {
		return {
			value: DEFAULT_REST_MINUTES,
			display: String(DEFAULT_REST_MINUTES),
		};
	}
	return clampIntFieldInput(raw, MIN_REST_SECONDS, MAX_MINS);
}

export function clampRestSecsFieldInput(raw: string): ClampedFieldInput {
	const t = raw.trim();
	if (t === "" || t === "-") {
		return {
			value: DEFAULT_REST_SECONDS,
			display: String(DEFAULT_REST_SECONDS),
		};
	}
	return clampIntFieldInput(raw, MIN_REST_SECONDS, MAX_SECS);
}

export function clampBaseKgFieldInput(raw: string): ClampedFieldInput {
	return clampDecimalFieldInput(raw, 0, MAX_BASE_KG);
}

export function clampIncrementKgFieldInput(raw: string): ClampedFieldInput {
	return clampDecimalFieldInput(raw, 0, MAX_INCREMENT_KG);
}

export function clampIncrementSecFieldInput(raw: string): ClampedFieldInput {
	const t = raw.trim();
	if (t === "") {
		return {
			value: DEFAULT_INCREMENT_SEC,
			display: String(DEFAULT_INCREMENT_SEC),
		};
	}
	return clampIntFieldInput(raw, MIN_INCREMENT_SEC, MAX_INCREMENT_SEC);
}

export function clampTrackedRepsFieldInput(raw: string): ClampedFieldInput {
	return clampIntFieldInput(raw, 1, MAX_REPS);
}

export function sanitizeSets(n: number): number {
	return clampInt(n, 0, MAX_SETS);
}

export function sanitizeReps(n: number): number {
	return clampInt(n, MIN_REPS, MAX_REPS);
}

export function sanitizeBaseKg(n: number): number {
	return clampDecimalNum(n, 0, MAX_BASE_KG);
}

export function sanitizeIncrementKg(n: number): number {
	return clampDecimalNum(n, 0, MAX_INCREMENT_KG);
}

export function sanitizeIncrementSec(n: number): number {
	return clampNum(n, MIN_INCREMENT_SEC, MAX_INCREMENT_SEC);
}

export function sanitizeMinutes(n: number): number {
	return clampInt(n, 0, MAX_MINS);
}

export function sanitizeSeconds(n: number): number {
	return clampInt(n, 0, MAX_SECS);
}

export function sanitizeTrackedReps(n: number): number {
	return clampInt(n, 1, MAX_REPS);
}

export function sanitizeExerciseName(raw: string): string {
	return raw.slice(0, MAX_EXERCISE_NAME_LEN).toUpperCase();
}

export function sanitizeTemplateName(raw: string): string {
	return raw.slice(0, MAX_TEMPLATE_NAME_LEN).toUpperCase();
}

/** Live typing for exercise names (24 chars, uppercase). */
export function clampExerciseNameFieldInput(raw: string): ClampedTextFieldInput {
	const value = sanitizeExerciseName(raw);
	return { value, display: value };
}

/** Live typing for template names (18 chars, uppercase). */
export function clampTemplateNameFieldInput(raw: string): ClampedTextFieldInput {
	const value = sanitizeTemplateName(raw);
	return { value, display: value };
}

/** Add seconds to mm:ss target; carries/borrows; total capped at 99:59. */
export function addSecondsToTime(
	minutes: number,
	seconds: number,
	delta: number,
): { minutes: number; seconds: number } {
	const maxTotal = MAX_MINS * 60 + MAX_SECS;
	let total = sanitizeMinutes(minutes) * 60 + sanitizeSeconds(seconds) + delta;
	if (total < 0) total = 0;
	if (total > maxTotal) total = maxTotal;
	return {
		minutes: Math.floor(total / 60),
		seconds: total % 60,
	};
}

/** Bump a numeric field by delta without exceeding [min, max]. */
export function bumpCapped(
	value: number,
	delta: number,
	min: number,
	max: number,
): number {
	if (delta >= 0) return clampInt(value + delta, min, max);
	return clampInt(value + delta, min, max);
}

export function bumpSets(value: number, delta: number): number {
	return bumpCapped(value, delta, 1, MAX_SETS);
}

export function bumpReps(value: number, delta: number): number {
	return bumpCapped(value, delta, 1, MAX_REPS);
}

export function bumpBaseKg(value: number, delta: number): number {
	return clampDecimalNum(value + delta, 0, MAX_BASE_KG);
}

export function bumpIncrementKg(value: number, delta: number): number {
	return clampDecimalNum(value + delta, 0, MAX_INCREMENT_KG);
}

export function bumpIncrementSec(value: number, delta: number): number {
	return bumpCapped(value, delta, MIN_INCREMENT_SEC, MAX_INCREMENT_SEC);
}

export function validateDraftExercise(ex: DraftExerciseLike): string | null {
	const name = sanitizeExerciseName(ex.name ?? '').trim() || 'NEW EXERCISE';

	const sets = sanitizeSets(ex.target_sets ?? 0);
	if (sets === 0) return `"${name}" must have at least 1 set.`;

	if (ex.exercise_type === "reps") {
		const reps = sanitizeReps(ex.target_reps ?? 0);
		if (reps === 0) return `"${name}" must have at least 1 rep.`;
		return null;
	}

	const mins = sanitizeMinutes(ex.target_minutes ?? 0);
	const secs = sanitizeSeconds(ex.target_seconds ?? 0);
	if (mins === 0 && secs === 0) {
		return `"${name}" needs a target time (minutes or seconds).`;
	}
	const inc = ex.increment ?? 0;
	if (inc <= 0 || inc > MAX_INCREMENT_SEC) {
		return `"${name}" +s must be between 1 and ${MAX_INCREMENT_SEC}.`;
	}
	return null;
}

export function validateDraftExercises(
	exercises: DraftExerciseLike[],
): string | null {
	for (const ex of exercises) {
		const err = validateDraftExercise(ex);
		if (err) return err;
	}
	return null;
}

/** Normalize draft row in place (clamps fields; does not fix invalid 0 reps/time). */
export function normalizeDraftExercise(ex: DraftExerciseLike): void {
	ex.name = sanitizeExerciseName(ex.name ?? '').trim() || 'NEW EXERCISE';
	ex.target_sets = sanitizeSets(ex.target_sets ?? 0);
	if (ex.exercise_type === "reps") {
		ex.target_reps = sanitizeReps(ex.target_reps ?? 0);
		ex.current_weight = sanitizeBaseKg(ex.current_weight ?? 0);
		ex.increment = sanitizeIncrementKg(ex.increment ?? 0);
		ex.target_minutes = 0;
		ex.target_seconds = 0;
	} else {
		ex.target_minutes = sanitizeMinutes(
			ex.target_minutes ?? DEFAULT_TARGET_MINUTES,
		);
		ex.target_seconds = sanitizeSeconds(ex.target_seconds ?? 0);
		ex.increment = sanitizeIncrementSec(
			ex.increment ?? DEFAULT_INCREMENT_SEC,
		);
		ex.target_reps = 0;
		ex.current_weight = null;
	}
	// Rest time is common to both exercise types (default 0, and UI shows 0)
	ex.rest_minutes = sanitizeMinutes(ex.rest_minutes ?? DEFAULT_REST_MINUTES);
	ex.rest_seconds = sanitizeSeconds(ex.rest_seconds ?? DEFAULT_REST_SECONDS);
}

export function sanitizeExerciseRowForDb(
	ex: DraftExerciseLike,
): DraftExerciseLike {
	const copy = { ...ex };
	normalizeDraftExercise(copy);
	return copy;
}

/** Snapshot active type fields before toggling reps ↔ time. */
export function captureExerciseTypeFields(
	ex: DraftExerciseLike,
): Partial<ExerciseTypeFieldStash> {
	if (ex.exercise_type === "reps") {
		const reps = sanitizeReps(ex.target_reps ?? 0);
		return {
			reps: {
				target_reps: reps > 0 ? reps : DEFAULT_TARGET_REPS,
				current_weight:
					ex.current_weight != null
						? sanitizeBaseKg(ex.current_weight)
						: null,
				increment: sanitizeIncrementKg(
					ex.increment ?? DEFAULT_INCREMENT_KG,
				),
			},
		};
	}
	return {
		time: {
			target_minutes: sanitizeMinutes(
				ex.target_minutes ?? DEFAULT_TARGET_MINUTES,
			),
			target_seconds: sanitizeSeconds(ex.target_seconds ?? 0),
			increment: sanitizeIncrementSec(
				ex.increment ?? DEFAULT_INCREMENT_SEC,
			),
		},
	};
}

export function mergeExerciseTypeStash(
	existing: ExerciseTypeFieldStash | undefined,
	captured: Partial<ExerciseTypeFieldStash>,
): ExerciseTypeFieldStash {
	return {
		...existing,
		...captured,
		reps: captured.reps ?? existing?.reps,
		time: captured.time ?? existing?.time,
	};
}

/** Apply a type toggle, restoring stashed fields when switching back. */
export function applyDraftExerciseType(
	ex: DraftExerciseLike,
	type: "reps" | "time",
	stash?: ExerciseTypeFieldStash,
): void {
	ex.exercise_type = type;
	if (type === "time") {
		const saved = stash?.time;
		ex.target_minutes = saved?.target_minutes ?? DEFAULT_TARGET_MINUTES;
		const secs = saved?.target_seconds ?? ex.target_seconds ?? 0;
		ex.target_seconds =
			secs > 0 ? sanitizeSeconds(secs) : DEFAULT_TARGET_SECONDS;
		ex.increment = saved?.increment ?? DEFAULT_INCREMENT_SEC;
		return;
	}

	const saved = stash?.reps;
	const reps = saved?.target_reps ?? ex.target_reps ?? 0;
	ex.target_reps = reps > 0 ? sanitizeReps(reps) : DEFAULT_TARGET_REPS;
	ex.current_weight =
		saved?.current_weight ??
		(ex.current_weight != null
			? sanitizeBaseKg(ex.current_weight)
			: DEFAULT_BASE_KG);
	ex.increment = saved?.increment ?? DEFAULT_INCREMENT_KG;
}