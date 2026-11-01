/**
 * Orchestrates one weigh-in: asks a transport for the scale, feeds notifications
 * through the pure state machine, and owns every clock that the machine refuses to
 * know about.
 *
 * The contract the UI relies on is that a session always ends. Connected scales
 * power themselves off after the body read, users step off early, Bluetooth drops,
 * and some firmware keeps streaming long after the number is settled — each of
 * those has its own exit, and all of them produce a `complete` once a weight has
 * locked.
 */

import { createEmitter } from "./emitter";
import {
	FRAME_IDLE_MS,
	MEASURE_TIMEOUT_MS,
	ScaleSession,
	type CompleteReason,
	type ScaleReading,
	type ScaleSessionEvent,
} from "./session";
import type { ScaleConnection, ScaleTransport } from "./transport";

export type ScaleClientState =
	| "idle"
	| "choosing"
	| "connected"
	| "weighing"
	| "measuring"
	| "complete"
	| "error";

export type ScaleEvents = {
	state: ScaleClientState;
	device: string | null;
	battery: number | null;
	live: { weightKg: number; heartRate: number | null; locked: boolean };
	locked: { weightKg: number };
	measuring: { heartRate: number; hasImpedance: boolean; ticks: number };
	complete: ScaleReading;
	error: Error;
};

const WEB_USER_CANCELLED = /cancel|user declined|not selected|no device chosen|abort/i;

export class BodyScaleClient {
	#emitter = createEmitter<ScaleEvents>();
	#transport: ScaleTransport;
	#connection: ScaleConnection | null = null;
	#session = new ScaleSession();
	#timeoutTimer: ReturnType<typeof setTimeout> | null = null;
	#idleTimer: ReturnType<typeof setInterval> | null = null;
	#lastFrameAt = 0;
	#armed = false;
	#state: ScaleClientState = "idle";
	#disposed = false;

	constructor(transport: ScaleTransport) {
		this.#transport = transport;
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

	/** Needs to run inside a click handler — see ScaleTransport.connect(). */
	async start(): Promise<void> {
		if (this.#connection) return;
		this.#reset();
		this.#setState("choosing");
		try {
			this.#connection = await this.#transport.connect({
				onFrame: (bytes) => this.#handleFrame(bytes),
				onDisconnected: () => this.#handleDisconnected(),
			});
			if (this.#disposed) {
				await this.#connection.disconnect().catch(() => {});
				return;
			}
			this.#emitter.emit("device", this.#connection.label);
			this.#setState("connected");
			// Battery is a bonus: a unit without the standard service must not fail a weigh-in.
			void this.#connection
				.readBattery()
				.then((level) => level != null && this.#emitter.emit("battery", level))
				.catch(() => {});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.#teardown();
			// Closing the OS picker is not a fault — go quiet instead of alarming.
			if (WEB_USER_CANCELLED.test(message)) {
				this.#setState("idle");
				return;
			}
			this.#setState("error");
			this.#emitter.emit("error", err instanceof Error ? err : new Error(message));
			throw err;
		}
	}

	/** Finish now with whatever has been captured (user tapped Done, or leaving). */
	stop(reason: CompleteReason = "manual"): void {
		this.#emitEvents(this.#session.finalize(reason));
		this.#teardown();
		this.#setState("idle");
	}

	dispose(): void {
		this.#disposed = true;
		this.#teardown();
		this.#emitter.clear();
	}

	#handleFrame(bytes: Uint8Array | DataView): void {
		this.#lastFrameAt = Date.now();
		const events = this.#session.handle(bytes);
		if (!events.length) return;

		if (!this.#armed && this.#session.weightLocked) this.#armClocks();
		if (this.#state === "connected") this.#setState("weighing");

		this.#emitEvents(events);

		if (this.#session.completed) this.#finishSession();
		else if (this.#session.weightLocked && this.#state === "weighing") this.#setState("measuring");
	}

	#handleDisconnected(): void {
		// Power-off is the normal end of a weigh-in on this hardware.
		this.#emitEvents(this.#session.finalize("disconnect"));
		if (this.#session.completed) {
			if (this.#state !== "complete") this.#finishSession();
			return;
		}
		this.#teardown();
		this.#setState("error");
		this.#emitter.emit("error", new Error("Scale disconnected before a weight was captured"));
	}

	/**
	 * Armed on the first non-zero weight, not on connect: the clock should measure
	 * the reading, not the time the scale spent waiting for somebody to step on.
	 */
	#armClocks(): void {
		if (this.#armed) return;
		this.#armed = true;
		this.#lastFrameAt = Date.now();
		this.#timeoutTimer = setTimeout(() => this.#finishOnClock("timeout"), MEASURE_TIMEOUT_MS);
		this.#idleTimer = setInterval(() => {
			if (Date.now() - this.#lastFrameAt >= FRAME_IDLE_MS) this.#finishOnClock("idle");
		}, 1_000);
	}

	#finishOnClock(reason: CompleteReason): void {
		this.#emitEvents(this.#session.finalize(reason));
		if (this.#session.completed) this.#finishSession();
		else this.#clearClocks();
	}

	#finishSession(): void {
		this.#clearClocks();
		this.#teardown();
		this.#setState("complete");
	}

	#emitEvents(events: ScaleSessionEvent[]): void {
		for (const event of events) {
			if (event.kind === "complete") this.#emitter.emit("complete", event.reading);
			else if (event.kind === "locked") this.#emitter.emit("locked", { weightKg: event.weightKg });
			else if (event.kind === "measuring") this.#emitter.emit("measuring", event);
			else this.#emitter.emit("live", {
				weightKg: event.weightKg,
				heartRate: event.heartRate,
				locked: event.locked,
			});
		}
		if (events.some((e) => e.kind === "complete")) this.#clearClocks();
	}

	#setState(next: ScaleClientState): void {
		if (this.#state === next) return;
		this.#state = next;
		this.#emitter.emit("state", next);
	}

	#clearClocks(): void {
		if (this.#timeoutTimer != null) clearTimeout(this.#timeoutTimer);
		if (this.#idleTimer != null) clearInterval(this.#idleTimer);
		this.#timeoutTimer = null;
		this.#idleTimer = null;
	}

	#teardown(): void {
		this.#clearClocks();
		const connection = this.#connection;
		this.#connection = null;
		if (!connection) return;
		void connection.disconnect().catch(() => {});
	}

	#reset(): void {
		this.#clearClocks();
		this.#session = new ScaleSession();
		this.#armed = false;
		this.#lastFrameAt = 0;
	}
}
