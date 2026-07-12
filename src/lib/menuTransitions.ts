/** Shared subtle open/close animations for app menus, lists, and view shells. */

import { cubicInOut, cubicOut } from "svelte/easing";
import type { TransitionConfig } from "svelte/transition";

export const MENU_IN_MS = 200;
export const MENU_OUT_MS = 150;
export const OVERLAY_MS = 200;
export const POPOVER_MS = 160;
export const LIST_ITEM_MS = 180;
export const USER_MENU_MS = 340;

function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

function resolveDuration(ms: number): number {
	return prefersReducedMotion() ? 0 : ms;
}

/** Main body view swap (stats, template editor, routines, track, …). */
export function menuViewIn(_node: Element, params?: { duration?: number }): TransitionConfig {
	const duration = resolveDuration(params?.duration ?? MENU_IN_MS);
	return {
		duration,
		easing: cubicOut,
		css: (t) => {
			const y = (1 - t) * 8;
			const s = 0.985 + 0.015 * t;
			return `opacity:${t};transform:translate3d(0,${y}px,0) scale(${s});`;
		},
	};
}

export function menuViewOut(_node: Element, params?: { duration?: number }): TransitionConfig {
	const duration = resolveDuration(params?.duration ?? MENU_OUT_MS);
	return {
		duration,
		easing: cubicInOut,
		css: (t) => {
			const y = (1 - t) * -6;
			const s = 0.99 + 0.01 * t;
			return `opacity:${t};transform:translate3d(0,${y}px,0) scale(${s});`;
		},
	};
}

/**
 * Account / user menu — stronger “hero” entrance:
 * blur + depth tilt + scale (needs perspective on overlay).
 */
export function userMenuIn(_node: Element, params?: { duration?: number }): TransitionConfig {
	const duration = resolveDuration(params?.duration ?? USER_MENU_MS);
	return {
		duration,
		easing: cubicOut,
		css: (t) => {
			const e = 1 - Math.pow(1 - t, 3);
			const y = (1 - e) * 36;
			const s = 0.86 + 0.14 * e;
			const rot = (1 - e) * 12;
			const blur = (1 - e) * 14;
			return (
				`opacity:${e};` +
				`transform:translate3d(0,${y}px,0) scale(${s}) rotateX(${rot}deg);` +
				`filter:blur(${blur}px);` +
				`transform-origin:50% 0%;`
			);
		},
	};
}

export function userMenuOut(_node: Element, params?: { duration?: number }): TransitionConfig {
	const duration = resolveDuration(params?.duration ?? 220);
	return {
		duration,
		easing: cubicInOut,
		css: (t) => {
			const y = (1 - t) * 20;
			const s = 0.92 + 0.08 * t;
			const rot = (1 - t) * -6;
			const blur = (1 - t) * 8;
			return (
				`opacity:${t};` +
				`transform:translate3d(0,${y}px,0) scale(${s}) rotateX(${rot}deg);` +
				`filter:blur(${blur}px);` +
				`transform-origin:50% 0%;`
			);
		},
	};
}

/** Overlay backdrop for user menu (slightly slower + dim). */
export function userMenuOverlayIn(
	_node: Element,
	params?: { duration?: number },
): TransitionConfig {
	const duration = resolveDuration(params?.duration ?? OVERLAY_MS + 40);
	return {
		duration,
		easing: cubicOut,
		css: (t) => `opacity:${t};backdrop-filter:blur(${t * 14}px);-webkit-backdrop-filter:blur(${t * 14}px);`,
	};
}

export function userMenuOverlayOut(
	_node: Element,
	params?: { duration?: number },
): TransitionConfig {
	const duration = resolveDuration(params?.duration ?? 180);
	return {
		duration,
		easing: cubicInOut,
		css: (t) => `opacity:${t};backdrop-filter:blur(${t * 14}px);-webkit-backdrop-filter:blur(${t * 14}px);`,
	};
}

/** Generic centered modals (update / changelog). */
export function menuPanelIn(_node: Element, params?: { duration?: number }): TransitionConfig {
	const duration = resolveDuration(params?.duration ?? MENU_IN_MS);
	return {
		duration,
		easing: cubicOut,
		css: (t) => {
			const y = (1 - t) * 12;
			const s = 0.96 + 0.04 * t;
			return `opacity:${t};transform:translate3d(0,${y}px,0) scale(${s});`;
		},
	};
}

export function menuPanelOut(_node: Element, params?: { duration?: number }): TransitionConfig {
	const duration = resolveDuration(params?.duration ?? MENU_OUT_MS);
	return {
		duration,
		easing: cubicInOut,
		css: (t) => {
			const y = (1 - t) * 8;
			const s = 0.97 + 0.03 * t;
			return `opacity:${t};transform:translate3d(0,${y}px,0) scale(${s});`;
		},
	};
}

/** Anchored popovers (color/icon pickers). */
export function menuPopoverIn(_node: Element, params?: { duration?: number }): TransitionConfig {
	const duration = resolveDuration(params?.duration ?? POPOVER_MS);
	return {
		duration,
		easing: cubicOut,
		css: (t) => {
			const y = (1 - t) * 6;
			const s = 0.97 + 0.03 * t;
			return `opacity:${t};transform:translate3d(0,${y}px,0) scale(${s});transform-origin:top right;`;
		},
	};
}

export function menuPopoverOut(_node: Element, params?: { duration?: number }): TransitionConfig {
	const duration = resolveDuration(params?.duration ?? 120);
	return {
		duration,
		easing: cubicInOut,
		css: (t) => {
			const y = (1 - t) * 4;
			const s = 0.98 + 0.02 * t;
			return `opacity:${t};transform:translate3d(0,${y}px,0) scale(${s});transform-origin:top right;`;
		},
	};
}

/**
 * List row enter: expand height + slide in from left + fade.
 * Put this on an outer shell; keep drag transforms on an inner node.
 */
export function listItemSlideIn(
	node: Element,
	params?: { duration?: number; x?: number },
): TransitionConfig {
	const duration = resolveDuration(params?.duration ?? 220);
	const fromX = params?.x ?? -28;
	const el = node as HTMLElement;
	// Prefer full content height (inner row is usually h-8 = 32)
	const height = Math.max(el.scrollHeight || 0, el.offsetHeight || 0, 32);
	return {
		duration,
		easing: cubicOut,
		css: (t) => {
			const slide = (1 - t) * fromX;
			return (
				`overflow:hidden;` +
				`opacity:${t};` +
				`height:${Math.max(0, t * height)}px;` +
				`min-height:0;` +
				`transform:translate3d(${slide}px,0,0);`
			);
		},
	};
}

/**
 * List row leave: slide out to the right + fade + collapse height
 * so the list box shrinks with the row.
 */
export function listItemSlideOut(
	node: Element,
	params?: { duration?: number; x?: number },
): TransitionConfig {
	const duration = resolveDuration(params?.duration ?? 240);
	const toX = params?.x ?? 48;
	const el = node as HTMLElement;
	const height = Math.max(el.scrollHeight || 0, el.offsetHeight || 0, 32);
	return {
		duration,
		easing: cubicInOut,
		css: (t) => {
			// out: t goes 1 → 0
			const slide = (1 - t) * toX;
			return (
				`overflow:hidden;` +
				`opacity:${t};` +
				`height:${Math.max(0, t * height)}px;` +
				`min-height:0;` +
				`transform:translate3d(${slide}px,0,0);` +
				`pointer-events:none;`
			);
		},
	};
}

/** @deprecated use listItemSlideIn */
export const listItemIn = listItemSlideIn;
/** @deprecated use listItemSlideOut */
export const listItemOut = listItemSlideOut;

