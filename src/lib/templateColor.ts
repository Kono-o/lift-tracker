/** Template color: single integer 0–255 → quantized HSV spectrum. */

export const TEMPLATE_COLOR_MAX = 255;
export const TEMPLATE_COLOR_HUE_STEPS = 16;
export const TEMPLATE_COLOR_SAT_STEPS = 4;
export const TEMPLATE_COLOR_VAL_STEPS = 4;

/** Default template color index → #FFBF00 (amber gold). */
export const DEFAULT_TEMPLATE_COLOR = 242;

export function clampTemplateColor(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(TEMPLATE_COLOR_MAX, Math.floor(n)));
}

export type Hsv = { h: number; s: number; v: number };
export type Rgb = { r: number; g: number; b: number };

/** Unpack index → HSV (h 0–360, s/v 0–1). */
export function indexToHsv(index: number): Hsv {
	const i = clampTemplateColor(index);
	const hi = i % TEMPLATE_COLOR_HUE_STEPS;
	const si = Math.floor(i / TEMPLATE_COLOR_HUE_STEPS) % TEMPLATE_COLOR_SAT_STEPS;
	const vi = Math.floor(i / (TEMPLATE_COLOR_HUE_STEPS * TEMPLATE_COLOR_SAT_STEPS)) % TEMPLATE_COLOR_VAL_STEPS;
	return {
		h: (hi / TEMPLATE_COLOR_HUE_STEPS) * 360,
		// Avoid pure gray/black so template chips stay readable on dark UI
		s: 0.3 + (si / Math.max(1, TEMPLATE_COLOR_SAT_STEPS - 1)) * 0.7,
		v: 0.45 + (vi / Math.max(1, TEMPLATE_COLOR_VAL_STEPS - 1)) * 0.55,
	};
}

/** Snap continuous HSV to nearest palette index 0–255. */
export function hsvToNearestIndex(h: number, s: number, v: number): number {
	let hh = h % 360;
	if (hh < 0) hh += 360;
	const ss = Math.max(0, Math.min(1, s));
	const vv = Math.max(0, Math.min(1, v));

	const hi = Math.round((hh / 360) * TEMPLATE_COLOR_HUE_STEPS) % TEMPLATE_COLOR_HUE_STEPS;
	// Inverse of indexToHsv sat/val mapping
	const si = Math.max(
		0,
		Math.min(
			TEMPLATE_COLOR_SAT_STEPS - 1,
			Math.round(((ss - 0.3) / 0.7) * (TEMPLATE_COLOR_SAT_STEPS - 1)),
		),
	);
	const vi = Math.max(
		0,
		Math.min(
			TEMPLATE_COLOR_VAL_STEPS - 1,
			Math.round(((vv - 0.45) / 0.55) * (TEMPLATE_COLOR_VAL_STEPS - 1)),
		),
	);
	return clampTemplateColor(
		hi + si * TEMPLATE_COLOR_HUE_STEPS + vi * TEMPLATE_COLOR_HUE_STEPS * TEMPLATE_COLOR_SAT_STEPS,
	);
}

export function hsvToRgb(h: number, s: number, v: number): Rgb {
	let hh = h % 360;
	if (hh < 0) hh += 360;
	const ss = Math.max(0, Math.min(1, s));
	const vv = Math.max(0, Math.min(1, v));
	const c = vv * ss;
	const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
	const m = vv - c;
	let rp = 0,
		gp = 0,
		bp = 0;
	if (hh < 60) {
		rp = c;
		gp = x;
	} else if (hh < 120) {
		rp = x;
		gp = c;
	} else if (hh < 180) {
		gp = c;
		bp = x;
	} else if (hh < 240) {
		gp = x;
		bp = c;
	} else if (hh < 300) {
		rp = x;
		bp = c;
	} else {
		rp = c;
		bp = x;
	}
	return {
		r: Math.round((rp + m) * 255),
		g: Math.round((gp + m) * 255),
		b: Math.round((bp + m) * 255),
	};
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
	const rr = r / 255;
	const gg = g / 255;
	const bb = b / 255;
	const max = Math.max(rr, gg, bb);
	const min = Math.min(rr, gg, bb);
	const d = max - min;
	let h = 0;
	if (d !== 0) {
		if (max === rr) h = 60 * (((gg - bb) / d) % 6);
		else if (max === gg) h = 60 * ((bb - rr) / d + 2);
		else h = 60 * ((rr - gg) / d + 4);
	}
	if (h < 0) h += 360;
	const s = max === 0 ? 0 : d / max;
	return { h, s, v: max };
}

function channelToHex(n: number): string {
	return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
}

export function rgbToHex(rgb: Rgb): string {
	return `#${channelToHex(rgb.r)}${channelToHex(rgb.g)}${channelToHex(rgb.b)}`;
}

/**
 * Parse a hex color string (#RGB, #RRGGBB, with or without #).
 * Returns null if invalid.
 */
export function parseHex(input: string): Rgb | null {
	const raw = input.trim().replace(/^#/, "");
	if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) return null;
	const full =
		raw.length === 3
			? raw
					.split("")
					.map((c) => c + c)
					.join("")
			: raw;
	const n = parseInt(full, 16);
	if (!Number.isFinite(n)) return null;
	return {
		r: (n >> 16) & 0xff,
		g: (n >> 8) & 0xff,
		b: n & 0xff,
	};
}

/** Snap an arbitrary hex color to the nearest palette index. */
export function hexToNearestIndex(input: string): number | null {
	const rgb = parseHex(input);
	if (!rgb) return null;
	const { h, s, v } = rgbToHsv(rgb.r, rgb.g, rgb.b);
	return hsvToNearestIndex(h, s, v);
}

/** CSS hex for a template color index. */
export function getTemplateColor(index: number): string {
	const { h, s, v } = indexToHsv(index);
	return rgbToHex(hsvToRgb(h, s, v));
}

/** Full 256-entry palette (for swatches if needed). */
export function buildTemplateColorPalette(): string[] {
	const out: string[] = [];
	for (let i = 0; i <= TEMPLATE_COLOR_MAX; i++) out.push(getTemplateColor(i));
	return out;
}
