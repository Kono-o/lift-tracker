/** Connects a BLE transport to the verified weight-frame state machine. */

import { createEmitter } from "./emitter";
import { ScaleSession, type ScaleReading, type ScaleSessionEvent } from "./session";
import type { ScaleConnection, ScaleTransport } from "./transport";

export const NO_STABLE_WEIGHT_TIMEOUT_MS = 60_000;

export type ScaleClientState =
	| "idle"
	| "choosing"
	| "connected"
	| "weighing"
	| "complete"
	| "error";

export type ScaleEvents = {
	state: ScaleClientState;
	device: string | null;
	battery: number | null;
	live: { weightKg: number; heartRate: null; locked: boolean };
	locked: { weightKg: number };
	complete: ScaleReading;
	error: Error;
};

const USER_CANCELLED = /cancel|user declined|not selected|no device chosen|abort/i;

export class BodyScaleClient {
	#emitter = createEmitter<ScaleEvents>();
	#transport: ScaleTransport;
	#connection: ScaleConnection | null = null;
	#session = new ScaleSession();
	#timeoutTimer: ReturnType<typeof setTimeout> | null = null;
	#state: ScaleClientState = "idle";
	#disposed = false;
	#attempt = 0;
	#timeoutMs: number;

	constructor(transport: ScaleTransport, options: { timeoutMs?: number } = {}) {
		this.#transport = transport;
		this.#timeoutMs = options.timeoutMs ?? NO_STABLE_WEIGHT_TIMEOUT_MS;
	}

	get state(): ScaleClientState {
		return this.#state;
	}

	get transportKind(): ScaleTransport["kind"] {
		return this.#transport.kind;
	}

	on<K extends keyof ScaleEvents>(event: K, fn: (payload: ScaleEvents[K]) => void): () => void {
		return this.#emitter.on(event, fn);
	}

	supported(): boolean {
		return this.#transport.isSupported();
	}

	unsupportedReason(): string | null {
		return this.#transport.unsupportedReason();
	}

	/** Must run inside a click handler because Web Bluetooth requires user activation. */
	async start(): Promise<void> {
		if (this.#disposed || this.#state === "choosing" || this.#connection) return;
		this.#reset();
		const attempt = ++this.#attempt;
		let ready = false;
		let disconnectedBeforeReady = false;
		const pendingFrames: Array<Uint8Array | DataView> = [];
		this.#setState("choosing");

		try {
			const connection = await this.#transport.connect({
				onFrame: (bytes) => {
					if (this.#disposed || attempt !== this.#attempt) return;
					if (!ready) pendingFrames.push(bytes);
					else if (this.#state !== "idle" && this.#state !== "error" && this.#state !== "complete") {
						this.#handleFrame(bytes);
					}
				},
				onDisconnected: () => {
					if (this.#disposed || attempt !== this.#attempt) return;
					if (!ready) disconnectedBeforeReady = true;
					else this.#handleDisconnected();
				},
			});

			// The user may close/cancel while the native or browser picker is open.
			if (this.#disposed || attempt !== this.#attempt) {
				await connection.disconnect().catch(() => {});
				return;
			}

			this.#connection = connection;
			this.#emitter.emit("device", connection.label);
			this.#setState("connected");
			ready = true;
			this.#timeoutTimer = setTimeout(() => this.#failNoStableWeight(), this.#timeoutMs);

			// Some BLE stacks can deliver a notification before connect() resolves.
			// Buffer those frames until the connection is owned so completion can also
			// disconnect it and leave the UI in the correct state.
			for (const frame of pendingFrames) {
				if (attempt !== this.#attempt || this.#disposed) break;
				this.#handleFrame(frame);
			}
			pendingFrames.length = 0;
			if (disconnectedBeforeReady && attempt === this.#attempt) this.#handleDisconnected();

			// Battery is optional and must never delay weight capture.
			if (this.#connection && attempt === this.#attempt) {
				void connection
					.readBattery()
					.then((level) => {
						if (level != null && attempt === this.#attempt && !this.#disposed) {
							this.#emitter.emit("battery", level);
						}
					})
					.catch(() => {});
			}
		} catch (err) {
			if (this.#disposed || attempt !== this.#attempt) return;
			const message = err instanceof Error ? err.message : String(err);
			this.#teardown();
			if (USER_CANCELLED.test(message)) {
				this.#setState("idle");
				return;
			}
			this.#setState("error");
			this.#emitter.emit("error", err instanceof Error ? err : new Error(message));
			throw err;
		}
	}

	/** Cancel pairing or stop an active scan; incomplete weights are never saved. */
	stop(): void {
		this.#attempt += 1;
		this.#teardown();
		this.#setState("idle");
	}

	dispose(): void {
		this.#disposed = true;
		this.#attempt += 1;
		this.#teardown();
		this.#emitter.clear();
	}

	#handleFrame(bytes: Uint8Array | DataView): void {
		const events = this.#session.handle(bytes);
		if (!events.length) return;
		if (this.#state === "connected") this.#setState("weighing");
		this.#emitEvents(events);
		if (this.#session.completed) this.#finishSession();
	}

	#handleDisconnected(): void {
		if (this.#state === "complete" || this.#state === "idle" || this.#state === "error") return;
		this.#teardown();
		this.#setState("error");
		this.#emitter.emit("error", new Error("Scale disconnected before a stable weight was captured."));
	}

	#failNoStableWeight(): void {
		if (this.#state === "complete" || this.#state === "idle" || this.#state === "error") return;
		this.#teardown();
		this.#setState("error");
		this.#emitter.emit("error", new Error("No stable weight was received. Step onto the scale, hold still, and try again."));
	}

	#finishSession(): void {
		if (this.#timeoutTimer != null) clearTimeout(this.#timeoutTimer);
		this.#timeoutTimer = null;
		this.#teardown();
		this.#setState("complete");
	}

	#emitEvents(events: ScaleSessionEvent[]): void {
		for (const event of events) {
			if (event.kind === "complete") this.#emitter.emit("complete", event.reading);
			else if (event.kind === "locked") this.#emitter.emit("locked", { weightKg: event.weightKg });
			else this.#emitter.emit("live", {
				weightKg: event.weightKg,
				heartRate: null,
				locked: event.locked,
			});
		}
	}

	#setState(next: ScaleClientState): void {
		if (this.#state === next) return;
		this.#state = next;
		this.#emitter.emit("state", next);
	}

	#teardown(): void {
		if (this.#timeoutTimer != null) clearTimeout(this.#timeoutTimer);
		this.#timeoutTimer = null;
		const connection = this.#connection;
		this.#connection = null;
		if (connection) void connection.disconnect().catch(() => {});
	}

	#reset(): void {
		this.#teardown();
		this.#session = new ScaleSession();
	}
}
