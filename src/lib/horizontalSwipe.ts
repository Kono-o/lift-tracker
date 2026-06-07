export type HorizontalSwipeOptions = {
	onSwipeLeft: () => void;
	onSwipeRight: () => void;
	minDistance?: number;
	maxVerticalRatio?: number;
	disabled?: () => boolean;
};

export function horizontalSwipe(node: HTMLElement, options: HorizontalSwipeOptions) {
	let opts = options;
	let startX = 0;
	let startY = 0;
	let tracking = false;
	let activePointerId: number | null = null;
	let suppressClick = false;

	function minDistance() {
		return opts.minDistance ?? 48;
	}

	function maxVerticalRatio() {
		return opts.maxVerticalRatio ?? 1.25;
	}

	function onPointerDown(e: PointerEvent) {
		if (opts.disabled?.() || e.button !== 0) return;
		startX = e.clientX;
		startY = e.clientY;
		tracking = true;
		activePointerId = e.pointerId;
	}

	function onPointerUp(e: PointerEvent) {
		if (!tracking || activePointerId !== e.pointerId) return;
		tracking = false;
		activePointerId = null;

		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		if (Math.abs(dx) < minDistance()) return;
		if (Math.abs(dy) > Math.abs(dx) * maxVerticalRatio()) return;

		suppressClick = true;
		if (dx < 0) opts.onSwipeLeft();
		else opts.onSwipeRight();
	}

	function onPointerCancel(e: PointerEvent) {
		if (activePointerId !== e.pointerId) return;
		tracking = false;
		activePointerId = null;
	}

	function onClickCapture(e: MouseEvent) {
		if (!suppressClick) return;
		suppressClick = false;
		e.preventDefault();
		e.stopImmediatePropagation();
	}

	node.addEventListener('pointerdown', onPointerDown);
	node.addEventListener('pointerup', onPointerUp);
	node.addEventListener('pointercancel', onPointerCancel);
	node.addEventListener('click', onClickCapture, true);

	return {
		update(newOpts: HorizontalSwipeOptions) {
			opts = newOpts;
		},
		destroy() {
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('pointerup', onPointerUp);
			node.removeEventListener('pointercancel', onPointerCancel);
			node.removeEventListener('click', onClickCapture, true);
		},
	};
}