/** Minimal typed listener bag — enough for the scale client, no dependency. */

export type Emitter<Events extends Record<string, unknown>> = {
	on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void;
	emit<K extends keyof Events>(event: K, payload: Events[K]): void;
	clear(): void;
};

export function createEmitter<Events extends Record<string, unknown>>(): Emitter<Events> {
	const listeners = new Map<keyof Events, Set<(payload: never) => void>>();

	return {
		on(event, fn) {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(fn as (payload: never) => void);
			return () => {
				set!.delete(fn as (payload: never) => void);
			};
		},
		emit(event, payload) {
			const set = listeners.get(event);
			if (!set) return;
			// Copy first: a handler that unsubscribes must not skip the next listener.
			for (const fn of [...set]) (fn as (value: Events[typeof event]) => void)(payload);
		},
		clear() {
			listeners.clear();
		},
	};
}
