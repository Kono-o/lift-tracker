/** Mount a node under `document.body` so `position: fixed` is viewport-relative. */

export function portal(node: HTMLElement) {
	if (typeof document === "undefined") return {};
	const parent = node.parentElement;
	document.body.appendChild(node);
	return {
		destroy() {
			if (node.parentNode === document.body) {
				document.body.removeChild(node);
			} else if (parent && node.parentNode == null) {
				// already detached
			}
		},
	};
}
