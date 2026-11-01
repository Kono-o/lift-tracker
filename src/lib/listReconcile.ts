/**
 * Reconcile a live, optimistically edited list with a save response that was
 * produced from an earlier snapshot.
 *
 * A save round-trip can overlap with the user adding, deleting, or reordering
 * rows. Applying the response wholesale would revert those edits (and a delete
 * could resurrect a row). The response is therefore only trusted for id
 * changes — temp ids replaced by persisted ids — while values and order stay
 * with the live draft until the follow-up save.
 */

export type IdRow = { id: string };

export function promotionsFromSave(
	snapshot: readonly IdRow[],
	saved: readonly IdRow[],
): Map<string, string> {
	const promotions = new Map<string, string>();
	const count = Math.min(snapshot.length, saved.length);
	for (let i = 0; i < count; i++) {
		const from = snapshot[i]?.id;
		const to = saved[i]?.id;
		if (from && to && from !== to) promotions.set(from, to);
	}
	return promotions;
}

export function promoteId(id: string, promotions: Map<string, string>): string {
	return promotions.get(id) ?? id;
}

/** Returns the original set when nothing changed so reactive state isn't dirtied. */
export function promoteIdSet(ids: Set<string>, promotions: Map<string, string>): Set<string> {
	if (promotions.size === 0 || ids.size === 0) return ids;
	let changed = false;
	const next = new Set<string>();
	for (const id of ids) {
		const mapped = promotions.get(id) ?? id;
		if (mapped !== id) changed = true;
		next.add(mapped);
	}
	return changed ? next : ids;
}

/** Returns the original record when nothing changed so reactive state isn't dirtied. */
export function promoteKeyedRecord<T>(
	record: Record<string, T>,
	promotions: Map<string, string>,
): Record<string, T> {
	if (promotions.size === 0) return record;
	let changed = false;
	const next: Record<string, T> = {};
	for (const [id, value] of Object.entries(record)) {
		const mapped = promotions.get(id) ?? id;
		if (mapped !== id) changed = true;
		next[mapped] = value;
	}
	return changed ? next : record;
}
