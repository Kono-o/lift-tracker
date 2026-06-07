/** Limits and sanitizers for tracked stat editor fields. */

export const MAX_STATS = 20;
export const MAX_STAT_NAME_LEN = 24;
export const MAX_STAT_UNIT_LEN = 8;
export const MIN_STAT_VALUE = 0.0001;
export const MAX_STAT_VALUE = 999999;

export type DraftStatLike = {
	id?: string;
	name?: string;
	unit?: string;
	display_order?: number;
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

export function validateDraftStat(stat: DraftStatLike): string | null {
	const name = sanitizeStatName(stat.name ?? "").trim() || "NEW STAT";
	if (!name) return "Stat name is required.";
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
}

export function sanitizeStatRowForDb(stat: DraftStatLike): DraftStatLike {
	const copy = { ...stat };
	normalizeDraftStat(copy);
	return copy;
}

export function sanitizeStatLogValue(raw: number): number | null {
	if (!Number.isFinite(raw) || raw <= 0) return null;
	return Math.min(MAX_STAT_VALUE, Math.max(MIN_STAT_VALUE, raw));
}