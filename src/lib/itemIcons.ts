/** Shared icon index set for templates + tracked stats (0–31). */

import type { Component } from "svelte";
import {
	Activity,
	Apple,
	Award,
	BicepsFlexed,
	Bike,
	CalendarDays,
	Dna,
	Droplet,
	Dumbbell,
	Flame,
	Footprints,
	Gauge,
	Hash,
	Heart,
	HeartPulse,
	Medal,
	Moon,
	Mountain,
	PersonStanding,
	Repeat,
	Ruler,
	Salad,
	Scale,
	Star,
	Sun,
	Target,
	Timer,
	Trophy,
	TrendingUp,
	Weight,
	Wind,
	Zap,
} from "@lucide/svelte";

export const ITEM_ICON_MAX = 31;
export const ITEM_ICON_COUNT = ITEM_ICON_MAX + 1;
/** Default for stats (legacy Dna). */
export const DEFAULT_ITEM_ICON = 0;
/** Default for new templates (Weight). */
export const DEFAULT_TEMPLATE_ICON = 1;
/** Bold Lucide stroke for template/stat item icons. */
export const ITEM_ICON_STROKE = 2.75;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ItemIconComponent = Component<any, any, any>;

/**
 * Lucide components for indices 0–31.
 * Keep order stable — do not reorder existing entries (breaks saved icons).
 */
export const ITEM_ICONS: ItemIconComponent[] = [
	// 0–9 (original stats set)
	Dna,
	Weight,
	Heart,
	Zap,
	TrendingUp,
	Activity,
	Timer,
	Ruler,
	Scale,
	Hash,
	// 10–15
	Dumbbell,
	Flame,
	Target,
	BicepsFlexed,
	CalendarDays,
	Moon,
	// 16–31
	PersonStanding,
	Footprints,
	Bike,
	Mountain,
	Trophy,
	Medal,
	Gauge,
	HeartPulse,
	Apple,
	Salad,
	Droplet,
	Sun,
	Wind,
	Star,
	Award,
	Repeat,
];

export function clampItemIcon(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_ITEM_ICON;
	return Math.max(0, Math.min(ITEM_ICON_MAX, Math.floor(n)));
}

export function getItemIcon(id: number): ItemIconComponent {
	return ITEM_ICONS[clampItemIcon(id)] ?? ITEM_ICONS[0];
}
