/**
 * Long-press-to-reorder for list rows on touch devices.
 *
 * Desktop keeps HTML5 drag-and-drop; phones never synthesize dragstart from a
 * finger, so this action adds the touch equivalent: press and hold a row
 * (~220 ms), then drag — the row's siblings shift apart exactly like the mouse
 * interaction (parents reuse their existing dragged/drag-over index states),
 * and releasing commits through the same reorder path as `drop`.
 *
 * Scroll stays intact: the gesture only hijacks movement after the hold
 * engages; any movement before that is treated as a scroll/swipe and ignored.
 * Once engaged, holding near the top/bottom edge auto-scrolls the surrounding
 * panel so long lists can be reordered past the visible viewport.
 */

import { hapticMedium } from '$lib/haptics';

export type TouchReorderParams = {
	/** Index of THIS row within the reorderable set. */
	index: number;
	/** Element containing all reorderable rows (scanned for drop position). */
	container: () => HTMLElement | null | undefined;
	/** Current reorderable row count (bounds-checks the drop index). */
	rowCount: () => number;
	/** Extra guard (busy states, read-only rows, pending temp rows…). */
	disabled?: () => boolean;
	/** Optional filter to restrict which rendered rows are reorder targets. */
	filterRow?: (el: HTMLElement) => boolean;
	/** Hold duration before the drag engages. Default 220ms. */
	holdMs?: number;
	onStart: (index: number) => void;
	onOver: (targetIndex: number) => void;
	onDrop: (fromIndex: number, targetIndex: number) => void;
	onCancel: () => void;
};

/** Elements that must never trigger row-drag (buttons living inside rows). */
const INTERACTIVE = 'button, input, textarea, select, a, label, [data-no-drag]';
const SCROLL_EDGE_PX = 56;
const SCROLL_MAX_STEP = 18;

export function touchReorder(node: HTMLElement, params: TouchReorderParams) {
	let opts = params;

	let startX = 0;
	let startY = 0;
	let lastY = 0;
	let activeTouchId: number | null = null;
	let holdTimer: ReturnType<typeof setTimeout> | null = null;
	let engaged = false;
	// Set when the gesture ends so the synthetic click doesn't activate the row.
	let suppressClick = false;
	let scrollParent: HTMLElement | null = null;
	let scrollFrame = 0;

	function holdMs() {
		return opts.holdMs ?? 220;
	}

	function clearHoldTimer() {
		if (holdTimer !== null) {
			clearTimeout(holdTimer);
			holdTimer = null;
		}
	}

	function stopAutoScroll() {
		if (scrollFrame) cancelAnimationFrame(scrollFrame);
		scrollFrame = 0;
	}

	/** Nearest ancestor that can actually scroll vertically. */
	function findScrollParent(): HTMLElement | null {
		let el: HTMLElement | null = opts.container() ?? null;
		while (el) {
			const style = getComputedStyle(el);
			if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) {
				return el;
			}
			el = el.parentElement;
		}
		return null;
	}

	function notifyOver() {
		const body = opts.container();
		const count = opts.rowCount();
		if (!body || count <= 0) return;
		opts.onOver(rowIndexAtY(body, count, lastY));
	}

	function autoScrollTick() {
		scrollFrame = 0;
		if (!engaged || !scrollParent) return;
		const rect = scrollParent.getBoundingClientRect();
		const edge = Math.min(SCROLL_EDGE_PX, rect.height * 0.22);
		let delta = 0;
		if (lastY < rect.top + edge) {
			delta = -Math.min(SCROLL_MAX_STEP, Math.ceil((rect.top + edge - lastY) / 4));
		} else if (lastY > rect.bottom - edge) {
			delta = Math.min(SCROLL_MAX_STEP, Math.ceil((lastY - (rect.bottom - edge)) / 4));
		}
		if (delta !== 0) {
			const before = scrollParent.scrollTop;
			scrollParent.scrollTop = before + delta;
			if (scrollParent.scrollTop !== before) notifyOver();
		}
		if (lastY < rect.top + edge || lastY > rect.bottom - edge) {
			scrollFrame = requestAnimationFrame(autoScrollTick);
		}
	}

	function disengage(callCancel: boolean) {
		const wasEngaged = engaged;
		engaged = false;
		activeTouchId = null;
		clearHoldTimer();
		stopAutoScroll();
		node.classList.remove('touch-reorder--engaged');
		node.removeAttribute('data-touch-reorder-active');
		if (wasEngaged && callCancel) opts.onCancel();
	}

	function onTouchStart(e: TouchEvent) {
		if (e.touches.length !== 1) return;
		if (opts.disabled?.()) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest?.(INTERACTIVE)) return;

		const touch = e.changedTouches[0];
		startX = touch.clientX;
		startY = touch.clientY;
		lastY = touch.clientY;
		activeTouchId = touch.identifier;

		clearHoldTimer();
		holdTimer = setTimeout(() => {
			holdTimer = null;
			if (activeTouchId === null) return;
			engaged = true;
			suppressClick = true;
			scrollParent = findScrollParent();
			node.classList.add('touch-reorder--engaged');
			// Lets row dragstart handlers ignore the native drag Android may start
			// from the same long press after this gesture has already engaged.
			node.setAttribute('data-touch-reorder-active', 'true');
			void hapticMedium();
			opts.onStart(opts.index);
		}, holdMs());
	}

	function onTouchMove(e: TouchEvent) {
		if (activeTouchId === null) return;
		const touch = findTouch(e.changedTouches);
		if (!touch) return;
		lastY = touch.clientY;

		if (!engaged) {
			const dx = touch.clientX - startX;
			const dy = touch.clientY - startY;
			// Moved before the hold fired — this is a scroll/swipe, stand down.
			if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
				disengage(false);
			}
			return;
		}

		e.preventDefault();

		notifyOver();
		if (!scrollFrame && scrollParent) scrollFrame = requestAnimationFrame(autoScrollTick);
	}

	function onTouchEnd(e: TouchEvent) {
		if (activeTouchId === null || !findTouch(e.changedTouches)) return;
		const wasEngaged = engaged;
		const from = opts.index;
		const last = e.changedTouches[e.changedTouches.length - 1];
		lastY = last.clientY;
		disengage(false);
		if (wasEngaged) {
			const body = opts.container();
			const count = opts.rowCount();
			const target = body && count > 0 ? rowIndexAtY(body, count, lastY) : 0;
			opts.onDrop(from, target);
			// Release always ends the gesture: without this the parent keeps a stale
			// dragged index and the dropped row stays ghosted/offset until the next drag.
			opts.onCancel();
		}
	}

	function onTouchCancel(e: TouchEvent) {
		if (activeTouchId === null || !findTouch(e.changedTouches)) return;
		disengage(true);
	}

	function findTouch(list: TouchList): Touch | null {
		for (let i = 0; i < list.length; i++) {
			if (list[i].identifier === activeTouchId) return list[i];
		}
		return null;
	}

	/** Midpoint scan over rendered row shells — mirrors computeRowIndex(). */
	function rowIndexAtY(container: HTMLElement, count: number, y: number): number {
		const maxIndex = Math.max(0, count - 1);
		const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-list-row]'))
			.filter((el) => opts.filterRow?.(el) ?? true)
			.filter((el) => el.getClientRects().length > 0);
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i].getBoundingClientRect();
			if (y < r.top + r.height / 2) return Math.min(maxIndex, Math.max(0, i));
		}
		return maxIndex;
	}

	function onClickCapture(e: MouseEvent) {
		if (!suppressClick) return;
		suppressClick = false;
		e.preventDefault();
		e.stopImmediatePropagation();
	}

	function onContextMenu(e: MouseEvent) {
		if (engaged) {
			e.preventDefault();
			disengage(true);
		}
	}

	node.addEventListener('touchstart', onTouchStart, { passive: true });
	// Non-passive so preventDefault() can stop scrolling mid-gesture once engaged.
	node.addEventListener('touchmove', onTouchMove, { passive: false });
	node.addEventListener('touchend', onTouchEnd);
	node.addEventListener('touchcancel', onTouchCancel);
	node.addEventListener('click', onClickCapture, true);
	node.addEventListener('contextmenu', onContextMenu);

	return {
		update(next: TouchReorderParams) {
			opts = next;
		},
		destroy() {
			disengage(false);
			node.removeEventListener('touchstart', onTouchStart);
			node.removeEventListener('touchmove', onTouchMove);
			node.removeEventListener('touchend', onTouchEnd);
			node.removeEventListener('touchcancel', onTouchCancel);
			node.removeEventListener('click', onClickCapture, true);
			node.removeEventListener('contextmenu', onContextMenu);
		},
	};
}
