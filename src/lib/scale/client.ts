/**
 * Connects a BLE transport to the staged, stabilizing weigh-in state machine.
 *
 * The session is pure and has no clock, so this is where the waiting is decided:
 * how long to give the weight to settle, how long to hunt for a repeating pulse
 * after it does, and how long to wait on impedance before calling the reading
 * finished with what actually agreed. A half-measurement is still a weigh-in, so
 * every timeout path closes the session rather than erroring.
 *
 * It also owns the device board, because the list and the session cannot be
 * independent: starting a weigh-in has to stop the scan, and the row that was just
 * used has to be the top row next morning.
 */

import { createEmitter } from "./emitter";
import {
	lastScaleDeviceId,
	mergeDevices,
	rememberScaleDevice,
	SCAN_WINDOW_MS,
	type ScaleDevice,
} from "./discovery";
import {
	ScaleSession,
	type ScaleReading,
	type ScaleSessionEvent,
	type ScaleStage,
	type SettleMetric,
} from "./session";
import type { ScalePhase } from "./protocol";
import type { ScaleConnectHandlers, ScaleConnection, ScaleDeviceSeed, ScaleTransport } from "./transport";

/** Standing on a scale that never agrees is not a reading — say so and stop. */
export const NO_STABLE_WEIGHT_TIMEOUT_MS = 60_000;
/** Window for a repeating pulse once the weight has locked. */
export const HEART_RATE_WINDOW_MS = 6_000;
/** Window for impedance to agree after the heart-rate window closes. */
export const COMPOSITION_WINDOW_MS = 6_000;
/**
 * Frames after the weight lock that carry neither pulse nor impedance. A foot-only
 * unit streams nothing else, and making the user stand there to prove it is rude.
 */
export const NO_SIGNAL_FRAMES = 10;

export type ScaleClientState =
	| "idle"
	| "choosing"
	| "connected"
	| "weighing"
	| "complete"
	| "error";

export type ScaleLive = {
	weightKg: number;
	heartRate: number | null;
	impedanceOhms: number | null;
	phase: ScalePhase;
	locked: boolean;
};

export type ScaleSettle = { metric: SettleMetric; have: number; need: number; value: number | null };

export type ScaleEvents = {
	state: ScaleClientState;
	device: string | null;
	battery: number | null;
	stage: ScaleStage;
	live: ScaleLive;
	settle: ScaleSettle;
	locked: { weightKg: number };
	complete: ScaleReading;
	error: Error;
	devices: ScaleDevice[];
	scanning: boolean;
};

type TimerName = "weight" | "heart" | "composition";

const USER_CANCELLED = /cancel|user declined|not selected|no device chosen|abort/i;

/** Rows only really change when one of these changes, so a sighting does not re-render the list. */
const boardSignature = (devices: ScaleDevice[]): string =>
	devices
		.map((d) => `${d.id}:${d.name ?? ""}:${Number(d.bonded)}${Number(d.remembered)}${Number(d.lastUsed)}:${d.rssi == null ? "?" : Math.round(d.rssi / 5)}`)
		.join("|");

export class BodyScaleClient {
	#emitter = createEmitter<ScaleEvents>();
	#transport: ScaleTransport;
	#connection: ScaleConnection | null = null;
	#session = new ScaleSession();
	#timers: Record<TimerName, ReturnType<typeof setTimeout> | null> = {
		weight: null,
		heart: null,
		composition: null,
	};
	#state: ScaleClientState = "idle";
	#disposed = false;
	#attempt = 0;
	#quietFrames = 0;
	#limits: Record<TimerName, number>;
	#board: ScaleDevice[] = [];
	#boardSeen = "";
	#lastUsedId: string | null = null;
	#scanStop: (() => void) | null = null;
	#scanTimer: ReturnType<typeof setTimeout> | null = null;
	#scanToken = 0;
	#scanning = false;

	constructor(
		transport: ScaleTransport,
		options: { weightMs?: number; heartMs?: number; compositionMs?: number } = {},
	) {
		this.#transport = transport;
		this.#limits = {
			weight: options.weightMs ?? NO_STABLE_WEIGHT_TIMEOUT_MS,
			heart: options.heartMs ?? HEART_RATE_WINDOW_MS,
			composition: options.compositionMs ?? COMPOSITION_WINDOW_MS,
		};
		this.#lastUsedId = lastScaleDeviceId();
	}

	get state(): ScaleClientState {
		return this.#state;
	}

	get stage(): ScaleStage {
		return this.#session.stage;
	}

	get transportKind(): ScaleTransport["kind"] {
		return this.#transport.kind;
	}

	/** Every scale this platform has reported, in the order the user should read them. */
	get devices(): ScaleDevice[] {
		return this.#board;
	}

	get scanning(): boolean {
		return this.#scanning;
	}

	/** Whether a tap on a row can reach that device, or only the platform's own picker can. */
	canPickById(): boolean {
		return this.#transport.connectTo != null;
	}

	/** Whether there is anything to list before the picker is opened. */
	canDiscover(): boolean {
		return this.#transport.listDevices != null || this.#transport.startScan != null;
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

	/**
	 * Fill the board: what this platform already knows, then whatever advertises.
	 * Safe to call on every open of the sheet; a scan already running is left alone.
	 */
	async scan(): Promise<void> {
		if (this.#disposed || this.#scanning || !this.canDiscover() || !this.#transport.isSupported()) return;
		const token = ++this.#scanToken;
		this.#setScanning(true);
		this.#scanTimer = setTimeout(() => this.stopScan(), SCAN_WINDOW_MS);

		const paired = await (this.#transport.listDevices?.() ?? Promise.resolve<ScaleDeviceSeed[]>([])).catch(
			() => [] as ScaleDeviceSeed[],
		);
		if (token !== this.#scanToken || this.#disposed) return;
		this.#sight(paired);

		const startScan = this.#transport.startScan;
		if (!startScan) return;
		const stop = await startScan.call(this.#transport, (seed) => {
			if (token === this.#scanToken && !this.#disposed) this.#sight([seed]);
		}).catch(() => null);
		// The window can close while the radio is still starting up.
		if (token !== this.#scanToken || this.#disposed) {
			if (stop) stop();
			return;
		}
		this.#scanStop = stop;
	}

	/** Stop listening. Rows already on the board stay — they are not a live preview. */
	stopScan(): void {
		this.#scanToken += 1;
		if (this.#scanTimer != null) {
			clearTimeout(this.#scanTimer);
			this.#scanTimer = null;
		}
		const stop = this.#scanStop;
		this.#scanStop = null;
		if (stop) stop();
		this.#setScanning(false);
	}

	#sight(seeds: ScaleDeviceSeed[]): void {
		if (!seeds.length) return;
		this.#publish(mergeDevices(this.#board, seeds, { lastUsedId: this.#lastUsedId }));
	}

	/** The row the user just used is the one they want first tomorrow. */
	#markUsed(id: string | null): void {
		if (id == null || this.#lastUsedId === id) return;
		this.#lastUsedId = id;
		rememberScaleDevice(id);
		this.#publish(mergeDevices(this.#board, [], { lastUsedId: id }));
	}

	/** Emit only when something a person can see actually changed. */
	#publish(next: ScaleDevice[]): void {
		const signature = boardSignature(next);
		if (signature === this.#boardSeen) return;
		this.#board = next;
		this.#boardSeen = signature;
		this.#emitter.emit("devices", next);
	}

	/** Must run inside a click handler because Web Bluetooth requires user activation. */
	async start(): Promise<void> {
		await this.#begin((handlers) => this.#transport.connect(handlers), null);
	}

	/**
	 * Tap on a row. Same session, same staged capture as the picker path — only the
	 * way onto the device differs, and browsers without `connectTo` end up at their
	 * own picker anyway.
	 */
	async connectTo(device: ScaleDevice): Promise<void> {
		const connectTo = this.#transport.connectTo;
		const id = device.id;
		if (!connectTo) {
			await this.start();
			return;
		}
		await this.#begin((handlers) => connectTo.call(this.#transport, id, handlers), id);
	}

	async #begin(
		open: (handlers: ScaleConnectHandlers) => Promise<ScaleConnection>,
		usedId: string | null,
	): Promise<void> {
		if (this.#disposed || this.#state === "choosing" || this.#connection) return;
		this.stopScan();
		this.#reset();
		const attempt = ++this.#attempt;
		let ready = false;
		let disconnectedBeforeReady = false;
		const pendingFrames: Array<Uint8Array | DataView> = [];
		this.#setState("choosing");

		try {
			const connection = await open({
				onFrame: (bytes) => {
					if (this.#disposed || attempt !== this.#attempt) return;
					if (!ready) pendingFrames.push(bytes);
					else if (this.#isActive()) this.#handleFrame(bytes);
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
			this.#markUsed(usedId);
			this.#emitter.emit("device", connection.label);
			this.#setState("connected");
			ready = true;
			this.#arm("weight", this.#limits.weight, () => this.#failNoStableWeight());

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
		this.stopScan();
		this.#attempt += 1;
		this.#teardown();
		this.#setState("idle");
	}

	dispose(): void {
		this.#disposed = true;
		this.stopScan();
		this.#attempt += 1;
		this.#teardown();
		this.#emitter.clear();
	}

	#isActive(): boolean {
		return this.#state === "connected" || this.#state === "weighing";
	}

	#handleFrame(bytes: Uint8Array | DataView): void {
		const events = this.#session.handle(bytes);
		if (!events.length) return;
		if (this.#session.weightLocked && this.#state === "connected") this.#setState("weighing");
		this.#emitEvents(events);
		this.#trackQuietFrames(events);
		if (this.#session.completed) this.#finish();
		else if (this.#session.weightLocked && this.#quietTooLong()) this.#close("idle");
	}

	/**
	 * A frame that carried neither pulse nor impedance is the scale telling us it
	 * has nothing more to give. Counting them is what keeps a weight-only unit from
	 * holding the user hostage through windows that can never be satisfied.
	 */
	#trackQuietFrames(events: ScaleSessionEvent[]): void {
		if (!this.#session.weightLocked) return;
		for (const event of events) {
			if (event.kind !== "live") continue;
			if (event.heartRate == null && event.impedanceOhms == null) this.#quietFrames += 1;
			else this.#quietFrames = 0;
		}
	}

	#quietTooLong(): boolean {
		return this.#quietFrames >= NO_SIGNAL_FRAMES;
	}

	#handleDisconnected(): void {
		if (this.#state === "complete" || this.#state === "idle" || this.#state === "error") return;
		if (this.#session.weightLocked) {
			// The scale powered off in the normal way. Whatever agreed is the reading.
			this.#close("disconnect");
			return;
		}
		this.#teardown();
		this.#setState("error");
		this.#emitter.emit("error", new Error("Scale disconnected before a stable weight was captured."));
	}

	#failNoStableWeight(): void {
		if (!this.#isActive() || this.#session.weightLocked) return;
		this.#teardown();
		this.#setState("error");
		this.#emitter.emit(
			"error",
			new Error("No stable weight was received. Step onto the scale, hold still, and try again."),
		);
	}

	/** Move the readout to the next stage without waiting for its trigger frame. */
	#advance(stage: Exclude<ScaleStage, "done">): void {
		if (!this.#isActive()) return;
		this.#emitEvents(this.#session.advance(stage));
		// The pulse hunt gave up but the resistance already agreed — the stage we just
		// entered has nothing left to collect, so don't make them stand there for it.
		if (stage === "composition" && this.#session.impedanceLocked) this.#close("timeout");
	}

	/**
	 * Close the weigh-in with only what stabilized, then let the session's own
	 * `complete` event drive the UI. Returns nothing when the weight never locked.
	 */
	#close(reason: "timeout" | "disconnect" | "idle"): void {
		const events = this.#session.finalize(reason);
		if (!events.length) return;
		this.#emitEvents(events);
		this.#finish();
	}

	#finish(): void {
		this.#clearTimers();
		this.#teardownConnection();
		this.#setState("complete");
	}

	#emitEvents(events: ScaleSessionEvent[]): void {
		for (const event of events) {
			switch (event.kind) {
				case "complete":
					this.#emitter.emit("complete", event.reading);
					break;
				case "locked":
					// The weight is settled; the optional signals now have their own clocks.
					this.#clear("weight");
					this.#quietFrames = 0;
					this.#arm("heart", this.#limits.heart, () => this.#advance("composition"));
					this.#emitter.emit("locked", { weightKg: event.weightKg });
					break;
				case "stage":
					this.#emitter.emit("stage", event.stage);
					if (event.stage === "composition") {
						this.#clear("heart");
						this.#arm("composition", this.#limits.composition, () => this.#close("timeout"));
					}
					break;
				case "settle":
					this.#emitter.emit("settle", {
						metric: event.metric,
						have: event.have,
						need: event.need,
						value: event.value,
					});
					break;
				case "live":
					this.#emitter.emit("live", {
						weightKg: event.weightKg,
						heartRate: event.heartRate,
						impedanceOhms: event.impedanceOhms,
						phase: event.phase,
						locked: event.locked,
					});
					break;
			}
		}
	}

	#setState(next: ScaleClientState): void {
		if (this.#state === next) return;
		this.#state = next;
		this.#emitter.emit("state", next);
	}

	#setScanning(next: boolean): void {
		if (this.#scanning === next) return;
		this.#scanning = next;
		this.#emitter.emit("scanning", next);
	}

	#arm(name: TimerName, ms: number, fn: () => void): void {
		this.#clear(name);
		this.#timers[name] = setTimeout(() => {
			this.#timers[name] = null;
			fn();
		}, ms);
	}

	#clear(name: TimerName): void {
		const timer = this.#timers[name];
		if (timer != null) clearTimeout(timer);
		this.#timers[name] = null;
	}

	#clearTimers(): void {
		for (const name of ["weight", "heart", "composition"] as const) this.#clear(name);
	}

	#teardownConnection(): void {
		const connection = this.#connection;
		this.#connection = null;
		if (connection) void connection.disconnect().catch(() => {});
	}

	#teardown(): void {
		this.#clearTimers();
		this.#teardownConnection();
	}

	#reset(): void {
		this.#teardown();
		this.#session = new ScaleSession();
		this.#quietFrames = 0;
	}
}
