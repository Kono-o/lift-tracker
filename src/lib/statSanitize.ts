/** Limits and sanitizers for tracked stat editor fields. */

export const MAX_STATS = 20;
export const MAX_STAT_NAME_LEN = 24;
export const MAX_STAT_UNIT_LEN = 6;
export const MIN_STAT_VALUE = 0.0001;
export const MAX_STAT_VALUE = 999999;

export type DraftStatLike = {
	id?: string;
	name?: string;
	unit?: string;
	display_order?: number;
	start_value?: number;
	has_target?: boolean;
	target_value?: number | null;
	target_prefers_lower?: boolean;
	icon?: number;
};

function clampInt(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min;
	return Math.min(max, Math.max(min, Math.round(n)));
}

export function sanitizeStatName(raw: string): string {
	return raw
		.toUpperCase()
		.replace(/[^\w\s\-+%./]/g, "")
		.slice(0, MAX_STAT_NAME_LEN);
}

export function sanitizeStatUnit(raw: string): string {
	return raw
		.toUpperCase()
		.replace(/[^\w%./+\-]/g, "")
		.slice(0, MAX_STAT_UNIT_LEN);
}

export function clampStatNameFieldInput(raw: string): {
	value: string;
	display: string;
} {
	const value = sanitizeStatName(raw);
	return { value, display: value };
}

export function clampStatUnitFieldInput(raw: string): {
	value: string;
	display: string;
} {
	const value = sanitizeStatUnit(raw);
	return { value, display: value };
}

export function sanitizeStatConfigValue(raw: number): number {
	if (!Number.isFinite(raw) || raw < 0) return 0;
	return Math.min(MAX_STAT_VALUE, raw);
}

export function clampStatValueFieldInput(raw: string): {
	value: number;
	display: string;
} {
	const t = raw.trim();
	if (t === "") return { value: 0, display: "" };
	const cleaned = t.replace(/,/g, ".");
	const n = Number.parseFloat(cleaned);
	if (!Number.isFinite(n) || n < 0) return { value: 0, display: "" };
	const value = sanitizeStatConfigValue(n);
	let display = Number.isInteger(value) ? String(value) : String(value);
	if (cleaned.endsWith(".") && !display.includes(".")) {
		display += ".";
	}
	return { value, display };
}

export function clampStatLogFieldInput(raw: string): {
	value: number;
	display: string;
} {
	const t = raw.trim();
	if (t === "") return { value: 0, display: "" };
	const cleaned = t.replace(/,/g, ".");
	const n = Number.parseFloat(cleaned);
	if (!Number.isFinite(n) || n <= 0) return { value: 0, display: "" };
	const value = Math.min(MAX_STAT_VALUE, Math.max(MIN_STAT_VALUE, n));
	let display = Number.isInteger(value) ? String(value) : String(value);
	if (cleaned.endsWith(".") && !display.includes(".")) {
		display += ".";
	}
	return { value, display };
}

export function validateDraftStat(stat: DraftStatLike): string | null {
	const name = sanitizeStatName(stat.name ?? "").trim() || "NEW STAT";
	if (!name) return "Stat name is required.";
	if (name.length > MAX_STAT_NAME_LEN) {
		return `Stat name must be at most ${MAX_STAT_NAME_LEN} characters.`;
	}
	const unit = sanitizeStatUnit(stat.unit ?? "");
	if (unit.length > MAX_STAT_UNIT_LEN) {
		return `Unit must be at most ${MAX_STAT_UNIT_LEN} characters.`;
	}
	const start = sanitizeStatConfigValue(stat.start_value ?? 0);
	if (!Number.isFinite(start) || start < 0) {
		return "Start value must be 0 or greater.";
	}
	if (stat.has_target && sanitizeStatConfigValue(stat.target_value ?? 0) <= 0) {
		return "Target value must be greater than 0 when target is enabled.";
	}
	return null;
}

export function validateDraftStats(stats: DraftStatLike[]): string | null {
	if (stats.length > MAX_STATS) {
		return `You can track at most ${MAX_STATS} stats.`;
	}
	for (const stat of stats) {
		const err = validateDraftStat(stat);
		if (err) return err;
	}
	return null;
}

export function normalizeDraftStat(stat: DraftStatLike): void {
	stat.name = sanitizeStatName(stat.name ?? "").trim() || "NEW STAT";
	stat.unit = sanitizeStatUnit(stat.unit ?? "");
	stat.display_order = clampInt(stat.display_order ?? 0, 0, MAX_STATS - 1);
	stat.start_value = sanitizeStatConfigValue(stat.start_value ?? 0);
	stat.has_target = !!stat.has_target;
	stat.target_value = stat.has_target
		? sanitizeStatConfigValue(stat.target_value ?? 0)
		: null;
	// New: whether the user's goal is to be at-or-below the target (true) or at-or-above (false)
	stat.target_prefers_lower = stat.target_prefers_lower !== undefined ? !!stat.target_prefers_lower : true;
	stat.icon = stat.icon ?? 0;
}

export function sanitizeStatRowForDb(stat: DraftStatLike): DraftStatLike {
	const copy = { ...stat };
	normalizeDraftStat(copy);
	return copy;
}

export type TrackedStatLike = {
	id: string;
	user_id: string;
	name: string;
	unit?: string | null;
	display_order?: number | null;
	start_value?: number | null;
	has_target?: boolean | null;
	target_value?: number | null;
	target_prefers_lower?: boolean | null;
	icon?: number | null;
};

export function toTrackedStat(row: TrackedStatLike, fallbackOrder = 0) {
	const has_target = !!row.has_target;
	return {
		id: row.id,
		user_id: row.user_id,
		name: row.name,
		unit: row.unit ?? "",
		display_order: row.display_order ?? fallbackOrder,
		start_value: row.start_value ?? 0,
		has_target,
		target_value: has_target ? (row.target_value ?? null) : null,
		target_prefers_lower: row.target_prefers_lower ?? true,
		icon: row.icon ?? 0,
	};
}

export function sanitizeStatLogValue(raw: number): number | null {
	if (!Number.isFinite(raw) || raw <= 0) return null;
	return Math.min(MAX_STAT_VALUE, Math.max(MIN_STAT_VALUE, raw));
}