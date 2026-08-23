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
 */

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

export function touchReorder(node: HTMLElement, params: TouchReorderParams) {
	let opts = params;

	let startX = 0;
	let startY = 0;
	let activeTouchId: number | null = null;
	let holdTimer: ReturnType<typeof setTimeout> | null = null;
	let engaged = false;
	// Set when the gesture ends so the synthetic click doesn't activate the row.
	let suppressClick = false;

	function holdMs() {
		return opts.holdMs ?? 220;
	}

	function clearHoldTimer() {
		if (holdTimer !== null) {
			clearTimeout(holdTimer);
			holdTimer = null;
		}
	}

	function disengage(callCancel: boolean) {
		const wasEngaged = engaged;
		engaged = false;
		activeTouchId = null;
		clearHoldTimer();
		node.classList.remove('touch-reorder--engaged');
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
		activeTouchId = touch.identifier;

		clearHoldTimer();
		holdTimer = setTimeout(() => {
			holdTimer = null;
			if (activeTouchId === null) return;
			engaged = true;
			suppressClick = true;
			node.classList.add('touch-reorder--engaged');
			opts.onStart(opts.index);
		}, holdMs());
	}

	function onTouchMove(e: TouchEvent) {
		if (activeTouchId === null) return;
		const touch = findTouch(e.changedTouches);
		if (!touch) return;

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

		const body = opts.container();
		const count = opts.rowCount();
		if (!body || count <= 0) return;
		const idx = rowIndexAtY(body, count, touch.clientY);
		opts.onOver(idx);
	}

	function onTouchEnd(e: TouchEvent) {
		if (activeTouchId === null || !findTouch(e.changedTouches)) return;
		const wasEngaged = engaged;
		const from = opts.index;
		disengage(false);
		if (wasEngaged) {
			const body = opts.container();
			const count = opts.rowCount();
			const last = e.changedTouches[e.changedTouches.length - 1];
			const target = body && count > 0 ? rowIndexAtY(body, count, last.clientY) : 0;
			opts.onDrop(from, target);
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
		const rows = Array.from(
			container.querySelectorAll<HTMLElement>('[data-list-row]'),
		).filter((el) => opts.filterRow?.(el) ?? true);
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
