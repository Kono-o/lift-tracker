/**
 * The device board: everything the app knows about nearby scales, in one order.
 *
 * Each platform reports devices its own way and at its own moment. The plugin hands
 * back OS-level bonded pairs immediately and then advertises during a scan; Web
 * Bluetooth only returns devices this origin was already allowed to reconnect to; a
 * browser that cannot enumerate anything at all returns nothing and keeps its own
 * picker as the only route. This module folds that stream into one de-duplicated,
 * stably-ordered list, and it is the only place the ordering rules live — so the
 * rules can be read and tested without a radio.
 *
 * Two things the list must never do:
 *   - reshuffle itself while a finger is on its way to a row, so a scan result that
 *     arrives mid-tap cannot move a button;
 *   - present a paired headphone or a neighbour's phone as a scale. Bonded devices
 *     are therefore name-filtered (`looksLikeScale`), because the only way to be sure
 *     about a bonded device is to connect to it.
 */

import { NAME_PREFIXES } from "./protocol";
import type { ScaleDeviceSeed } from "./transport";

export type { ScaleDeviceSeed };

export type ScaleDevice = {
	id: string;
	name: string | null;
	bonded: boolean;
	remembered: boolean;
	rssi: number | null;
	/** When it was last seen, so a stale sighting loses to a fresh one. */
	seenAt: number;
	/** The device this app connected to last — the one tap the user actually wants. */
	lastUsed: boolean;
};

/** Long enough for a scale to advertise several times, short enough to feel honest. */
export const SCAN_WINDOW_MS = 8_000;
/** A scan in a flat with 40 smart devices should not bury the user's scale. */
export const MAX_DEVICES = 12;

/**
 * Name fragments this family of scales ships under. Cult sells the same hardware to
 * several brands, so the list accepts a hint rather than an exact model: a bonded
 * device named "CS-BF01", "Smart Scale" or "QINGZHIMAI" is worth showing, and
 * "WH-1000XM4" is not.
 */
const SCALE_NAME_HINTS = [
	"scale",
	"weight",
	"cult",
	"cs-",
	"smart body",
	"body comp",
	"iqplus",
	"mialab",
	"qingzhimai",
];

/** Case-insensitive: advertisers are inconsistent about capitalisation. */
export function looksLikeScale(name: string | null | undefined): boolean {
	const value = (name ?? "").trim().toLowerCase();
	if (!value) return false;
	if (SCALE_NAME_HINTS.some((hint) => value.includes(hint))) return true;
	return NAME_PREFIXES.some((prefix) => value.startsWith(prefix.toLowerCase()));
}

function toDevice(seed: ScaleDeviceSeed, at: number, lastUsedId: string | null): ScaleDevice {
	return {
		id: seed.id,
		name: seed.name && seed.name.trim() ? seed.name.trim() : null,
		bonded: seed.bonded === true,
		remembered: seed.remembered === true,
		rssi: typeof seed.rssi === "number" && Number.isFinite(seed.rssi) ? seed.rssi : null,
		seenAt: at,
		lastUsed: lastUsedId != null && seed.id === lastUsedId,
	};
}

/**
 * Sticky facts survive a merge: a device seen bonded once is still bonded when a bare
 * advertisement arrives for it, and a name that one sighting carries is not lost when
 * the next arrives without one. Ordering is decided by `compare`, never by arrival.
 */
function merge(existing: ScaleDevice, seed: ScaleDeviceSeed, at: number, lastUsedId: string | null): ScaleDevice {
	const incoming = toDevice(seed, at, lastUsedId);
	return {
		id: existing.id,
		name: incoming.name ?? existing.name,
		bonded: existing.bonded || incoming.bonded,
		remembered: existing.remembered || incoming.remembered,
		// A bonded listing knows the device exists but not where it is, so it must not
		// erase a real signal reading with "unknown".
		rssi: incoming.rssi ?? existing.rssi,
		seenAt: Math.max(existing.seenAt, incoming.seenAt),
		lastUsed: existing.lastUsed || incoming.lastUsed,
	};
}

/** True when `a` should sit above `b`. */
function compare(a: ScaleDevice, b: ScaleDevice): boolean {
	if (a.lastUsed !== b.lastUsed) return a.lastUsed;
	// Reconnectable without a picker beats "it is somewhere out there".
	const reach = Number(a.bonded || a.remembered) - Number(b.bonded || b.remembered);
	if (reach !== 0) return reach > 0;
	const named = Number(a.name != null) - Number(b.name != null);
	if (named !== 0) return named > 0;
	if (a.rssi !== b.rssi) {
		// Strongest first; an unknown signal is not stronger than a weak one.
		return (a.rssi ?? Number.NEGATIVE_INFINITY) > (b.rssi ?? Number.NEGATIVE_INFINITY);
	}
	if (a.seenAt !== b.seenAt) return a.seenAt > b.seenAt;
	return a.id < b.id;
}

/**
 * Fold new sightings into the board. `at` is injectable so a test can prove the
 * recency rule without waiting; callers pass `Date.now()`.
 *
 * `lastUsedId` is the whole truth about that flag, so a caller that has just used a
 * different scale can re-rank by calling this with no new sightings at all.
 */
export function mergeDevices(
	current: ScaleDevice[],
	seeds: ScaleDeviceSeed[],
	options: { at?: number; lastUsedId?: string | null } = {},
): ScaleDevice[] {
	const at = options.at ?? Date.now();
	const lastUsedId = options.lastUsedId ?? null;
	const byId = new Map<string, ScaleDevice>();
	for (const device of current) byId.set(device.id, device);
	for (const seed of seeds) {
		if (!seed || typeof seed.id !== "string" || !seed.id) continue;
		// A bonded listing that is not recognisably a scale is somebody else's gadget.
		// Advertisements are already service-filtered by the transport, so they stay.
		if (seed.bonded && !seed.remembered && !looksLikeScale(seed.name)) continue;
		const existing = byId.get(seed.id);
		byId.set(seed.id, existing ? merge(existing, seed, at, lastUsedId) : toDevice(seed, at, lastUsedId));
	}
	return [...byId.values()]
		.map((device) => ({ ...device, lastUsed: device.id === lastUsedId }))
		.sort((a, b) => (compare(a, b) ? -1 : compare(b, a) ? 1 : 0))
		.slice(0, MAX_DEVICES);
}

/** What the row says about how this device came to be on the list. */
export function deviceBadge(device: ScaleDevice): "USED" | "PAIRED" | "SAVED" | "NEARBY" {
	if (device.lastUsed) return "USED";
	if (device.bonded) return "PAIRED";
	if (device.remembered) return "SAVED";
	return "NEARBY";
}

const LAST_DEVICE_KEY = "lift-tracker-scale-last-device";

/**
 * The board puts the scale this app actually connected to on top, and that has to
 * still be true the next time the sheet opens — a weigh-in is the same scale every
 * morning. Identifiers are stable per platform (a MAC on Android, an origin-scoped
 * token in Chrome), which is all a hint needs to be.
 */
export function rememberScaleDevice(id: string | null): void {
	if (!id || typeof window === "undefined") return;
	try {
		window.localStorage.setItem(LAST_DEVICE_KEY, id);
	} catch {
		// Storage disabled; the board just loses the hint.
	}
}

export function lastScaleDeviceId(): string | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage.getItem(LAST_DEVICE_KEY);
	} catch {
		return null;
	}
}

/** A MAC-less identifier is meaningless to a person, so show what there is of it. */
export function deviceTitle(device: ScaleDevice): string {
	return device.name ?? "Unnamed scale";
}

/** Last four characters: enough to tell two unnamed units apart. */
export function deviceTail(device: ScaleDevice): string {
	const id = device.id.replace(/[^0-9a-fA-F]/g, "");
	return id.length >= 4 ? id.slice(-4).toUpperCase() : device.id.slice(-4).toUpperCase();
}

export function discoverySelfTest(): string[] {
	const failures: string[] = [];
	const at = 1_000;

	if (!looksLikeScale("CS-BF01")) failures.push("a white-label CS- unit should look like a scale");
	if (!looksLikeScale("Cult Smart Scale")) failures.push("the brand name should look like a scale");
	if (looksLikeScale("WH-1000XM4")) failures.push("headphones must not be listed as a scale");
	if (looksLikeScale("")) failures.push("an empty name is not evidence of anything");

	// Bonded noise is dropped; a bare advertisement is not (the transport filtered it).
	const board = mergeDevices([], [
		{ id: "AA:BB:CC:DD:EE:01", name: "Pixel Buds", bonded: true },
		{ id: "AA:BB:CC:DD:EE:02", name: "CS-BF01", bonded: true },
		{ id: "AA:BB:CC:DD:EE:03", bonded: true },
		{ id: "AA:BB:CC:DD:EE:04", rssi: -71 },
	], { at });
	if (board.some((d) => d.id.endsWith("01"))) failures.push("a paired non-scale reached the board");
	// A bonded entry with no name cannot be recognised as anything, and guessing shows
	// the user's headphones as a scale. The same unit is picked up by the scan.
	if (board.some((d) => d.id.endsWith("03"))) failures.push("an unnamed paired device was claimed to be a scale");
	if (!board.some((d) => d.id.endsWith("02"))) failures.push("a named paired scale was dropped");

	// Order: last used, then reconnectable, then named, then signal.
	const ordered = mergeDevices(
		[
			{ id: "old", name: "Cult A", bonded: true, remembered: false, rssi: -90, seenAt: at, lastUsed: false },
		],
		[
			{ id: "far", name: "Cult B", rssi: -85 },
			{ id: "loud", name: "Cult C", rssi: -40 },
			{ id: "quiet", rssi: -55 },
		],
		{ at: at + 1, lastUsedId: "quiet" },
	);
	if (ordered.map((d) => d.id).join(",") !== "quiet,old,loud,far") {
		failures.push(`wrong order: ${ordered.map((d) => d.id).join(",")}`);
	}

	// A merge keeps the sticky facts and the better name, never a second row.
	const merged = mergeDevices(
		[{ id: "x", name: "Cult CS-BF01", bonded: true, remembered: false, rssi: -60, seenAt: at, lastUsed: false }],
		[{ id: "x", rssi: -58 }],
		{ at: at + 5 },
	);
	if (merged.length !== 1) failures.push("the same device produced two rows");
	if (!merged[0].bonded) failures.push("a bare advertisement cleared the bonded flag");
	if (merged[0].name !== "Cult CS-BF01") failures.push("a nameless sighting erased the name");
	if (merged[0].rssi !== -58) failures.push("the newer signal was not used");

	// An unknown signal must not outrank a measured one.
	const noSignal = mergeDevices([], [
		{ id: "unknown", name: "S" },
		{ id: "weak", name: "S", rssi: -95 },
	], { at });
	if (noSignal[0].id !== "weak") failures.push("an unknown signal beat a weak one");

	if (deviceBadge({ id: "x", name: null, bonded: false, remembered: true, rssi: null, seenAt: 0, lastUsed: false }) !== "SAVED") {
		failures.push("a remembered device should be badged SAVED");
	}
	if (deviceTail({ id: "00:11:22:33:AA:BB", name: null, bonded: false, remembered: false, rssi: null, seenAt: 0, lastUsed: false }) !== "AABB") {
		failures.push("the identifier tail should be the last four hex characters");
	}

	// The cap keeps a crowded flat usable; the tail dropped must be the weakest.
	const crowded = mergeDevices(
		[],
		Array.from({ length: MAX_DEVICES + 6 }, (_, i) => ({ id: `d${String(i).padStart(2, "0")}`, rssi: -30 - i })),
		{ at },
	);
	if (crowded.length !== MAX_DEVICES) failures.push(`board should cap at ${MAX_DEVICES}`);
	if (crowded[crowded.length - 1].id !== `d${String(MAX_DEVICES - 1).padStart(2, "0")}`) {
		failures.push("the board kept a weak signal over a strong one");
	}

	// Nothing may depend on arrival order: a scan result that lands mid-tap must not
	// reshuffle the rows, so the same sightings have to produce the same board.
	const seeds = [
		{ id: "same-2", name: "S", rssi: -60 },
		{ id: "same-1", name: "S", rssi: -60 },
		{ id: "same-3", name: "S", rssi: -60 },
	];
	const twice = mergeDevices([], seeds, { at }).map((d) => d.id).join(",");
	const reversed = mergeDevices([], [...seeds].reverse(), { at }).map((d) => d.id).join(",");
	if (twice !== reversed) failures.push(`board depended on arrival order: ${twice} vs ${reversed}`);

	// Re-ranking the board after a weigh-in needs no new sightings, only a new hint.
	const reranked = mergeDevices(ordered, [], { at: at + 2, lastUsedId: "far" });
	if (reranked[0].id !== "far" || !reranked[0].lastUsed) failures.push("the board did not move to the scale just used");
	if (reranked.some((d) => d.id !== "far" && d.lastUsed)) failures.push("two rows claim to be the one used");

	return failures;
}
