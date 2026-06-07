import type { Action } from "svelte/action";

const DEFAULT_FADE_PX = 20;

function buildMask(atTop: boolean, atBottom: boolean, fadePx: number): string {
	if (!atTop && !atBottom) return "";
	const stops: string[] = [];
	if (atTop) {
		stops.push("transparent 0", `black ${fadePx}px`);
	} else {
		stops.push("black 0");
	}
	if (atBottom) {
		stops.push(`black calc(100% - ${fadePx}px)`, "transparent 100%");
	} else {
		stops.push("black 100%");
	}
	return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

function clearMask(node: HTMLElement) {
	node.style.maskImage = "";
	node.style.webkitMaskImage = "";
}

/** Soft fade at scroll edges; fades hide when content is flush with that edge. */
export const scrollEdgeFade: Action<HTMLElement, { fadePx?: number } | undefined> = (
	node,
	params,
) => {
	let fadePx = params?.fadePx ?? DEFAULT_FADE_PX;
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

	function update() {
		if (reducedMotion.matches) {
			clearMask(node);
			return;
		}
		const { scrollTop, scrollHeight, clientHeight } = node;
		if (scrollHeight <= clientHeight + 1) {
			clearMask(node);
			return;
		}
		const atTop = scrollTop < 4;
		const atBottom = scrollTop + clientHeight >= scrollHeight - 4;
		const mask = buildMask(!atTop, !atBottom, fadePx);
		if (!mask) {
			clearMask(node);
			return;
		}
		node.style.maskImage = mask;
		node.style.webkitMaskImage = mask;
	}

	const onScroll = () => update();
	const onReducedMotion = () => update();

	node.addEventListener("scroll", onScroll, { passive: true });
	reducedMotion.addEventListener("change", onReducedMotion);

	const ro = new ResizeObserver(() => update());
	ro.observe(node);

	const mo = new MutationObserver(() => update());
	mo.observe(node, { childList: true, subtree: true });

	update();

	return {
		update(newParams) {
			fadePx = newParams?.fadePx ?? DEFAULT_FADE_PX;
			update();
		},
		destroy() {
			node.removeEventListener("scroll", onScroll);
			reducedMotion.removeEventListener("change", onReducedMotion);
			ro.disconnect();
			mo.disconnect();
			clearMask(node);
		},
	};
};