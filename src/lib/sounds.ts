let soundsEnabled = true;
let ctx: AudioContext | null = null;

export function setSoundsEnabled(enabled: boolean): void {
  soundsEnabled = !!enabled;
  if (!soundsEnabled && ctx) {
    void ctx.close().catch(() => {});
    ctx = null;
  }
}

function audioContext(): AudioContext | null {
  if (!soundsEnabled || typeof window === 'undefined') return null;
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

interface ToneOptions {
  frequency: number;
  start?: number;
  duration?: number;
  gain?: number;
  type?: OscillatorType;
  slideTo?: number;
}

function playTone(options: ToneOptions): void {
  const audio = audioContext();
  if (!audio) return;
  if (audio.state === 'suspended') void audio.resume().catch(() => {});
  const start = audio.currentTime + (options.start ?? 0);
  const duration = options.duration ?? 0.09;
  const peak = options.gain ?? 0.035;
  try {
    const osc = audio.createOscillator();
    const amp = audio.createGain();
    osc.type = options.type ?? 'sine';
    osc.frequency.setValueAtTime(options.frequency, start);
    if (options.slideTo) {
      osc.frequency.exponentialRampToValueAtTime(options.slideTo, start + duration);
    }
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(amp);
    amp.connect(audio.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  } catch {
    /* audio graph unavailable */
  }
}

/** Subtle click when a set is logged. */
export function playSetLogged(): void {
  playTone({ frequency: 880, duration: 0.06, gain: 0.028, type: 'triangle' });
  playTone({ frequency: 1320, start: 0.045, duration: 0.07, gain: 0.02, type: 'sine' });
}

/** Descending cue when rest begins. */
export function playRestStart(): void {
  playTone({ frequency: 520, slideTo: 340, duration: 0.18, gain: 0.028, type: 'sine' });
}

/** Ascending three-note cue when rest finishes or a timer target is reached. */
export function playRestEnd(): void {
  playTone({ frequency: 660, duration: 0.1, gain: 0.032, type: 'sine' });
  playTone({ frequency: 880, start: 0.1, duration: 0.1, gain: 0.03, type: 'sine' });
  playTone({ frequency: 1320, start: 0.2, duration: 0.16, gain: 0.026, type: 'sine' });
}

/** Short rising arpeggio for finishing a workout. */
export function playWorkoutComplete(): void {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((frequency, index) => {
    playTone({
      frequency,
      start: index * 0.09,
      duration: index === notes.length - 1 ? 0.28 : 0.12,
      gain: index === notes.length - 1 ? 0.045 : 0.03,
      type: 'triangle',
    });
  });
}

/** Low, short warning buzz. */
export function playError(): void {
  playTone({ frequency: 180, slideTo: 130, duration: 0.18, gain: 0.035, type: 'sawtooth' });
}
