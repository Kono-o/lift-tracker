/**
 * Shared viewport-aware placement for small anchored panels.
 * Aligns the panel's trailing edge to its trigger, flips above when needed,
 * and keeps the surface inside the safe viewport gutter while scrolling.
 */
export type AnchoredPopoverOptions = {
	anchor: HTMLElement | null;
	fallbackWidth: number;
};

function cssPixels(name: string, fallback: number): number {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	const amount = Number.parseFloat(value);
	if (!Number.isFinite(amount)) return fallback;
	if (value.endsWith('rem')) {
		const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
		return amount * (Number.isFinite(rootFontSize) ? rootFontSize : 16);
	}
	return amount;
}

export function anchoredPopover(node: HTMLElement, options: AnchoredPopoverOptions) {
	let anchor = options.anchor;
	let fallbackWidth = options.fallbackWidth;
	let frame = 0;

	const place = () => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => {
			if (!anchor?.isConnected) {
				node.style.visibility = 'hidden';
				return;
			}

			const gutter = cssPixels('--popover-edge', 8);
			const gap = cssPixels('--popover-anchor-gap', 6);
			const bounds = anchor.getBoundingClientRect();
			const width = node.offsetWidth || fallbackWidth;
			const height = node.offsetHeight;
			const maxLeft = Math.max(gutter, window.innerWidth - width - gutter);
			const left = Math.min(maxLeft, Math.max(gutter, bounds.right - width));
			const below = bounds.bottom + gap;
			const above = bounds.top - height - gap;
			const fitsBelow = below + height <= window.innerHeight - gutter;
			const top = fitsBelow || above < gutter
				? Math.min(Math.max(gutter, below), Math.max(gutter, window.innerHeight - height - gutter))
				: Math.max(gutter, above);

			node.style.left = `${Math.round(left)}px`;
			node.style.top = `${Math.round(top)}px`;
			node.style.visibility = 'visible';
		});
	};

	window.addEventListener('resize', place);
	window.addEventListener('scroll', place, true);
	const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
	resizeObserver?.observe(node);
	if (anchor) resizeObserver?.observe(anchor);
	place();

	return {
		update(next: AnchoredPopoverOptions) {
			if (anchor && anchor !== next.anchor) resizeObserver?.unobserve(anchor);
			anchor = next.anchor;
			fallbackWidth = next.fallbackWidth;
			if (anchor) resizeObserver?.observe(anchor);
			place();
		},
		destroy() {
			cancelAnimationFrame(frame);
			window.removeEventListener('resize', place);
			window.removeEventListener('scroll', place, true);
			resizeObserver?.disconnect();
		},
	};
}
