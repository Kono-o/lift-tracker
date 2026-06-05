<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { PUBLIC_SUPABASE_URL } from '$env/static/public';
  import { db, supabase, formatAccountError, formatAuthError, formatDbError, getAuthDisplayName, getAuthRedirectError, isUsernameAccount, isWorkoutInProgress, validateEmail, validateUsername, type Template, type Exercise, type WorkoutHistory } from '$lib/db';
  import {
    ArrowLeft,
    Bed,
    CalendarDays,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Dumbbell,
    FileX,
    GripVertical,
    Lock,
    LockKeyhole,
    Mail,
    Pause,
    Pencil,
    Play,
    Plus,
    Check,
    RefreshCw,
    Repeat,
    SkipForward,
    Square,
    Timer,
    Trash2,
    TriangleAlert,
    User,
    X
  } from '@lucide/svelte';
  import AuthBrandIcon from '$lib/components/auth-brand-icons.svelte';

  // Constants
  const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function toDateStr(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /** ISO-8601 week number (1–53) for the given local calendar date. */
  function getISOWeekNumber(d: Date): number {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }

  const REAL_TODAY = new Date();
  REAL_TODAY.setHours(0, 0, 0, 0);
  const REAL_TODAY_STR = toDateStr(REAL_TODAY);
  const TODAY_WEEKDAY = REAL_TODAY.getDay();

  let clockTimeStr = $state('');

  function updateClock() {
    const now = new Date();
    const h = now.getHours().toString().padStart(2, '0');
    const m = now.getMinutes().toString().padStart(2, '0');
    const s = now.getSeconds().toString().padStart(2, '0');
    clockTimeStr = `${h}:${m}:${s}`;
  }

  updateClock();

  // State
  let selectedDate = $state(new Date(REAL_TODAY));
  let viewedLog = $state<any>(null);
  let weekLogs = $state<Record<string, any | null>>({});
  let currentView = $state<'track' | 'swap_template' | 'edit_template'>('track');

  let selectedDateDisplay = $derived.by(() => {
    const ud = selectedDate;
    const umons = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const nice = `${ud.getDate()} ${umons[ud.getMonth()]} ${ud.getFullYear()}`;
    const sci = `D ${String(ud.getDate()).padStart(2,'0')} ${umons[ud.getMonth()]} Y ${String(ud.getFullYear()).slice(-2)}`;
    return { nice, sci };
  });

  let weekBarLabel = $derived.by(() => {
    const week = getISOWeekNumber(selectedDate);
    return `${selectedDateDisplay.nice} · ${DAY_NAMES[selectedWeekday].toUpperCase()} · W${week}`;
  });

  function selectDate(newD: Date) {
    const newKey = toDateStr(newD);
    const oldKey = selectedDateStr;
    if (newKey !== oldKey) {
      activeTimerExerciseId = null;
      activeTimerSetIndex = null;
      countdownSeconds = 0;
      countdownRunning = false;
      clearInterval(countdownTimer);
    }
    selectedDate = new Date(newD);
    selectedDate.setHours(0, 0, 0, 0);
    currentView = 'track';
  }

  function goPrevWeek() {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() - 7);
    selectDate(d);
  }

  function goNextWeek() {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + 7);
    selectDate(d);
  }

  function goToToday() {
    if (isViewingToday) return;
    selectDate(REAL_TODAY);
  }
  let builderAssignments = $state<Record<number, string | null>>({});
  let builderEditingDay = $state<number>(0);
  let editingRoutineTemplateNameId = $state<string | null>(null);
  const routineEditorPendingCreates = new Map<number, Promise<string | null>>();
  let builderAssignedTemplateId = $derived(builderAssignments[builderEditingDay] ?? null);
  let builderDayAssignmentLabel = $derived.by(() => {
    const day = DAY_NAMES[builderEditingDay].toUpperCase();
    const tid = builderAssignments[builderEditingDay] ?? null;
    if (tid === null) return `${day} - [ REST DAY ]`;
    const tpl = templates.find((t) => t.id === tid);
    return `${day} - [ ${tpl?.name ?? 'Workout'} ]`;
  });
  let isLoading = $state(true);
  let bootMessage = $state('Checking session…');
  type BootSection = { title: string; lines: string[] };
  let bootSections = $state<BootSection[]>([]);

  function enterRoutineBuilder(opts: { fromWeeklyPlan?: boolean } = {}) {
    if (workoutState === 'active') return;
    if (!opts.fromWeeklyPlan && !showHeaderEditActions) return;
    templateError = null;
    editingRoutineTemplateNameId = null;
    const newAssignments: Record<number, string | null> = {};
    for (const s of schedule) {
      newAssignments[s.day_of_week] = s.template_id ?? null;
    }
    builderAssignments = newAssignments;
    builderEditingDay = selectedWeekday;
    currentView = 'swap_template';
  }
  let isSyncing = $state(false);
  let hasInitialLoad = $state(false);
  let weekCalendarCollapsed = $state(true);
  let weekCalendarClosing = $state(false);
  const WEEK_CALENDAR_MS = 260;

  function toggleWeekCalendar() {
    if (weekCalendarCollapsed) {
      weekCalendarClosing = false;
      weekCalendarCollapsed = false;
      return;
    }
    weekCalendarClosing = true;
    weekCalendarCollapsed = true;
    setTimeout(() => {
      weekCalendarClosing = false;
    }, WEEK_CALENDAR_MS);
  }

  // Auth state (powered by new db.ts + Supabase OAuth Google/GitHub)
  let currentUser = $state<any>(null);
  let isAuthLoading = $state(true);
  let showBootScreen = $derived(isAuthLoading || (currentUser !== null && isLoading));
  let bootOverlayVisible = $state(true);
  let bootOverlayExiting = $state(false);
  let appRevealActive = $state(false);

  function onBootOverlayTransitionEnd(e: TransitionEvent) {
    if (e.propertyName !== 'opacity' || !bootOverlayExiting) return;
    bootOverlayVisible = false;
    bootOverlayExiting = false;
  }

  $effect(() => {
    if (showBootScreen) {
      bootOverlayVisible = true;
      bootOverlayExiting = false;
      appRevealActive = false;
      return;
    }
    if (!currentUser) {
      bootOverlayVisible = false;
      bootOverlayExiting = false;
      appRevealActive = false;
      return;
    }
    let cancelled = false;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    void tick().then(() => {
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (cancelled) return;
        appRevealActive = true;
        if (!bootOverlayVisible) return;
        bootOverlayExiting = true;
        fallback = setTimeout(() => {
          if (!bootOverlayExiting) return;
          bootOverlayVisible = false;
          bootOverlayExiting = false;
        }, 340);
      });
    });
    return () => {
      cancelled = true;
      if (fallback) clearTimeout(fallback);
    };
  });
  let signingIn = $state(false);
  let authError = $state<string | null>(null);
  let authSuccess = $state<string | null>(null);

  let authMode = $state<'signin' | 'signup'>('signin');
  let authCredentialMethod = $state<'username' | 'email'>('username');
  let authUsername = $state('');
  let authEmail = $state('');
  let authPassword = $state('');
  let authConfirmPassword = $state('');
  let showAccountPanel = $state(false);
  let accountBusy = $state(false);
  let accountError = $state<string | null>(null);

  let accountDisplayName = $derived(getAuthDisplayName(currentUser));
  let accountProvider = $derived.by(() => {
    if (isUsernameAccount(currentUser)) return 'Username';
    const id = currentUser?.identities?.[0]?.provider ?? currentUser?.app_metadata?.provider;
    if (!id || id === 'email') return 'Email';
    return String(id).charAt(0).toUpperCase() + String(id).slice(1);
  });
  let accountMemberSince = $derived.by(() => {
    const raw = currentUser?.created_at;
    if (!raw) return '—';
    return new Date(raw).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  });
  let accountInitial = $derived.by(() => {
    const name = getAuthDisplayName(currentUser);
    if (name && name !== '—') return name[0]!.toUpperCase();
    return '?';
  });
  let workoutState = $state<'idle' | 'active' | 'done' | 'skipped'>('idle');

  /** Bumps invalidate pending rAF tap-flashes when CTA buttons unmount mid-animation. */
  let tapPulseGen = { skip: 0, cancel: 0, erase: 0 };

  $effect(() => {
    if (workoutState !== 'idle') {
      tapPulseGen.skip++;
      skipTapPulseActive = false;
      stopSkipHold();
      cancelStartWorkoutAnim();
    } else {
      tapPulseGen.skip++;
      skipTapPulseActive = false;
      stopSkipHold();
      tapPulseGen.erase++;
      eraseTapPulseActive = false;
      stopEraseHold();
    }
    if (workoutState !== 'active') {
      tapPulseGen.cancel++;
      cancelTapPulseActive = false;
      stopCancelHold();
      stopFinishHold();
      stopCancelRevertAnim();
    }
    if (workoutState === 'idle') {
      clearFinishCenterFade();
    }
  });
  /** Template locked in when START is pressed (finish uses this even if schedule changes). */
  let activeWorkoutTemplate = $state<Template | null>(null);
  let workoutActionError = $state<string | null>(null);
  let justFinishedStatus = $state<'green' | 'yellow' | null>(null);

  // Data arrays
  let schedule = $state<any[]>([]);
  let templates = $state<Template[]>([]);
  let todayLog = $state<any>(null);
  /** All-time best weight per exercise id (reps); loaded for live PR badges. */
  let exerciseAllTimeBests = $state<Record<string, number>>({});

  let setCounts = $derived.by(() => {
    const template =
      workoutState === 'active' && activeWorkoutTemplate
        ? activeWorkoutTemplate
        : activeTemplate;
    if (!template) return { total: 0, done: 0, green: 0 };
    let total = 0;
    let done = 0;
    let green = 0;
    for (const ex of template.exercises) {
      total += ex.target_sets || 0;
      if (isViewingToday && useLiveSessionTracking()) {
        for (let i = 0; i < (ex.target_sets || 0); i++) {
          const k = `${ex.id}-${i}`;
          if (ex.exercise_type === 'reps') {
            const reps = trackedReps[k];
            if (reps != null) {
              done++;
              if (reps >= ex.target_reps) green++;
            }
          } else if (completedTimers[k]) {
            done++;
            if (completedTimers[k].met) green++;
          }
        }
      } else if (isViewingToday && todayLogForDisplay()) {
        const log = todayLogForDisplay();
        const targetSecs =
          ex.exercise_type === 'time'
            ? (ex.target_minutes || 0) * 60 + (ex.target_seconds || 0)
            : 0;
        for (let s = 0; s < (ex.target_sets || 0); s++) {
          if (ex.exercise_type === 'reps') {
            const reps = getHistoricalReps(log, ex.id, s);
            if (reps != null) {
              done++;
              if (reps >= (ex.target_reps || 0)) green++;
            }
          } else {
            const t = getHistoricalTime(log, ex.id, s, targetSecs);
            if (t) {
              done++;
              if (t.met) green++;
            }
          }
        }
      } else if (viewedLog?.workout_snapshot?.exercises) {
        const loggedEx = getLoggedEx(viewedLog, ex.id);
        if (loggedEx) {
          const sets = ex.target_sets || 0;
          if (ex.exercise_type === 'reps' || loggedEx.performed_sets || loggedEx.sets) {
            const target = ex.target_reps || 0;
            let performed: (number | null)[] = [];
            if (loggedEx.sets && Array.isArray(loggedEx.sets)) {
              performed = loggedEx.sets.map((ss: any) => ss.reps_completed ?? null);
            } else {
              performed = loggedEx.performed_sets || [];
            }
            for (let s = 0; s < sets; s++) {
              const val = performed[s];
              if (val != null) {
                done++;
                if (val >= target) green++;
              }
            }
          } else if (loggedEx.performed_times || loggedEx.sets) {
            const tMin = ex.target_minutes || 0;
            const tSec = ex.target_seconds || 0;
            const target = tMin * 60 + tSec;
            let performedSecs: (number | null)[] = [];
            if (loggedEx.sets && Array.isArray(loggedEx.sets)) {
              performedSecs = loggedEx.sets.map((ss: any) => ss.seconds_completed ?? null);
            } else if (loggedEx.performed_times) {
              performedSecs = (loggedEx.performed_times || []).map((r: any) => {
                if (!r) return null;
                const m = String(r).match(/(\d+)m(\d+)s/);
                return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
              });
            }
            for (let s = 0; s < sets; s++) {
              const secs = performedSecs[s];
              if (secs != null) {
                done++;
                if (secs >= target) green++;
              }
            }
          }
        }
      }
    }
    return { total, done, green };
  });

  let workoutProgress = $derived(setCounts.total > 0 ? Math.round((setCounts.done / setCounts.total) * 100) : 0);

  let isPerfectDay = $derived(setCounts.total > 0 && setCounts.green === setCounts.total);

  let sessionStatus = $derived.by(() => {
    if (isPerfectDay) return 'green';
    if (setCounts.done > 0) return 'yellow';
    return 'neutral';
  });

  let progressBarColor = $derived.by(() => {
    if (sessionStatus === 'green') return 'var(--w-green-fg)';
    if (sessionStatus === 'yellow') return 'var(--w-yellow-fg)';
    return '#ffffff';
  });

  function logIsSkipped(log: { is_skipped?: boolean; workout_snapshot?: { skipped?: boolean } } | null) {
    return !!log?.is_skipped || !!log?.workout_snapshot?.skipped;
  }

  let todayCompletionStatus = $derived.by(() => {
    if (workoutState === 'skipped' || skipRevertAnimating) return 'skipped';
    if (finishSyncPending && justFinishedStatus) return justFinishedStatus;
    if (workoutState === 'active' && isWorkoutInProgress(todayLog)) return 'neutral';
    if (!todayLog) return 'neutral';
    if (logIsSkipped(todayLog)) return 'skipped';
    if (todayLog.workout_snapshot?.is_rest) return 'neutral';
    if (isWorkoutInProgress(todayLog)) return 'neutral';
    const status = completionStatusFromSnapshot(todayLog.workout_snapshot);
    // Any saved today workout (non-rest) counts as at least yellow on the calendar/header
    return status === 'neutral' ? 'yellow' : status;
  });

  // Timers and Clocks
  let workoutDuration = $state(0);
  let workoutStartedAt = $state<number | null>(null);
  let workoutTimer: any = null;
  let countdownSeconds = $state(0);
  let countdownRunning = $state(false);
  let countdownTimer: any = null;
  let activeTimerExerciseId = $state<string | null>(null);
  let activeTimerSetIndex = $state<number | null>(null);

  // Tracking data maps
  let trackedReps = $state<Record<string, number>>({});
  let completedTimers = $state<Record<string, { result: string; met: boolean }>>({});
  let editingSetKey = $state<string | null>(null);
  let repSetHoldTimer: ReturnType<typeof setInterval> | null = null;
  let repSetHoldKey: string | null = null;
  let repSetHoldFired = false;
  let repSetHoldProgress = $state(0);

  // Skip button hold progress
  let skipHoldTimer: any = null;
  let skipProgress = $state(0);
  let skipTapPulseActive = $state(false);

  // Hold-to-confirm for cancel and deletes (like skip)
  let cancelHoldTimer: any = null;
  let cancelProgress = $state(0);
  let cancelTapPulseActive = $state(false);
  let eraseTapPulseActive = $state(false);
  let deleteTemplateHoldTimer: any = null;
  let deleteTemplateProgress = $state(0);
  let eraseHoldTimer: any = null;
  let eraseProgress = $state(0);
  let signOutHoldTimer: ReturnType<typeof setInterval> | null = null;
  let signOutProgress = $state(0);
  let signOutTapPulseActive = $state(false);
  let deleteAccountHoldTimer: ReturnType<typeof setInterval> | null = null;
  let deleteAccountProgress = $state(0);
  let deleteAccountTapPulseActive = $state(false);
  const HOLD_CONFIRM_MS = 1000;
  const FAST_HOLD_CONFIRM_MS = 500;
  const REP_SET_HOLD_MS = 250;
  const ACTIVE_SESSION_STORAGE_KEY = 'lift-tracker:active-session';
  const WORKOUT_PROGRESS_SAVE_MS = 450;
  let workoutProgressSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let workoutProgressSaveInFlight = false;
  /** Bumped on finish/cancel/start so late autosaves cannot overwrite the completed log. */
  let workoutProgressSaveGen = 0;
  /** Keep showing in-memory sets until submitWorkoutSession + loadData finish. */
  let finishSyncPending = $state(false);
  const SIGN_OUT_HOLD_MS = 3000;
  const DELETE_ACCOUNT_HOLD_MS = 5000;
  const START_WORKOUT_ANIM_MS = 700;
  const FINISH_CTA_FADE_MS = 220;
  const START_CTA_SOURCE = 'START WORKOUT';
  const START_CTA_TARGET = 'FINISH WORKOUT';
  const SKIP_CTA_SOURCE = 'SKIP';
  const SKIP_CTA_TARGET = 'CANCEL';
  const COMPLETE_CTA_SOURCE = 'WORKOUT COMPLETE';
  const SKIPPED_CTA_SOURCE = 'WORKOUT SKIPPED';
  const ERASE_CTA_SOURCE = 'ERASE';
  const workoutCenterBtnClass =
    'workout-cta-center font-sans col-span-3 h-[52px] rounded-xl flex items-center justify-center text-center border-2 hover:brightness-110 group relative';
  const workoutSideBtnClass =
    'workout-cta-side font-sans col-span-1 h-[52px] rounded-xl flex items-center justify-center text-center relative overflow-hidden hover:brightness-110 group';
  const workoutCenterLabelClass =
    'workout-cta-label transition-[letter-spacing] group-hover:tracking-[0.2em]';
  const workoutSideLabelClass =
    'workout-cta-label workout-cta-label-side relative z-10 transition-[letter-spacing] group-hover:tracking-[0.2em]';
  const CENTER_CTA_MAX_CH = 16;
  const SIDE_CTA_MAX_CH = 6;
  const START_CTA_SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function ctaChStyle(text: string, maxCh: number): string {
    const ch = Math.min(Math.max(text.length, 1), maxCh);
    return `--cta-ch:${ch};--cta-ch-side-max:${maxCh}`;
  }

  /** Character count eases from source length → target length over the glitch. */
  function ctaLengthAt(progress: number, source: string, target: string): number {
    const p = Math.min(Math.max(progress, 0), 1);
    if (p >= 1) return target.length;
    if (p <= 0) return source.length;
    return Math.max(1, Math.round(source.length + (target.length - source.length) * p));
  }

  function mixRgb(
    t: number,
    from: [number, number, number],
    to: [number, number, number],
  ): string {
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }

  /** Hold-to-confirm: fade from normal fill to inverted (dark fill + light text + border). */
  function holdInvertButtonStyle(
    t: number,
    normalBg: [number, number, number],
    normalFg: [number, number, number],
    invertedBg: [number, number, number],
    invertedFg: [number, number, number],
    borderRgb: [number, number, number],
  ): string {
    const p = Math.min(Math.max(t, 0), 1);
    const bg = mixRgb(p, normalBg, invertedBg);
    const fg = mixRgb(p, normalFg, invertedFg);
    const border =
      p > 0
        ? `2px solid rgba(${borderRgb[0]}, ${borderRgb[1]}, ${borderRgb[2]}, ${p})`
        : '2px solid transparent';
    return `background-color: ${bg}; color: ${fg}; border: ${border};`;
  }

  let startWorkoutAnimating = $state(false);
  let startWorkoutAnimTimer: ReturnType<typeof setTimeout> | null = null;
  let startCtaScrambleRaf = 0;
  let startCtaLabel = $state(START_CTA_SOURCE);
  let sideCtaLabel = $state(SKIP_CTA_SOURCE);
  let eraseRevertAnimating = $state(false);
  let eraseRevertAnimTimer: ReturnType<typeof setTimeout> | null = null;
  let eraseRevertScrambleRaf = 0;
  let eraseRevertCenterLabel = $state(COMPLETE_CTA_SOURCE);
  let eraseRevertSideLabel = $state(ERASE_CTA_SOURCE);
  let cancelRevertAnimating = $state(false);
  let cancelRevertAnimTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelRevertScrambleRaf = 0;
  let cancelRevertCenterLabel = $state(START_CTA_TARGET);
  let cancelRevertSideLabel = $state(SKIP_CTA_TARGET);
  let cancelRevertWasPerfect = $state(false);
  let skipRevertAnimating = $state(false);
  let skipRevertAnimTimer: ReturnType<typeof setTimeout> | null = null;
  let skipRevertScrambleRaf = 0;
  let skipRevertCenterLabel = $state(START_CTA_SOURCE);
  let skipRevertSideLabel = $state(SKIP_CTA_SOURCE);
  let finishHoldTimer: ReturnType<typeof setInterval> | null = null;
  let finishHoldProgress = $state(0);
  let finishCenterFading = $state(false);
  let finishCenterLabel = $state(START_CTA_TARGET);
  let finishCenterOpacity = $state(1);
  let finishFadeWasPerfect = $state(false);
  let finishFadeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearFinishCenterFade() {
    if (finishFadeTimer) clearTimeout(finishFadeTimer);
    finishFadeTimer = null;
    finishCenterFading = false;
    finishCenterLabel = START_CTA_TARGET;
    finishCenterOpacity = 1;
    finishFadeWasPerfect = false;
  }

  function startFinishCenterFade() {
    if (finishFadeTimer) clearTimeout(finishFadeTimer);
    finishCenterFading = true;
    finishCenterLabel = START_CTA_TARGET;
    finishCenterOpacity = 1;
    void tick().then(() =>
      tick().then(() => {
        finishCenterOpacity = 0;
        finishFadeTimer = setTimeout(() => {
          finishCenterLabel = COMPLETE_CTA_SOURCE;
          void tick().then(() => {
            finishCenterOpacity = 1;
            finishFadeTimer = setTimeout(() => {
              finishFadeTimer = null;
              finishCenterFading = false;
            }, FINISH_CTA_FADE_MS);
          });
        }, FINISH_CTA_FADE_MS);
      }),
    );
  }

  const finishHoldButtonStyle = $derived(
    isPerfectDay
      ? holdInvertButtonStyle(
          finishHoldProgress / 100,
          [74, 222, 128],
          [0, 0, 0],
          [20, 83, 45],
          [74, 222, 128],
          [74, 222, 128],
        )
      : holdInvertButtonStyle(
          finishHoldProgress / 100,
          [251, 191, 36],
          [0, 0, 0],
          [63, 42, 0],
          [251, 191, 36],
          [251, 191, 36],
        ),
  );

  // Form fields for creation/editing
  let newTemplateName = $state('');
  let templateError = $state<string | null>(null);
  let isCreatingTemplate = $state(false);

  // Draft state for template editing (local until commit on finish)
  let draftExercises = $state<any[]>([]);
  let draftTemplateName = $state('');
  let selectedExerciseId = $state<string | null>(null);
  let editingExerciseNameId = $state<string | null>(null);
  let editingTemplateId = $state('');
  let templateSaveError = $state<string | null>(null);
  let templateSaveInFlight = $state(false);
  let editingTemplate = $derived(
    editingTemplateId ? templates.find((t) => t.id === editingTemplateId) ?? null : null,
  );

  // Svelte 5 Derived State
  let selectedDateStr = $derived(toDateStr(selectedDate));
  let selectedWeekday = $derived(selectedDate.getDay());
  let currentDaySchedule = $derived(schedule.find(s => s.day_of_week === selectedWeekday));
  let activeTemplate = $derived(templates.find(t => t.id === currentDaySchedule?.template_id) || null);
  let isViewingToday = $derived(selectedDateStr === REAL_TODAY_STR);
  let isFuture = $derived(selectedDateStr > REAL_TODAY_STR);
  /** Reps/times/weight inputs — only while a live session is running. */
  let workoutExercisesEditable = $derived(
    isViewingToday && workoutState === 'active' && !isFuture,
  );
  let headerEditActionsFading = $derived(
    finishSyncPending || finishCenterFading || startWorkoutAnimating,
  );
  let headerEditActionsRevealing = $derived(
    eraseRevertAnimating || cancelRevertAnimating,
  );
  let showHeaderEditActions = $derived.by(() => {
    if (!isViewingToday || selectedDateStr < REAL_TODAY_STR) return false;
    if (headerEditActionsRevealing) return true;
    if (workoutState === 'skipped') return false;
    if (workoutState === 'done') return headerEditActionsFading;
    return workoutState === 'idle';
  });
  let currentWeekDates = $derived.by(() => {
    const base = new Date(selectedDate);
    base.setHours(0, 0, 0, 0);
    const sunday = new Date(base);
    sunday.setDate(base.getDate() - base.getDay());
    const arr: Array<{date: Date; key: string; letter: string; num: number; weekday: number; isRealToday: boolean}> = [];
    for (let i = 0; i < 7; i++) {
      const dt = new Date(sunday);
      dt.setDate(sunday.getDate() + i);
      const k = toDateStr(dt);
      arr.push({
        date: dt,
        key: k,
        letter: DAYS[dt.getDay()],
        num: dt.getDate(),
        weekday: dt.getDay(),
        isRealToday: k === REAL_TODAY_STR,
      });
    }
    return arr;
  });
  let weekPlan = $derived.by(() =>
    Array.from({ length: 7 }, (_, dayOfWeek) => {
      const row = schedule.find((s) => s.day_of_week === dayOfWeek);
      return {
        day: DAYS[dayOfWeek],
        hasTemplate: !!row?.template_id,
      };
    }),
  );
  let workoutLabel = $derived.by(() => {
    if (isViewingToday) return "TODAY'S WORKOUT";
    // Check for real tomorrow
    const realTomorrow = new Date(REAL_TODAY);
    realTomorrow.setDate(REAL_TODAY.getDate() + 1);
    if (selectedDateStr === toDateStr(realTomorrow)) return "TOMORROW'S WORKOUT";
    // Check for real yesterday
    const realYesterday = new Date(REAL_TODAY);
    realYesterday.setDate(REAL_TODAY.getDate() - 1);
    if (selectedDateStr === toDateStr(realYesterday)) return "YESTERDAY'S WORKOUT";
    return `${DAY_NAMES[selectedWeekday].toUpperCase()}'S WORKOUT`;
  });

  let viewedCompletionStatus = $derived.by(() => {
    const log = viewedLog;
    if (!log) return 'neutral';
    if (logIsSkipped(log)) return 'skipped';
    if (log.workout_snapshot?.is_rest) return 'neutral';
    return completionStatusFromSnapshot(log.workout_snapshot);
  });

  /** Header + routine icons: green / yellow / red(skipped) / neutral */
  let headerSurfaceStatus = $derived.by(() => {
    if (eraseRevertAnimating) return 'neutral';
    if (
      isViewingToday &&
      (skipRevertAnimating ||
        workoutState === 'skipped' ||
        todayCompletionStatus === 'skipped' ||
        logIsSkipped(todayLog))
    ) {
      return 'skipped';
    }
    if (!isViewingToday && viewedCompletionStatus === 'skipped') return 'skipped';
    if (workoutState === 'active') return sessionStatus;
    const completion = isViewingToday
      ? (justFinishedStatus ?? todayCompletionStatus)
      : viewedCompletionStatus;
    if (completion === 'green') return 'green';
    if (completion === 'yellow') return 'yellow';
    return 'neutral';
  });

  // Load viewedLog whenever selected date changes (for past/future history)
  $effect(() => {
    if (!currentUser) return;
    const key = selectedDateStr;
    if (key === REAL_TODAY_STR) {
      viewedLog = todayLog;
      return;
    }
    if (weekLogs[key] !== undefined) {
      viewedLog = weekLogs[key];
      return;
    }
    db.getLogForDate(key)
      .then((log) => {
        if (selectedDateStr === key) {
          viewedLog = log;
        }
      })
      .catch(() => {
        if (selectedDateStr === key) {
          viewedLog = null;
        }
      });
  });

  // Fetch logs for all currently visible days in the week strip (so we can display logged status)
  $effect(() => {
    if (!currentUser) return;
    const visible = currentWeekDates;
    for (const d of visible) {
      const k = d.key;
      if (k === REAL_TODAY_STR) {
        weekLogs[k] = todayLog;
        continue;
      }
      // skip if we already have it cached for this render
      if (k in weekLogs) continue;
      db.getLogForDate(k)
        .then((log) => {
          // only keep if still part of visible week
          if (currentWeekDates.some((dd) => dd.key === k)) {
            weekLogs = { ...weekLogs, [k]: log };
          }
        })
        .catch(() => {
          if (currentWeekDates.some((dd) => dd.key === k)) {
            weekLogs = { ...weekLogs, [k]: null };
          }
        });
    }
  });

  // Keep viewedLog in sync if weekLogs gets populated for the currently selected day
  $effect(() => {
    const key = selectedDateStr;
    if (key !== REAL_TODAY_STR && weekLogs[key] !== undefined) {
      viewedLog = weekLogs[key];
    }
  });

  function formatTime(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  function useLiveSessionTracking() {
    return workoutState === 'active' || finishSyncPending;
  }

  function todayLogForDisplay() {
    if (!isViewingToday || !todayLog || logIsSkipped(todayLog) || todayLog.workout_snapshot?.is_rest) {
      return null;
    }
    if (finishSyncPending || isWorkoutInProgress(todayLog)) {
      return null;
    }
    return todayLog;
  }

  async function refreshExerciseAllTimeBests(exercises: Exercise[]) {
    const repsExercises = exercises.filter((ex) => ex.exercise_type === 'reps');
    if (!repsExercises.length) {
      exerciseAllTimeBests = {};
      return;
    }
    try {
      const entries = await Promise.all(
        repsExercises.map(
          async (ex) => [ex.id, await db.getExercisePersonalBest(ex.id)] as const,
        ),
      );
      exerciseAllTimeBests = Object.fromEntries(entries);
    } catch (err) {
      console.error('exercise PR bests fetch failed', err);
    }
  }

  function repsExerciseMeetsTarget(exercise: Exercise): boolean {
    let loggedSetsCount = 0;
    let allRepsMetTarget = true;
    for (let s = 0; s < exercise.target_sets; s++) {
      const reps = trackedReps[`${exercise.id}-${s}`];
      if (reps !== undefined && reps !== null) {
        loggedSetsCount++;
        if (reps < exercise.target_reps) allRepsMetTarget = false;
      } else {
        allRepsMetTarget = false;
      }
    }
    return loggedSetsCount === exercise.target_sets && allRepsMetTarget;
  }

  function exerciseLiveIsPr(exercise: Exercise): boolean {
    if (exercise.exercise_type === 'time') {
      let loggedSetsCount = 0;
      let allMet = true;
      for (let s = 0; s < exercise.target_sets; s++) {
        const t = completedTimers[`${exercise.id}-${s}`];
        if (t !== undefined && t !== null) {
          loggedSetsCount++;
          if (!t.met) allMet = false;
        } else {
          allMet = false;
        }
      }
      return loggedSetsCount === exercise.target_sets && allMet;
    }
    const weight = exercise.current_weight ?? 0;
    if (weight <= 0) return false;
    const best = exerciseAllTimeBests[exercise.id] ?? 0;
    return repsExerciseMeetsTarget(exercise) && weight > best;
  }

  function showPrBadge(exercise: Exercise, loggedEx: { exercise_is_pr?: boolean } | null): boolean {
    if (headerSurfaceStatus === 'skipped') return false;
    if (isViewingToday && useLiveSessionTracking()) {
      return exerciseLiveIsPr(exercise);
    }
    return !!loggedEx?.exercise_is_pr;
  }

  function exerciseStatusFromLog(log: any, exercise: Exercise): 'green' | 'yellow' | 'neutral' {
    const loggedEx = getLoggedEx(log, exercise.id);
    if (loggedEx?.exercise_is_pr) return 'green';

    let loggedSetsCount = 0;
    let allMet = true;
    const targetSecs =
      exercise.exercise_type === 'time'
        ? (exercise.target_minutes || 0) * 60 + (exercise.target_seconds || 0)
        : 0;

    for (let s = 0; s < exercise.target_sets; s++) {
      if (exercise.exercise_type === 'reps') {
        const reps = getHistoricalReps(log, exercise.id, s);
        if (reps != null) {
          loggedSetsCount++;
          if (reps < (exercise.target_reps || 0)) allMet = false;
        } else {
          allMet = false;
        }
      } else {
        const t = getHistoricalTime(log, exercise.id, s, targetSecs);
        if (t) {
          loggedSetsCount++;
          if (!t.met) allMet = false;
        } else {
          allMet = false;
        }
      }
    }

    if (loggedSetsCount === exercise.target_sets && allMet) {
      if (
        exercise.exercise_type === 'reps' &&
        loggedEx &&
        loggedEx.exercise_is_pr === false
      ) {
        return 'yellow';
      }
      return 'green';
    }
    if (loggedSetsCount > 0) return 'yellow';
    return 'neutral';
  }

  function getExerciseStatus(exercise: Exercise) {
    if (eraseRevertAnimating) return 'neutral';
    if (isViewingToday && useLiveSessionTracking()) {
      if (exercise.exercise_type === 'time') {
        let loggedSetsCount = 0;
        let allMet = true;
        for (let s = 0; s < exercise.target_sets; s++) {
          const t = completedTimers[`${exercise.id}-${s}`];
          if (t !== undefined && t !== null) {
            loggedSetsCount++;
            if (!t.met) allMet = false;
          } else {
            allMet = false;
          }
        }
        if (loggedSetsCount === exercise.target_sets && allMet) return 'green';
        if (loggedSetsCount > 0) return 'yellow';
        return 'neutral';
      }

      let loggedSetsCount = 0;
      let allRepsMetTarget = true;

      for (let s = 0; s < exercise.target_sets; s++) {
        const reps = trackedReps[`${exercise.id}-${s}`];
        if (reps !== undefined && reps !== null) {
          loggedSetsCount++;
          if (reps < exercise.target_reps) allRepsMetTarget = false;
        } else {
          allRepsMetTarget = false;
        }
      }

      if (loggedSetsCount === exercise.target_sets && allRepsMetTarget) {
        const weight = exercise.current_weight ?? 0;
        const best = exerciseAllTimeBests[exercise.id] ?? 0;
        if (weight > 0 && weight > best) return 'green';
        return 'yellow';
      }
      if (loggedSetsCount > 0) return 'yellow';
      return 'neutral';
    }

    const log = isViewingToday ? todayLogForDisplay() : viewedLog;
    if (log) return exerciseStatusFromLog(log, exercise);
    return 'neutral';
  }

  function getSetBubbleStatus(
    exerciseId: string,
    setIndex: number,
    targetReps?: number,
    timeExercise?: Exercise,
  ) {
    if (eraseRevertAnimating) return 'empty';
    const key = `${exerciseId}-${setIndex}`;

    if (isViewingToday && useLiveSessionTracking()) {
      if (targetReps !== undefined) {
        const reps = trackedReps[key];
        if (reps === undefined || reps === null) return 'empty';
        if (reps >= targetReps) return 'green';
        return 'yellow';
      }
      const t = completedTimers[key];
      if (!t) return 'empty';
      return t.met ? 'green' : 'yellow';
    }

    const log = isViewingToday ? todayLogForDisplay() : viewedLog;
    if (!log) return 'empty';

    if (targetReps !== undefined) {
      const reps = getHistoricalReps(log, exerciseId, setIndex);
      if (reps == null) return 'empty';
      if (reps >= targetReps) return 'green';
      return 'yellow';
    }

    const targetSecs = timeExercise
      ? (timeExercise.target_minutes || 0) * 60 + (timeExercise.target_seconds || 0)
      : undefined;
    const t = getHistoricalTime(log, exerciseId, setIndex, targetSecs);
    if (!t) return 'empty';
    return t.met ? 'green' : 'yellow';
  }

  // ============================================================
  // Helpers for new typed workout_snapshot shape (from updated db.ts)
  // Supports legacy snapshots during transition too.
  // ============================================================

  function getLoggedEx(log: any, exId: string) {
    const list = log?.workout_snapshot?.exercises || [];
    return list.find((e: any) => (e.exercise_id || e.id) === exId) || null;
  }

  function getHistoricalReps(log: any, exId: string, s: number): number | undefined {
    const ex = getLoggedEx(log, exId);
    if (!ex) return undefined;
    if (ex.sets && Array.isArray(ex.sets)) {
      return ex.sets[s]?.reps_completed ?? undefined;
    }
    return ex.performed_sets?.[s] ?? undefined;
  }

  function getHistoricalTime(
    log: any,
    exId: string,
    s: number,
    targetSecs?: number,
  ): { result: string; met: boolean } | undefined {
    const ex = getLoggedEx(log, exId);
    if (!ex) return undefined;
    let secs: number | null = null;
    if (ex.sets && Array.isArray(ex.sets)) {
      secs = ex.sets[s]?.seconds_completed ?? null;
    } else {
      const str = ex.performed_times?.[s];
      if (str) {
        const m = String(str).match(/(\d+)m(\d+)s/i);
        if (m) secs = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      }
    }
    if (secs == null) return undefined;
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const ss = (secs % 60).toString().padStart(2, '0');
    const met =
      targetSecs != null && targetSecs > 0 ? secs >= targetSecs : secs > 0;
    return { result: `${m}m${ss}s`, met };
  }

  function hydrateTrackingFromLog(log: any, template: Template | null) {
    const reps: Record<string, number> = {};
    const times: Record<string, { result: string; met: boolean }> = {};

    const perf = log?.performance_snapshot;
    if (perf?.reps) {
      for (const [key, val] of Object.entries(perf.reps)) {
        if (val != null) reps[key] = val as number;
      }
    }
    if (perf?.times) {
      for (const [key, entry] of Object.entries(perf.times)) {
        const e = entry as { result: string };
        const exId = key.split('-')[0];
        const ex = template?.exercises?.find((x) => x.id === exId);
        const targetSecs =
          ex && ex.exercise_type === 'time'
            ? (ex.target_minutes || 0) * 60 + (ex.target_seconds || 0)
            : 0;
        const match = e.result.match(/(\d+)m(\d+)s/i);
        const secs = match
          ? parseInt(match[1], 10) * 60 + parseInt(match[2], 10)
          : 0;
        times[key] = {
          result: e.result,
          met: targetSecs > 0 ? secs >= targetSecs : secs > 0,
        };
      }
    }

    for (const ex of log?.workout_snapshot?.exercises ?? []) {
      const exId = ex.exercise_id || ex.id;
      const templateEx = template?.exercises?.find((x) => x.id === exId);
      const targetSecs =
        templateEx && templateEx.exercise_type === 'time'
          ? (templateEx.target_minutes || 0) * 60 + (templateEx.target_seconds || 0)
          : 0;

      if (ex.sets && Array.isArray(ex.sets)) {
        for (let s = 0; s < ex.sets.length; s++) {
          const key = `${exId}-${s}`;
          const row = ex.sets[s];
          if (row?.reps_completed != null && reps[key] === undefined) {
            reps[key] = row.reps_completed;
          }
          if (row?.seconds_completed != null && times[key] === undefined) {
            const secs = row.seconds_completed;
            const m = Math.floor(secs / 60).toString().padStart(2, '0');
            const ss = (secs % 60).toString().padStart(2, '0');
            times[key] = {
              result: `${m}m${ss}s`,
              met: targetSecs > 0 ? secs >= targetSecs : secs > 0,
            };
          }
        }
      }
    }

    return { reps, times };
  }

  function templateForLog(log: any): Template | null {
    if (log?.template_id) {
      const match = templates.find((t) => t.id === log.template_id);
      if (match) return match;
    }
    if (log?.workout_snapshot?.template_name) {
      const byName = templates.find((t) => t.name === log.workout_snapshot.template_name);
      if (byName) return byName;
    }
    return activeTemplate;
  }

  function templateFromWorkoutLog(log: any): Template | null {
    const existing = templateForLog(log);
    if (existing) return existing;
    const snapEx = log?.workout_snapshot?.exercises;
    if (!snapEx?.length) return activeTemplate;
    return {
      id: log.template_id || 'snapshot',
      user_id: log.user_id || '',
      name:
        log.workout_snapshot?.template_name ||
        log.template_name_snapshot ||
        'Workout',
      exercises: snapEx.map(normalizeLoggedExForList),
    };
  }

  type ActiveSessionBackup = {
    date: string;
    templateId: string | null;
    templateName?: string;
    trackedReps: Record<string, number>;
    completedTimers: Record<string, { result: string; met: boolean }>;
    workoutStartedAt: number;
  };

  function writeActiveSessionBackup() {
    if (typeof sessionStorage === 'undefined') return;
    if (workoutState !== 'active' || !isViewingToday) {
      sessionStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      return;
    }
    const template = activeWorkoutTemplate ?? activeTemplate;
    const payload: ActiveSessionBackup = {
      date: REAL_TODAY_STR,
      templateId: template?.id ?? null,
      templateName: template?.name,
      trackedReps: { ...trackedReps },
      completedTimers: { ...completedTimers },
      workoutStartedAt: workoutStartedAt ?? Date.now(),
    };
    sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(payload));
  }

  function readActiveSessionBackup(): ActiveSessionBackup | null {
    if (typeof sessionStorage === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ActiveSessionBackup;
      if (parsed?.date !== REAL_TODAY_STR) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function clearActiveSessionBackup() {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  }

  function countLoggedSets(
    reps: Record<string, number>,
    times: Record<string, { result: string; met: boolean }>,
  ) {
    return Object.keys(reps).length + Object.keys(times).length;
  }

  function applyActiveSessionBackup(backup: ActiveSessionBackup): boolean {
    let template: Template | null =
      backup.templateId != null
        ? templates.find((t) => t.id === backup.templateId) ?? null
        : null;
    if (!template && backup.templateName) {
      template = templates.find((t) => t.name === backup.templateName) ?? null;
    }
    if (!template) template = activeTemplate;
    if (!template) return false;

    activeWorkoutTemplate = template;
    trackedReps = { ...backup.trackedReps };
    completedTimers = { ...backup.completedTimers };
    workoutState = 'active';
    restoreWorkoutTimerFromLog({
      performance_snapshot: {
        started_at: backup.workoutStartedAt,
        duration_seconds: 0,
      },
    });
    return true;
  }

  function tryRestoreActiveSessionFromStorageAndLog(): boolean {
    const backup = readActiveSessionBackup();

    if (todayLog && isWorkoutInProgress(todayLog)) {
      if (applyInProgressSessionFromLog(todayLog)) {
        if (
          backup &&
          countLoggedSets(backup.trackedReps, backup.completedTimers) >
            countLoggedSets(trackedReps, completedTimers)
        ) {
          applyActiveSessionBackup(backup);
          void persistWorkoutProgressNow();
        }
        return true;
      }
    }

    if (backup && applyActiveSessionBackup(backup)) {
      void persistWorkoutProgressNow();
      return true;
    }

    return false;
  }

  function restoreWorkoutTimerFromLog(log: any) {
    const perf = log?.performance_snapshot;
    const startedAt = perf?.started_at;
    const elapsed = perf?.duration_seconds ?? 0;
    if (startedAt != null) {
      workoutStartedAt = startedAt;
      workoutDuration = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    } else {
      workoutStartedAt = Date.now() - elapsed * 1000;
      workoutDuration = elapsed;
    }
    clearInterval(workoutTimer);
    workoutTimer = setInterval(() => {
      if (workoutStartedAt != null) {
        workoutDuration = Math.max(0, Math.round((Date.now() - workoutStartedAt) / 1000));
      }
    }, 1000);
  }

  function applyInProgressSessionFromLog(log: any) {
    const template = templateFromWorkoutLog(log);
    if (!template) return false;
    activeWorkoutTemplate = template;
    const { reps, times } = hydrateTrackingFromLog(log, template);
    trackedReps = reps;
    completedTimers = times;
    workoutState = 'active';
    restoreWorkoutTimerFromLog(log);
    return true;
  }

  function scheduleWorkoutProgressSave() {
    if (workoutState !== 'active' || !isViewingToday) return;
    writeActiveSessionBackup();
    if (workoutProgressSaveTimer) clearTimeout(workoutProgressSaveTimer);
    workoutProgressSaveTimer = setTimeout(() => {
      workoutProgressSaveTimer = null;
      void persistWorkoutProgressNow();
    }, WORKOUT_PROGRESS_SAVE_MS);
  }

  async function persistWorkoutProgressNow() {
    const saveGen = workoutProgressSaveGen;
    if (
      workoutState !== 'active' ||
      !isViewingToday ||
      workoutProgressSaveInFlight ||
      finishSyncPending
    ) {
      return;
    }
    const template = activeWorkoutTemplate ?? activeTemplate;
    if (!template) return;

    const perf = {
      reps: { ...trackedReps },
      times: Object.fromEntries(
        Object.entries(completedTimers).map(([k, v]) => [k, { result: v.result }]),
      ),
    };
    const startedAt = workoutStartedAt ?? Date.now();

    workoutProgressSaveInFlight = true;
    try {
      await db.saveWorkoutProgress(template, perf, workoutDuration, startedAt);
      if (saveGen !== workoutProgressSaveGen || workoutState !== 'active' || finishSyncPending) {
        return;
      }
      const refreshed = await db.getLogForDate(REAL_TODAY_STR);
      if (
        saveGen !== workoutProgressSaveGen ||
        workoutState !== 'active' ||
        finishSyncPending ||
        !refreshed
      ) {
        return;
      }
      todayLog = refreshed;
      weekLogs = { ...weekLogs, [REAL_TODAY_STR]: refreshed };
      viewedLog = refreshed;
    } catch (err) {
      console.error('workout progress save failed', err);
    } finally {
      workoutProgressSaveInFlight = false;
    }
  }

  function flushWorkoutProgressSave() {
    if (workoutProgressSaveTimer) {
      clearTimeout(workoutProgressSaveTimer);
      workoutProgressSaveTimer = null;
    }
    void persistWorkoutProgressNow();
  }

  /** Green / yellow / neutral from a saved workout_snapshot (typed `sets[]` or legacy arrays). */
  function completionStatusFromSnapshot(snap: any): 'green' | 'yellow' | 'neutral' {
    if (snap?.skipped) return 'neutral';
    if (!snap?.exercises?.length) return 'neutral';
    let totalSets = 0;
    let greenSets = 0;
    let doneSets = 0;
    for (const ex of snap.exercises) {
      const setCount = ex.target_sets || 0;
      totalSets += setCount;
      const targetReps = ex.target_reps || 0;
      const targetSecs = (ex.target_minutes || 0) * 60 + (ex.target_seconds || 0);

      if (ex.sets && Array.isArray(ex.sets)) {
        for (let s = 0; s < setCount; s++) {
          const row = ex.sets[s];
          if (!row) continue;
          if (ex.exercise_type === 'reps' || row.reps_completed != null) {
            const val = row.reps_completed;
            if (val != null) {
              doneSets++;
              if (val >= targetReps) greenSets++;
            }
          } else {
            const secs = row.seconds_completed;
            if (secs != null && !Number.isNaN(secs)) {
              doneSets++;
              if (secs >= targetSecs) greenSets++;
            }
          }
        }
        continue;
      }

      if (ex.exercise_type === 'reps' || ex.performed_sets) {
        const performed: (number | null)[] = ex.performed_sets || [];
        for (let s = 0; s < setCount; s++) {
          const val = performed[s];
          if (val != null) {
            doneSets++;
            if (val >= targetReps) greenSets++;
          }
        }
      } else if (ex.exercise_type === 'time' || ex.performed_times) {
        const performed: (string | null)[] = ex.performed_times || [];
        for (let s = 0; s < setCount; s++) {
          const res = performed[s];
          if (res) {
            doneSets++;
            const m = res.match(/(\d+)m(\d+)s/);
            if (m) {
              const secs = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
              if (secs >= targetSecs) greenSets++;
            }
          }
        }
      }
    }
    if (totalSets === 0) return 'yellow';
    if (greenSets === totalSets) return 'green';
    if (doneSets > 0) return 'yellow';
    return 'neutral';
  }

  function normalizeLoggedExForList(e: any) {
    if (!e) return e;
    return {
      ...e,
      id: e.exercise_id || e.id,
      current_weight: e.weight_before ?? e.current_weight ?? null,
    };
  }

  function countTemplateSets(tpl: Template): number {
    return tpl.exercises.reduce((sum, ex) => sum + (ex.target_sets || 0), 0);
  }

  function countPerfLoggedSets(log: any): number {
    const perf = log?.performance_snapshot;
    if (!perf) return 0;
    return Object.keys(perf.reps ?? {}).length + Object.keys(perf.times ?? {}).length;
  }

  function countSnapshotSetProgress(log: any): { logged: number; total: number } {
    let logged = 0;
    let total = 0;
    for (const ex of log?.workout_snapshot?.exercises ?? []) {
      const setCount = ex.target_sets || ex.sets?.length || 0;
      total += setCount;
      if (ex.sets && Array.isArray(ex.sets)) {
        for (let s = 0; s < setCount; s++) {
          const row = ex.sets[s];
          if (!row) continue;
          if (row.reps_completed != null || (row.seconds_completed != null && !Number.isNaN(row.seconds_completed))) {
            logged++;
          }
        }
        continue;
      }
      if (ex.performed_sets) {
        logged += ex.performed_sets.filter((v: number | null) => v != null).length;
        continue;
      }
      if (ex.performed_times) {
        logged += ex.performed_times.filter((v: string | null) => v).length;
      }
    }
    return { logged, total };
  }

  function formatBootDuration(seconds: number | null | undefined): string | null {
    if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    if (m <= 0) return `${s}s`;
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  }

  function authProviderLabel(user: any): string {
    if (isUsernameAccount(user)) return 'Username';
    const id = user?.identities?.[0]?.provider ?? user?.app_metadata?.provider;
    if (!id || id === 'email') return 'Email';
    return String(id).charAt(0).toUpperCase() + String(id).slice(1);
  }

  function supabaseProjectLabel(): string {
    try {
      const host = new URL(PUBLIC_SUPABASE_URL).hostname;
      const ref = host.split('.')[0];
      return ref ? `${ref}.supabase.co` : host;
    } catch {
      return 'Supabase';
    }
  }

  type BootBackendPhase = 'checking' | 'syncing' | 'ready' | 'error';

  function buildBackendBootLines(
    user: any | null,
    opts: {
      phase: BootBackendPhase;
      scheduleCount?: number;
      templateCount?: number;
      hasTodayLog?: boolean;
      recentCount?: number;
      error?: string;
    },
  ): string[] {
    const lines = [`Project · ${supabaseProjectLabel()}`];
    if (opts.phase === 'checking') {
      lines.push('Auth · verifying saved session…');
      lines.push('API · waiting for connection…');
    } else if (user) {
      const uid = user.id ? `${String(user.id).slice(0, 8)}…` : '—';
      lines.push(`Auth · session active · ${uid}`);
      lines.push(`Provider · ${authProviderLabel(user)}`);
      if (opts.phase === 'syncing') {
        lines.push('API · schedule, templates, workout_history');
        lines.push('RLS · scoped to your user id');
      } else if (opts.phase === 'ready') {
        lines.push('API · connected');
        lines.push(
          `Tables · schedule (${opts.scheduleCount ?? 0}), templates (${opts.templateCount ?? 0}), history (${opts.recentCount ?? 0} recent)`,
        );
        lines.push(
          opts.hasTodayLog
            ? "Today's log · row in workout_history"
            : "Today's log · none yet",
        );
      } else if (opts.phase === 'error') {
        lines.push(`API · ${opts.error ?? 'sync failed'}`);
      }
    } else {
      lines.push('Auth · no saved session');
      lines.push('Sign in to sync your library and logs');
    }
    lines.push('Client · PKCE · persisted session');
    return lines;
  }

  function buildSyncBootLines(phase: 'pending' | 'active' | 'done' | 'error'): string[] {
    const steps = [
      { key: 'schedule', label: 'schedule' },
      { key: 'templates', label: 'templates + exercises' },
      { key: 'today', label: "today's workout_history row" },
      { key: 'history', label: 'recent logs (21 days)' },
    ];
    if (phase === 'pending') {
      return [
        'PostgREST parallel fetch',
        ...steps.map((s) => `· ${s.label}`),
      ];
    }
    if (phase === 'active') {
      return [
        'Querying Supabase…',
        ...steps.map((s) => `· ${s.label} — in flight`),
      ];
    }
    if (phase === 'error') {
      return ['Sync failed — check connection or sign in again', ...steps.map((s) => `· ${s.label} — not loaded`)];
    }
    return [
      'Sync complete',
      ...steps.map((s) => `· ${s.label} — ok`),
    ];
  }

  function formatRecentLogBootLine(log: WorkoutHistory): string {
    const d = new Date(`${log.workout_date}T12:00:00`);
    const label = d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const prefix = log.workout_date === REAL_TODAY_STR ? `${label} (today)` : label;

    if (logIsSkipped(log)) return `${prefix} — skipped`;
    if (log.workout_snapshot?.is_rest) return `${prefix} — rest day`;
    if (isWorkoutInProgress(log)) {
      const logged = countPerfLoggedSets(log);
      const extra = logged > 0 ? ` · ${logged} set${logged === 1 ? '' : 's'} so far` : '';
      return `${prefix} — in progress${extra}`;
    }

    const name = log.template_name_snapshot || log.workout_snapshot?.template_name || 'Workout';
    const snap = log.workout_snapshot;
    const status = snap ? completionStatusFromSnapshot(snap) : 'neutral';
    const tag =
      status === 'green' ? 'complete' : status === 'yellow' ? 'partial' : 'logged';
    const dur = formatBootDuration(
      log.duration_seconds ?? log.performance_snapshot?.duration_seconds ?? snap?.duration_seconds,
    );
    const bits = [name, tag];
    if (dur) bits.push(dur);
    if (log.is_perfect_day) bits.push('perfect');
    return `${prefix} — ${bits.join(' · ')}`;
  }

  function buildRecentLogsBootLines(logs: WorkoutHistory[]): string[] {
    const lines: string[] = [];
    const cutoff = new Date(REAL_TODAY);
    cutoff.setDate(cutoff.getDate() - 13);
    const cutoffStr = toDateStr(cutoff);
    const last14 = logs.filter((l) => l.workout_date >= cutoffStr && l.workout_date <= REAL_TODAY_STR);
    const workouts = last14.filter(
      (l) => !logIsSkipped(l) && !l.workout_snapshot?.is_rest && !isWorkoutInProgress(l),
    ).length;
    const skipped = last14.filter((l) => logIsSkipped(l)).length;
    const inProgress = last14.filter((l) => isWorkoutInProgress(l)).length;
    const perfect = last14.filter((l) => l.is_perfect_day).length;
    lines.push(
      `Last 14 days · ${workouts} done, ${skipped} skipped, ${inProgress} active, ${perfect} perfect`,
    );
    if (logs.length === 0) {
      lines.push('No rows in workout_history yet');
      lines.push('Finished sessions will show up here after sync');
      return lines;
    }
    const maxLines = 7;
    for (const log of logs.slice(0, maxLines)) {
      lines.push(formatRecentLogBootLine(log));
    }
    if (logs.length > maxLines) {
      lines.push(`+ ${logs.length - maxLines} older entr${logs.length - maxLines === 1 ? 'y' : 'ies'} in database`);
    }
    return lines;
  }

  function buildGuestBootSections(): BootSection[] {
    return [
      {
        title: 'Backend',
        lines: buildBackendBootLines(null, { phase: 'checking' }),
      },
      {
        title: 'Session',
        lines: [
          'Looking for a saved sign-in…',
          'OAuth callback and PKCE tokens checked on load',
        ],
      },
      {
        title: 'Sync',
        lines: buildSyncBootLines('pending'),
      },
    ];
  }

  function buildAuthBootSections(user: any, syncPhase: 'checking' | 'syncing' = 'syncing'): BootSection[] {
    if (!user) {
      return buildGuestBootSections();
    }
    const acct = [
      getAuthDisplayName(user),
      `Sign-in · ${authProviderLabel(user)}`,
    ];
    const since = user.created_at
      ? `Member since ${new Date(user.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`
      : null;
    if (since) acct.push(since);
    return [
      { title: 'Account', lines: acct },
      {
        title: 'Backend',
        lines: buildBackendBootLines(user, {
          phase: syncPhase === 'checking' ? 'checking' : 'syncing',
        }),
      },
      {
        title: 'Sync',
        lines: buildSyncBootLines(syncPhase === 'checking' ? 'pending' : 'active'),
      },
    ];
  }

  function buildBootSections(
    user: any,
    sched: typeof schedule,
    tpls: Template[],
    log: typeof todayLog,
    recentLogs: WorkoutHistory[] = [],
  ): BootSection[] {
    const sections: BootSection[] = [];
    const templateCount = tpls.length;
    const exerciseCount = tpls.reduce((sum, t) => sum + (t.exercises?.length ?? 0), 0);
    const totalLibrarySets = tpls.reduce((sum, t) => sum + countTemplateSets(t), 0);
    const assignedRows = sched.filter((s) => s.template_id);
    const restDays = 7 - assignedRows.length;

    if (user) {
      const acct = [
        getAuthDisplayName(user),
        `Sign-in · ${authProviderLabel(user)}`,
      ];
      const since = user.created_at
        ? `Member since ${new Date(user.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`
        : null;
      if (since) acct.push(since);
      sections.push({ title: 'Account', lines: acct });
    }

    sections.push({
      title: 'Backend',
      lines: buildBackendBootLines(user, {
        phase: 'ready',
        scheduleCount: sched.length,
        templateCount: tpls.length,
        hasTodayLog: !!log,
        recentCount: recentLogs.length,
      }),
    });

    sections.push({ title: 'Sync', lines: buildSyncBootLines('done') });

    const libraryLines = [
      `${templateCount} template${templateCount === 1 ? '' : 's'} · ${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'} · ${totalLibrarySets} sets`,
    ];
    const maxTplLines = 6;
    for (const tpl of tpls.slice(0, maxTplLines)) {
      const sets = countTemplateSets(tpl);
      const reps = tpl.exercises.filter((e) => e.exercise_type === 'reps').length;
      const timed = tpl.exercises.length - reps;
      const mix =
        reps > 0 && timed > 0
          ? `${reps} rep, ${timed} timed`
          : timed > 0
            ? `${timed} timed`
            : `${reps} rep`;
      libraryLines.push(`${tpl.name} — ${tpl.exercises.length} exercises (${mix}), ${sets} sets`);
    }
    if (templateCount > maxTplLines) {
      libraryLines.push(`+ ${templateCount - maxTplLines} more template${templateCount - maxTplLines === 1 ? '' : 's'}`);
    }
    if (templateCount === 0) {
      libraryLines.push('No templates yet — create one in the routine editor');
    }
    sections.push({ title: 'Library', lines: libraryLines });

    const weekLines = [
      `${assignedRows.length} workout day${assignedRows.length === 1 ? '' : 's'}, ${restDays} rest day${restDays === 1 ? '' : 's'}`,
    ];
    for (const row of sched) {
      const letter = DAYS[row.day_of_week];
      if (row.template_id) {
        const tpl = tpls.find((t) => t.id === row.template_id);
        weekLines.push(`${letter} — ${tpl?.name ?? 'Workout'}`);
      } else {
        weekLines.push(`${letter} — rest`);
      }
    }
    sections.push({ title: 'Weekly plan', lines: weekLines });

    const dayRow = sched.find((s) => s.day_of_week === TODAY_WEEKDAY);
    const todayTpl = dayRow?.template_id
      ? tpls.find((t) => t.id === dayRow.template_id)
      : null;
    const todayDateLabel = REAL_TODAY.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
    const todayLines: string[] = [todayDateLabel];

    if (todayTpl) {
      const todaySets = countTemplateSets(todayTpl);
      todayLines.push(
        `Scheduled: ${todayTpl.name} — ${todayTpl.exercises.length} exercises, ${todaySets} sets`,
      );
    } else {
      todayLines.push('Scheduled: rest day (no template assigned)');
    }

    if (logIsSkipped(log)) {
      todayLines.push('Status: workout skipped');
    } else if (log && isWorkoutInProgress(log)) {
      const logged = countPerfLoggedSets(log);
      const dur = formatBootDuration(log.performance_snapshot?.duration_seconds);
      todayLines.push('Status: workout in progress');
      if (logged > 0) todayLines.push(`${logged} set${logged === 1 ? '' : 's'} logged so far`);
      if (dur) todayLines.push(`Timer at ${dur}`);
    } else if (log?.workout_snapshot?.is_rest) {
      todayLines.push('Status: logged as rest');
    } else if (log) {
      const name = log.template_name_snapshot || log.workout_snapshot?.template_name || 'Workout';
      const snap = log.workout_snapshot;
      const status = snap ? completionStatusFromSnapshot(snap) : 'neutral';
      const { logged, total } = countSnapshotSetProgress(log);
      const dur = formatBootDuration(
        log.duration_seconds ?? log.performance_snapshot?.duration_seconds ?? snap?.duration_seconds,
      );
      if (status === 'green') {
        todayLines.push(`Status: ${name} complete — all targets hit`);
      } else if (status === 'yellow') {
        todayLines.push(`Status: ${name} logged — some sets below target`);
      } else {
        todayLines.push(`Status: ${name} logged`);
      }
      if (total > 0) {
        todayLines.push(`${logged} of ${total} sets recorded`);
      }
      if (dur) todayLines.push(`Duration: ${dur}`);
      if (log.is_perfect_day) todayLines.push('Perfect day recorded');
    } else if (todayTpl) {
      todayLines.push('Status: ready to start');
    }

    let opening = 'Opening today\'s workout view';
    if (logIsSkipped(log)) opening = 'Opening skipped workout';
    else if (log && isWorkoutInProgress(log)) opening = 'Resuming your in-progress workout';
    else if (log?.workout_snapshot?.is_rest) opening = 'Opening rest day log';
    else if (log) opening = 'Opening completed workout log';
    else if (!todayTpl) opening = 'Opening rest day';

    const backup = readActiveSessionBackup();
    if (backup) {
      todayLines.push('Local backup · in-progress session on this device');
    }

    sections.push({ title: 'Today', lines: todayLines });
    sections.push({ title: 'Recent logs', lines: buildRecentLogsBootLines(recentLogs) });
    sections.push({ title: 'Ready', lines: [opening] });

    return sections;
  }

 async function loadData(options: { preserveSession?: boolean } = {}) {
		const isInitial = !hasInitialLoad;
		if (isInitial) {
			isLoading = true;
			bootMessage = 'Loading your workout data…';
			bootSections = currentUser ? buildAuthBootSections(currentUser) : [];
		} else {
			isSyncing = true;
		}
		try {
			bootMessage = 'Syncing schedule and templates…';
			if (isInitial && currentUser) {
				bootSections = buildAuthBootSections(currentUser, 'syncing');
			}
			const [data, recentLogs] = await Promise.all([
				db.getAppData(),
				db.getRecentHistory(21).catch((e) => {
					console.error('Recent history fetch failed', e);
					return [] as WorkoutHistory[];
				}),
			]);
			schedule = data.schedule;
			templates = data.templates;
			todayLog = data.todayLog || null;
			if (isInitial) {
				bootSections = buildBootSections(currentUser, schedule, templates, todayLog, recentLogs);
				bootMessage = 'Almost ready…';
			}
			const prTemplate =
				activeWorkoutTemplate ??
				(workoutState === 'active' ? activeTemplate : null) ??
				activeTemplate;
			if (prTemplate?.exercises?.length) {
				void refreshExerciseAllTimeBests(prTemplate.exercises);
			}
			if (!options.preserveSession) {
				if (!todayLog) {
					workoutState = 'idle';
					activeWorkoutTemplate = null;
				} else if (logIsSkipped(todayLog)) {
					workoutState = 'skipped';
					activeWorkoutTemplate = null;
				} else if (
					isWorkoutInProgress(todayLog) ||
					(!todayLog && readActiveSessionBackup())
				) {
					if (!tryRestoreActiveSessionFromStorageAndLog()) {
						workoutState = 'idle';
						activeWorkoutTemplate = null;
						clearActiveSessionBackup();
					}
				} else {
					workoutState = 'done';
					activeWorkoutTemplate = null;
				}
				justFinishedStatus = null;
			}
			// sync today + week cache + viewed on (re)load
			weekLogs = { ...weekLogs, [REAL_TODAY_STR]: todayLog };
			if (isViewingToday) {
				viewedLog = todayLog;
			}
		} catch (err) {
			console.error(err);
			if (isInitial && currentUser) {
				bootSections = [
					...buildAuthBootSections(currentUser, 'syncing').filter((s) => s.title !== 'Sync'),
					{
						title: 'Backend',
						lines: buildBackendBootLines(currentUser, {
							phase: 'error',
							error: formatDbError(err),
						}),
					},
					{ title: 'Sync', lines: buildSyncBootLines('error') },
				];
				bootMessage = 'Sync failed — retrying when ready…';
			}
			if (!options.preserveSession) {
				workoutState = 'idle';
				justFinishedStatus = null;
			}
		} finally {
			isLoading = false;
			isSyncing = false;
			hasInitialLoad = true;
		}
	}

  onMount(() => {
    updateClock();
    const clockInterval = setInterval(updateClock, 50);

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      void (async () => {
        if (session?.user) {
          const { data: { user }, error } = await supabase.auth.getUser();
          if (error || !user) {
            currentUser = null;
            if (error) await supabase.auth.signOut();
          } else {
            currentUser = user;
          }
        } else {
          currentUser = null;
        }

        if (
          event === 'INITIAL_SESSION' ||
          event === 'SIGNED_IN' ||
          event === 'SIGNED_OUT' ||
          event === 'TOKEN_REFRESHED'
        ) {
          isAuthLoading = false;
        }

        if (currentUser && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
          bootMessage = 'Welcome back — loading data…';
          bootSections = buildAuthBootSections(currentUser);
          loadData();
        }

        if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') {
          resetAccountPanelUi();
        }

        if (!currentUser && (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION')) {
          schedule = [];
          templates = [];
          todayLog = null;
          viewedLog = null;
          weekLogs = {};
          workoutState = 'idle';
          justFinishedStatus = null;
          currentView = 'track';
          hasInitialLoad = false;
          isLoading = false;
          bootMessage = 'Checking session…';
          bootSections = [];
        }
      })();
    });

    const redirectErr = getAuthRedirectError();
    if (redirectErr) authError = redirectErr;

    void (async () => {
      try {
        // Handle legacy redirects that land on / with ?code= (redirectTo was origin)
        await db.handleAuthCallback();
      } catch (e) {
        console.error('Auth callback failed', e);
        authError = formatAuthError(e);
      }
      try {
        await supabase.auth.getSession();
      } catch (e) {
        console.error('getSession failed', e);
        isAuthLoading = false;
      }
    })();

    const onPageHide = () => {
      if (document.visibilityState === 'hidden') flushWorkoutProgressSave();
    };
    document.addEventListener('visibilitychange', onPageHide);

    return () => {
      clearInterval(clockInterval);
      subscription.unsubscribe();
      document.removeEventListener('visibilitychange', onPageHide);
    };
  });
  onDestroy(() => {
    flushWorkoutProgressSave();
    if (workoutProgressSaveTimer) clearTimeout(workoutProgressSaveTimer);
    clearInterval(workoutTimer);
    clearInterval(countdownTimer);
    cancelRepSetHold();
    cancelStartWorkoutAnim();
    stopEraseRevertAnim();
    stopCancelRevertAnim();
    stopSkipRevertAnim();
  });

  function pulseEraseTapFlash() {
    tapPulseGen.erase++;
    const gen = tapPulseGen.erase;
    eraseTapPulseActive = false;
    requestAnimationFrame(() => {
      if (gen !== tapPulseGen.erase || (workoutState !== 'done' && workoutState !== 'skipped')) return;
      eraseTapPulseActive = true;
    });
  }

  function onEraseTapPulseEnd(e: AnimationEvent) {
    if (e.animationName === 'hold-cancel-tap-pulse') eraseTapPulseActive = false;
  }

  function computeWorkoutFinishStatus(
    template: Template,
    snapshot: { reps: Record<string, number>; times: Record<string, { result: string; met: boolean }> },
  ): 'green' | 'yellow' {
    let total = 0;
    let green = 0;
    let done = 0;
    for (const ex of template.exercises) {
      total += ex.target_sets || 0;
      for (let i = 0; i < (ex.target_sets || 0); i++) {
        const k = `${ex.id}-${i}`;
        if (ex.exercise_type === 'reps') {
          const reps = snapshot.reps[k];
          if (reps != null) {
            done++;
            if (reps >= (ex.target_reps || 0)) green++;
          }
        } else {
          const t = snapshot.times[k];
          if (t != null) {
            done++;
            if (t.met) green++;
          }
        }
      }
    }
    if (total > 0 && green === total) return 'green';
    return 'yellow';
  }

  function startWorkout() {
    if (!isViewingToday || workoutState === 'done' || workoutState === 'skipped') return;
    const template = activeTemplate;
    if (!template) {
      workoutActionError = 'No template assigned for today.';
      return;
    }
    workoutActionError = null;
    clearCtaTapPulses();
    stopSkipHold();
    activeWorkoutTemplate = template;
    workoutProgressSaveGen++;
    finishSyncPending = false;
    workoutState = 'active';
    trackedReps = {}; 
    completedTimers = {};
    workoutDuration = 0;
    workoutStartedAt = Date.now();
    clearInterval(workoutTimer);
    clearInterval(countdownTimer);
    activeTimerExerciseId = null;
    activeTimerSetIndex = null;
    countdownSeconds = 0;
    countdownRunning = false;
    skipProgress = 0;
    cancelProgress = 0;
    deleteTemplateProgress = 0;
    eraseProgress = 0;
    justFinishedStatus = null;
    workoutTimer = setInterval(() => { workoutDuration++; }, 1000);
    writeActiveSessionBackup();
    void persistWorkoutProgressNow();
    scheduleWorkoutProgressSave();
    void refreshExerciseAllTimeBests(template.exercises);
  }

  /** DB rejects duration_seconds = 0 on completed workouts. */
  function workoutElapsedSeconds(): number {
    const seconds =
      workoutStartedAt != null
        ? Math.round((Date.now() - workoutStartedAt) / 1000)
        : workoutDuration;
    return Math.max(1, seconds);
  }

  function applyCancelWorkoutState() {
    stopFinishHold();
    if (workoutProgressSaveTimer) {
      clearTimeout(workoutProgressSaveTimer);
      workoutProgressSaveTimer = null;
    }
    workoutProgressSaveGen++;
    finishSyncPending = false;
    clearActiveSessionBackup();
    workoutState = 'idle';
    activeWorkoutTemplate = null;
    workoutActionError = null;
    trackedReps = {};
    completedTimers = {};
    if (isViewingToday && todayLog && isWorkoutInProgress(todayLog)) {
      todayLog = null;
      weekLogs = { ...weekLogs, [REAL_TODAY_STR]: null };
      viewedLog = null;
      void db.deleteWorkoutLog().catch((err) => console.error('cancel draft delete failed', err));
    }
    clearInterval(workoutTimer);
    clearInterval(countdownTimer);
    workoutDuration = 0;
    workoutStartedAt = null;
    countdownSeconds = 0;
    countdownRunning = false;
    activeTimerExerciseId = null;
    activeTimerSetIndex = null;
    skipProgress = 0;
    cancelProgress = 0;
    deleteTemplateProgress = 0;
    eraseProgress = 0;
    justFinishedStatus = null;
  }

  function finishWorkout() {
    const template = activeWorkoutTemplate ?? activeTemplate;
    if (!template) {
      workoutActionError = 'No template to log this workout against.';
      return;
    }

    workoutActionError = null;
    clearInterval(workoutTimer);
    clearInterval(countdownTimer);
    countdownRunning = false;
    activeTimerExerciseId = null;
    activeTimerSetIndex = null;
    countdownSeconds = 0;
    skipProgress = 0;
    cancelProgress = 0;
    deleteTemplateProgress = 0;
    eraseProgress = 0;
    finishHoldProgress = 0;

    const snapshot = {
      reps: { ...trackedReps },
      times: { ...completedTimers },
    };
    const duration = workoutElapsedSeconds();
    const justFinished = computeWorkoutFinishStatus(template, snapshot);

    justFinishedStatus = justFinished;
    finishFadeWasPerfect = isPerfectDay;
    if (workoutProgressSaveTimer) {
      clearTimeout(workoutProgressSaveTimer);
      workoutProgressSaveTimer = null;
    }
    workoutProgressSaveGen++;
    finishSyncPending = true;
    clearActiveSessionBackup();
    activeWorkoutTemplate = null;
    workoutState = 'done';
    startFinishCenterFade();

    void syncWorkoutFinish(template, snapshot, duration);
  }

  async function syncWorkoutFinish(
    template: Template,
    snapshot: { reps: Record<string, number>; times: Record<string, { result: string; met: boolean }> },
    duration: number,
  ) {
    try {
      await db.submitWorkoutSession(template, snapshot, duration);
      workoutProgressSaveGen++;
      await loadData({ preserveSession: true });
    } catch (err) {
      console.error('finish workout failed', err);
      workoutActionError = formatDbError(err);
      await loadData({ preserveSession: true });
    } finally {
      finishSyncPending = false;
      justFinishedStatus = null;
      clearActiveSessionBackup();
    }
  }

  function cancelRepSetHold() {
    if (repSetHoldTimer) clearInterval(repSetHoldTimer);
    repSetHoldTimer = null;
    repSetHoldKey = null;
    repSetHoldFired = false;
    repSetHoldProgress = 0;
  }

  function beginRepSetEdit(exerciseId: string, setIndex: number) {
    if (workoutState !== 'active') return;
    const key = `${exerciseId}-${setIndex}`;
    editingSetKey = key;
    tick().then(() => {
      const inputEl = document.getElementById(`input-${key}`) as HTMLInputElement;
      if (inputEl) {
        inputEl.focus();
        inputEl.select();
      }
    });
  }

  function startRepSetHold(
    e: Event,
    exerciseId: string,
    setIndex: number,
    targetReps: number,
  ) {
    if (e.cancelable) e.preventDefault();
    if (workoutState !== 'active' || !isViewingToday) return;
    cancelRepSetHold();
    const key = `${exerciseId}-${setIndex}`;
    repSetHoldKey = key;
    repSetHoldFired = false;
    repSetHoldProgress = 0;
    const startTime = Date.now();
    repSetHoldTimer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      repSetHoldProgress = Math.min((elapsed / REP_SET_HOLD_MS) * 100, 100);
      if (elapsed >= REP_SET_HOLD_MS) {
        if (repSetHoldTimer) clearInterval(repSetHoldTimer);
        repSetHoldTimer = null;
        repSetHoldFired = true;
        trackedReps[key] = targetReps;
        if (editingSetKey === key) editingSetKey = null;
        repSetHoldProgress = 0;
        repSetHoldKey = null;
        scheduleWorkoutProgressSave();
      }
    }, 20);
  }

  function stopRepSetHold(exerciseId: string, setIndex: number) {
    const key = `${exerciseId}-${setIndex}`;
    if (repSetHoldKey !== key) return;
    if (repSetHoldTimer) clearInterval(repSetHoldTimer);
    repSetHoldTimer = null;
    repSetHoldKey = null;
    repSetHoldProgress = 0;
    if (!repSetHoldFired) beginRepSetEdit(exerciseId, setIndex);
    repSetHoldFired = false;
  }

  function saveManualRepEdit(exerciseId: string, setIndex: number) {
    const key = `${exerciseId}-${setIndex}`;
    const inputEl = document.getElementById(`input-${key}`) as HTMLInputElement;
    if (inputEl) {
      const value = parseInt(inputEl.value);
      if (!isNaN(value) && value >= 0) trackedReps[key] = value;
      else if (inputEl.value === '') delete trackedReps[key];
      scheduleWorkoutProgressSave();
    }
    editingSetKey = null;
  }

  function startTimedSet(exerciseId: string, setIndex: number) {
    clearInterval(countdownTimer);
    activeTimerExerciseId = exerciseId;
    activeTimerSetIndex = setIndex;
    countdownSeconds = 0;
    countdownRunning = true;
    countdownTimer = setInterval(() => { countdownSeconds++; }, 1000);
  }

  function toggleExerciseTimer() {
    if (countdownRunning) {
      clearInterval(countdownTimer);
      countdownRunning = false;
    } else {
      countdownRunning = true;
      countdownTimer = setInterval(() => { countdownSeconds++; }, 1000);
    }
  }

  function stopAndSaveTimedSet(exerciseId: string, setIndex: number, targetSeconds: number) {
    clearInterval(countdownTimer);
    countdownRunning = false;
    const key = `${exerciseId}-${setIndex}`;
    completedTimers[key] = {
      result: `${Math.floor(countdownSeconds / 60).toString().padStart(2, '0')}m${(countdownSeconds % 60).toString().padStart(2, '0')}s`,
      met: countdownSeconds >= targetSeconds
    };
    activeTimerExerciseId = null;
    activeTimerSetIndex = null;
    countdownSeconds = 0;
    scheduleWorkoutProgressSave();
  }

  function cancelActiveTimer() {
    clearInterval(countdownTimer);
    countdownRunning = false;
    activeTimerExerciseId = null;
    activeTimerSetIndex = null;
    countdownSeconds = 0;
  }

  function clearCtaTapPulses() {
    tapPulseGen.skip++;
    tapPulseGen.cancel++;
    tapPulseGen.erase++;
    cancelStartWorkoutAnim();
    stopEraseRevertAnim();
    stopCancelRevertAnim();
    stopSkipRevertAnim();
    skipTapPulseActive = false;
    cancelTapPulseActive = false;
    eraseTapPulseActive = false;
  }

  function pulseSkipTapFlash() {
    tapPulseGen.skip++;
    const gen = tapPulseGen.skip;
    skipTapPulseActive = false;
    requestAnimationFrame(() => {
      if (gen !== tapPulseGen.skip || workoutState !== 'idle') return;
      skipTapPulseActive = true;
    });
  }

  function pulseCancelTapFlash() {
    tapPulseGen.cancel++;
    const gen = tapPulseGen.cancel;
    cancelTapPulseActive = false;
    requestAnimationFrame(() => {
      if (gen !== tapPulseGen.cancel || workoutState !== 'active') return;
      cancelTapPulseActive = true;
    });
  }

  function onSkipTapPulseEnd(e: AnimationEvent) {
    if (e.animationName === 'hold-skip-tap-pulse') skipTapPulseActive = false;
  }

  function onCancelTapPulseEnd(e: AnimationEvent) {
    if (e.animationName === 'hold-cancel-tap-pulse') cancelTapPulseActive = false;
  }

  function randomStartCtaChar() {
    return START_CTA_SCRAMBLE_CHARS[Math.floor(Math.random() * START_CTA_SCRAMBLE_CHARS.length)]!;
  }

  /** Glitch text: length interpolates source→target; spaces preserved; target locks L→R. */
  function computeCtaScramble(progress: number, source: string, target: string): string {
    if (progress >= 1) return target;
    const p = Math.min(Math.max(progress, 0), 1);
    const len = ctaLengthAt(p, source, target);
    const glitchStart = 0.3;
    let out = '';
    for (let i = 0; i < len; i++) {
      const src = source[i];
      const tgt = target[i];
      if (p < glitchStart) {
        if (src === ' ') out += ' ';
        else if (src === undefined) out += randomStartCtaChar();
        else {
          const hold = glitchStart * (0.06 + (i / Math.max(len, 1)) * 0.75);
          out += p < hold ? src : randomStartCtaChar();
        }
        continue;
      }
      const lockP = (p - glitchStart) / (1 - glitchStart);
      const lockCount = Math.floor(lockP * target.length);
      if (i < lockCount && tgt !== undefined) out += tgt === ' ' ? ' ' : tgt;
      else if (tgt === ' ') out += ' ';
      else out += randomStartCtaChar();
    }
    return out;
  }

  function stopStartCtaScramble(resetLabels = true) {
    if (startCtaScrambleRaf) cancelAnimationFrame(startCtaScrambleRaf);
    startCtaScrambleRaf = 0;
    if (resetLabels) {
      startCtaLabel = START_CTA_SOURCE;
      sideCtaLabel = SKIP_CTA_SOURCE;
    }
  }

  function startStartCtaScramble() {
    stopStartCtaScramble(true);
    const animStart = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - animStart) / START_WORKOUT_ANIM_MS, 1);
      if (progress >= 1) {
        startCtaLabel = START_CTA_TARGET;
        sideCtaLabel = SKIP_CTA_TARGET;
        startCtaScrambleRaf = 0;
        return;
      }
      startCtaLabel = computeCtaScramble(progress, START_CTA_SOURCE, START_CTA_TARGET);
      sideCtaLabel = computeCtaScramble(progress, SKIP_CTA_SOURCE, SKIP_CTA_TARGET);
      startCtaScrambleRaf = requestAnimationFrame(tick);
    };
    startCtaScrambleRaf = requestAnimationFrame(tick);
  }

  function cancelStartWorkoutAnim() {
    if (startWorkoutAnimTimer) clearTimeout(startWorkoutAnimTimer);
    startWorkoutAnimTimer = null;
    startWorkoutAnimating = false;
    stopStartCtaScramble();
  }

  function eraseRevertCenterSource(): string {
    return workoutState === 'skipped' ? SKIPPED_CTA_SOURCE : COMPLETE_CTA_SOURCE;
  }

  function stopEraseRevertScramble(resetLabels = true) {
    if (eraseRevertScrambleRaf) cancelAnimationFrame(eraseRevertScrambleRaf);
    eraseRevertScrambleRaf = 0;
    if (resetLabels) {
      eraseRevertCenterLabel = eraseRevertCenterSource();
      eraseRevertSideLabel = ERASE_CTA_SOURCE;
    }
  }

  function startEraseRevertScramble() {
    stopEraseRevertScramble(false);
    const centerSource = eraseRevertCenterSource();
    eraseRevertCenterLabel = centerSource;
    eraseRevertSideLabel = ERASE_CTA_SOURCE;
    const animStart = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - animStart) / START_WORKOUT_ANIM_MS, 1);
      if (progress >= 1) {
        eraseRevertCenterLabel = START_CTA_SOURCE;
        eraseRevertSideLabel = SKIP_CTA_SOURCE;
        eraseRevertScrambleRaf = 0;
        return;
      }
      eraseRevertCenterLabel = computeCtaScramble(progress, centerSource, START_CTA_SOURCE);
      eraseRevertSideLabel = computeCtaScramble(progress, ERASE_CTA_SOURCE, SKIP_CTA_SOURCE);
      eraseRevertScrambleRaf = requestAnimationFrame(tick);
    };
    eraseRevertScrambleRaf = requestAnimationFrame(tick);
  }

  function stopEraseRevertAnim() {
    if (eraseRevertAnimTimer) clearTimeout(eraseRevertAnimTimer);
    eraseRevertAnimTimer = null;
    eraseRevertAnimating = false;
    stopEraseRevertScramble(true);
  }

  function stopCancelRevertScramble(resetLabels = true) {
    if (cancelRevertScrambleRaf) cancelAnimationFrame(cancelRevertScrambleRaf);
    cancelRevertScrambleRaf = 0;
    if (resetLabels) {
      cancelRevertCenterLabel = START_CTA_TARGET;
      cancelRevertSideLabel = SKIP_CTA_TARGET;
    }
  }

  function startCancelRevertScramble() {
    stopCancelRevertScramble(false);
    cancelRevertCenterLabel = START_CTA_TARGET;
    cancelRevertSideLabel = SKIP_CTA_TARGET;
    const animStart = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - animStart) / START_WORKOUT_ANIM_MS, 1);
      if (progress >= 1) {
        cancelRevertCenterLabel = START_CTA_SOURCE;
        cancelRevertSideLabel = SKIP_CTA_SOURCE;
        cancelRevertScrambleRaf = 0;
        return;
      }
      cancelRevertCenterLabel = computeCtaScramble(progress, START_CTA_TARGET, START_CTA_SOURCE);
      cancelRevertSideLabel = computeCtaScramble(progress, SKIP_CTA_TARGET, SKIP_CTA_SOURCE);
      cancelRevertScrambleRaf = requestAnimationFrame(tick);
    };
    cancelRevertScrambleRaf = requestAnimationFrame(tick);
  }

  function stopCancelRevertAnim() {
    if (cancelRevertAnimTimer) clearTimeout(cancelRevertAnimTimer);
    cancelRevertAnimTimer = null;
    cancelRevertAnimating = false;
    stopCancelRevertScramble(true);
  }

  function stopSkipRevertScramble(resetLabels = true) {
    if (skipRevertScrambleRaf) cancelAnimationFrame(skipRevertScrambleRaf);
    skipRevertScrambleRaf = 0;
    if (resetLabels) {
      skipRevertCenterLabel = START_CTA_SOURCE;
      skipRevertSideLabel = SKIP_CTA_SOURCE;
    }
  }

  function startSkipRevertScramble() {
    stopSkipRevertScramble(false);
    skipRevertCenterLabel = START_CTA_SOURCE;
    skipRevertSideLabel = SKIP_CTA_SOURCE;
    const animStart = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - animStart) / START_WORKOUT_ANIM_MS, 1);
      if (progress >= 1) {
        skipRevertCenterLabel = SKIPPED_CTA_SOURCE;
        skipRevertSideLabel = ERASE_CTA_SOURCE;
        skipRevertScrambleRaf = 0;
        return;
      }
      skipRevertCenterLabel = computeCtaScramble(progress, START_CTA_SOURCE, SKIPPED_CTA_SOURCE);
      skipRevertSideLabel = computeCtaScramble(progress, SKIP_CTA_SOURCE, ERASE_CTA_SOURCE);
      skipRevertScrambleRaf = requestAnimationFrame(tick);
    };
    skipRevertScrambleRaf = requestAnimationFrame(tick);
  }

  function stopSkipRevertAnim() {
    if (skipRevertAnimTimer) clearTimeout(skipRevertAnimTimer);
    skipRevertAnimTimer = null;
    skipRevertAnimating = false;
    stopSkipRevertScramble(true);
  }

  async function syncSkipWorkout() {
    try {
      workoutActionError = null;
      await db.skipWorkout(activeTemplate?.id || null, activeTemplate?.name || null);
      await loadData({ preserveSession: true });
      if (logIsSkipped(todayLog)) {
        workoutState = 'skipped';
      }
    } catch (err) {
      console.error('skip workout failed', err);
      workoutActionError = formatDbError(err);
      workoutState = 'idle';
      await loadData();
    }
  }

  function applySkipOptimisticLog() {
    if (!isViewingToday) return;
    todayLog = {
      is_skipped: true,
      workout_snapshot: { skipped: true, template_name: activeTemplate?.name ?? undefined },
    };
    weekLogs = { ...weekLogs, [REAL_TODAY_STR]: todayLog };
    viewedLog = todayLog;
  }

  function beginSkipRevert() {
    if (skipRevertAnimating || workoutState !== 'idle' || !isViewingToday || startWorkoutAnimating) {
      return;
    }
    stopSkipHold();
    stopSkipRevertAnim();
    skipRevertAnimating = true;
    justFinishedStatus = null;
    // Optimistic from frame 0: stale completed todayLog + idle state otherwise flashes yellow
    applySkipOptimisticLog();
    startSkipRevertScramble();
    skipRevertAnimTimer = setTimeout(() => {
      skipRevertAnimTimer = null;
      stopSkipRevertScramble(false);
      skipRevertCenterLabel = SKIPPED_CTA_SOURCE;
      skipRevertSideLabel = ERASE_CTA_SOURCE;
      workoutState = 'skipped';
      skipRevertAnimating = false;
      applySkipOptimisticLog();
      void syncSkipWorkout();
    }, START_WORKOUT_ANIM_MS);
  }

  function beginCancelRevert() {
    if (cancelRevertAnimating || workoutState !== 'active' || !isViewingToday) return;
    stopCancelHold();
    stopFinishHold();
    stopCancelRevertAnim();
    cancelRevertWasPerfect = isPerfectDay;
    cancelRevertAnimating = true;
    startCancelRevertScramble();
    cancelRevertAnimTimer = setTimeout(() => {
      cancelRevertAnimTimer = null;
      stopCancelRevertScramble(false);
      cancelRevertCenterLabel = START_CTA_SOURCE;
      cancelRevertSideLabel = SKIP_CTA_SOURCE;
      cancelRevertAnimating = false;
      applyCancelWorkoutState();
    }, START_WORKOUT_ANIM_MS);
  }

  /** Drop completion colors/log immediately when erase starts (CTAs still animate). */
  function applyEraseLocalReset() {
    justFinishedStatus = null;
    clearActiveSessionBackup();
    trackedReps = {};
    completedTimers = {};
    activeWorkoutTemplate = null;
    const dateKey = selectedDateStr;
    weekLogs = { ...weekLogs, [dateKey]: null };
    if (dateKey === REAL_TODAY_STR) {
      todayLog = null;
    }
    if (selectedDateStr === dateKey) {
      viewedLog = null;
    }
  }

  function beginEraseRevert() {
    if (
      eraseRevertAnimating ||
      cancelRevertAnimating ||
      skipRevertAnimating ||
      (workoutState !== 'done' && workoutState !== 'skipped')
    ) {
      return;
    }
    stopEraseHold();
    stopEraseRevertAnim();
    applyEraseLocalReset();
    eraseRevertAnimating = true;
    startEraseRevertScramble();
    eraseRevertAnimTimer = setTimeout(() => {
      eraseRevertAnimTimer = null;
      stopEraseRevertScramble(false);
      eraseRevertCenterLabel = START_CTA_SOURCE;
      eraseRevertSideLabel = SKIP_CTA_SOURCE;
      workoutState = 'idle';
      eraseRevertAnimating = false;
      void eraseWorkoutLog();
    }, START_WORKOUT_ANIM_MS);
  }

  function handleStartWorkoutTap(e: Event) {
    e.preventDefault();
    if (workoutState !== 'idle' || !isViewingToday || startWorkoutAnimating || skipRevertAnimating) {
      return;
    }
    cancelStartWorkoutAnim();
    startWorkoutAnimating = true;
    startStartCtaScramble();
    startWorkoutAnimTimer = setTimeout(() => {
      startWorkoutAnimTimer = null;
      stopStartCtaScramble(false);
      startWorkout();
      startWorkoutAnimating = false;
    }, START_WORKOUT_ANIM_MS);
  }

  function startFinishHold(e: Event) {
    if (e.cancelable) e.preventDefault();
    if (workoutState !== 'active' || !isViewingToday || cancelRevertAnimating) return;
    const startTime = Date.now();
    finishHoldTimer = setInterval(() => {
      finishHoldProgress = Math.min(((Date.now() - startTime) / FAST_HOLD_CONFIRM_MS) * 100, 100);
      if (finishHoldProgress >= 100) {
        clearInterval(finishHoldTimer!);
        finishHoldTimer = null;
        finishHoldProgress = 0;
        finishWorkout();
      }
    }, 20);
  }

  function stopFinishHold() {
    if (finishHoldTimer) clearInterval(finishHoldTimer);
    finishHoldTimer = null;
    finishHoldProgress = 0;
  }

  function startSkipHold(e: Event) {
    if (e.cancelable) e.preventDefault();
    if (
      workoutState !== 'idle' ||
      !isViewingToday ||
      startWorkoutAnimating ||
      skipRevertAnimating
    ) {
      return;
    }
    pulseSkipTapFlash();
    let startTime = Date.now();
    skipHoldTimer = setInterval(() => {
      skipProgress = Math.min(((Date.now() - startTime) / HOLD_CONFIRM_MS) * 100, 100);
      if (skipProgress >= 100) {
        clearInterval(skipHoldTimer);
        skipHoldTimer = null;
        skipProgress = 0;
        beginSkipRevert();
      }
    }, 20);
  }

  function stopSkipHold() {
    clearInterval(skipHoldTimer);
    skipHoldTimer = null;
    skipProgress = 0;
    tapPulseGen.skip++;
    skipTapPulseActive = false;
  }

  function startCancelHold(e: Event) {
    if (e.cancelable) e.preventDefault();
    if (workoutState !== 'active' || cancelRevertAnimating) return;
    pulseCancelTapFlash();
    let startTime = Date.now();
    cancelHoldTimer = setInterval(() => {
      cancelProgress = Math.min(((Date.now() - startTime) / HOLD_CONFIRM_MS) * 100, 100);
      if (cancelProgress >= 100) {
        clearInterval(cancelHoldTimer);
        cancelHoldTimer = null;
        cancelProgress = 0;
        beginCancelRevert();
      }
    }, 20);
  }
  function stopCancelHold() {
    clearInterval(cancelHoldTimer);
    cancelHoldTimer = null;
    cancelProgress = 0;
    tapPulseGen.cancel++;
    cancelTapPulseActive = false;
  }

  function startDeleteTemplateHold(e: Event) {
    if (e.cancelable) e.preventDefault();
    const templateId =
      currentView === 'edit_template' ? editingTemplateId : activeTemplate?.id;
    if (!templateId) return;
    let startTime = Date.now();
    deleteTemplateHoldTimer = setInterval(() => {
      deleteTemplateProgress = Math.min(((Date.now() - startTime) / 1000) * 100, 100);
      if (deleteTemplateProgress >= 100) {
        clearInterval(deleteTemplateHoldTimer);
        deleteTemplateProgress = 0;
        db.deleteTemplate(templateId).then(() => {
          editingTemplateId = '';
          draftExercises = [];
          draftTemplateName = '';
          loadData();
          currentView = 'track';
        });
      }
    }, 20);
  }
  function stopDeleteTemplateHold() { clearInterval(deleteTemplateHoldTimer); deleteTemplateProgress = 0; }

  function startEraseHold(e: Event) {
    if (e.cancelable) e.preventDefault();
    if (
      eraseRevertAnimating ||
      cancelRevertAnimating ||
      skipRevertAnimating ||
      startWorkoutAnimating ||
      (workoutState !== 'done' && workoutState !== 'skipped')
    ) {
      return;
    }
    pulseEraseTapFlash();
    let startTime = Date.now();
    eraseHoldTimer = setInterval(() => {
      eraseProgress = Math.min(((Date.now() - startTime) / HOLD_CONFIRM_MS) * 100, 100);
      if (eraseProgress >= 100) {
        clearInterval(eraseHoldTimer);
        eraseHoldTimer = null;
        eraseProgress = 0;
        beginEraseRevert();
      }
    }, 20);
  }
  function stopEraseHold() {
    clearInterval(eraseHoldTimer);
    eraseHoldTimer = null;
    eraseProgress = 0;
    tapPulseGen.erase++;
    eraseTapPulseActive = false;
  }

  function pulseSignOutTapFlash() {
    signOutTapPulseActive = false;
    requestAnimationFrame(() => {
      signOutTapPulseActive = true;
    });
  }

  function pulseDeleteAccountTapFlash() {
    deleteAccountTapPulseActive = false;
    requestAnimationFrame(() => {
      deleteAccountTapPulseActive = true;
    });
  }

  function onSignOutTapPulseEnd(e: AnimationEvent) {
    if (e.animationName === 'hold-skip-tap-pulse') signOutTapPulseActive = false;
  }

  function onDeleteAccountTapPulseEnd(e: AnimationEvent) {
    if (e.animationName === 'hold-cancel-tap-pulse') deleteAccountTapPulseActive = false;
  }

  function startSignOutHold(e: Event) {
    if (e.cancelable) e.preventDefault();
    if (accountBusy) return;
    pulseSignOutTapFlash();
    const startTime = Date.now();
    signOutHoldTimer = setInterval(() => {
      signOutProgress = Math.min(((Date.now() - startTime) / SIGN_OUT_HOLD_MS) * 100, 100);
      if (signOutProgress >= 100) {
        clearInterval(signOutHoldTimer!);
        signOutHoldTimer = null;
        signOutProgress = 0;
        void handleSignOut();
      }
    }, 20);
  }

  function stopSignOutHold() {
    if (signOutHoldTimer) clearInterval(signOutHoldTimer);
    signOutHoldTimer = null;
    signOutProgress = 0;
    signOutTapPulseActive = false;
  }

  function startDeleteAccountHold(e: Event) {
    if (e.cancelable) e.preventDefault();
    if (accountBusy) return;
    pulseDeleteAccountTapFlash();
    const startTime = Date.now();
    deleteAccountHoldTimer = setInterval(() => {
      deleteAccountProgress = Math.min(((Date.now() - startTime) / DELETE_ACCOUNT_HOLD_MS) * 100, 100);
      if (deleteAccountProgress >= 100) {
        clearInterval(deleteAccountHoldTimer!);
        deleteAccountHoldTimer = null;
        deleteAccountProgress = 0;
        void handleDeleteAccount();
      }
    }, 20);
  }

  function stopDeleteAccountHold() {
    if (deleteAccountHoldTimer) clearInterval(deleteAccountHoldTimer);
    deleteAccountHoldTimer = null;
    deleteAccountProgress = 0;
    deleteAccountTapPulseActive = false;
  }

  async function eraseWorkoutLog() {
    const dateKey = selectedDateStr;
    stopEraseHold();
    stopSkipHold();
    try {
      workoutActionError = null;
      await db.deleteWorkoutLog(isViewingToday ? undefined : dateKey);
      weekLogs = { ...weekLogs, [dateKey]: null };
      if (selectedDateStr === dateKey) {
        viewedLog = null;
        if (isViewingToday) todayLog = null;
      }
      await loadData({ preserveSession: true });
    } catch (err) {
      console.error('erase workout failed', err);
      workoutActionError = 'Could not erase workout log.';
      await loadData({ preserveSession: true });
    }
  }

  function applyLocalScheduleAssignment(dayOfWeek: number, templateId: string | null) {
    const uid = currentUser?.id;
    if (!uid) return;
    const now = new Date().toISOString();
    const idx = schedule.findIndex((s) => s.day_of_week === dayOfWeek);
    if (idx >= 0) {
      schedule = schedule.map((s, i) =>
        i === idx ? { ...s, template_id: templateId, updated_at: now } : s,
      );
    } else {
      schedule = [
        ...schedule,
        {
          user_id: uid,
          day_of_week: dayOfWeek,
          template_id: templateId,
          updated_at: now,
        },
      ].sort((a, b) => a.day_of_week - b.day_of_week);
    }
  }

  function applyLocalScheduleFromBuilder(assignments: Record<number, string | null>) {
    for (let wd = 0; wd < 7; wd++) {
      applyLocalScheduleAssignment(wd, assignments[wd] ?? null);
    }
  }

  function exitRoutineEditor() {
    const snapshot = { ...builderAssignments };
    const priorAssignments = new Map(
      schedule.map((s) => [s.day_of_week, s.template_id ?? null] as const),
    );
    applyLocalScheduleFromBuilder(snapshot);
    currentView = 'track';
    builderAssignments = {};
    builderEditingDay = 0;
    editingRoutineTemplateNameId = null;
    templateError = null;
    void syncRoutineEditorAssignments(snapshot, priorAssignments);
  }

  async function syncRoutineEditorAssignments(
    snapshot: Record<number, string | null>,
    priorAssignments: Map<number, string | null>,
  ) {
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();
    if (userErr || !user) {
      currentUser = null;
      templateError = formatDbError(userErr ?? new Error('Not signed in'));
      return;
    }
    currentUser = user;

    const promises: Promise<void>[] = [];
    for (let wd = 0; wd < 7; wd++) {
      let newTid = snapshot[wd] ?? null;
      if (newTid?.startsWith('temp-')) {
        const pending = routineEditorPendingCreates.get(wd);
        newTid = pending ? await pending : null;
      }
      const oldTid = priorAssignments.get(wd) ?? null;
      if (newTid !== oldTid) {
        promises.push(db.assignTemplateToDay(wd, newTid));
      }
    }
    if (!promises.length) return;
    try {
      await Promise.all(promises);
      await loadData({ preserveSession: true });
    } catch (e) {
      console.error('Routine editor sync failed', e);
      templateError = formatDbError(e);
      await loadData({ preserveSession: true });
    }
  }

  async function handleCreateTemplate(defaultName?: string) {
    const name = (defaultName ?? newTemplateName).trim();
    if (!name) {
      templateError = 'Enter a template name.';
      return;
    }
    if (isCreatingTemplate) return;

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();
    if (userErr || !user) {
      currentUser = null;
      templateError = formatDbError(userErr ?? new Error('Not signed in'));
      return;
    }
    currentUser = user;
    const uid = user.id;
    const wd =
      (currentView === 'swap_template' ? builderEditingDay : selectedWeekday) ?? 0;

    templateError = null;

    if (currentView === 'swap_template') {
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const optimistic: Template = { id: tempId, user_id: uid, name, exercises: [] };
      templates = [...templates, optimistic];
      builderAssignments = { ...builderAssignments, [wd]: tempId };
      applyLocalScheduleAssignment(wd, tempId);
      newTemplateName = '';

      const createPromise = (async (): Promise<string | null> => {
        try {
          const template = await db.createTemplate(name);
          if (!template) throw new Error('Could not create template');
          await db.assignTemplateToDay(wd, template.id);
          templates = templates.map((t) => (t.id === tempId ? template : t));
          if (builderAssignments[wd] === tempId) {
            builderAssignments = { ...builderAssignments, [wd]: template.id };
          }
          applyLocalScheduleAssignment(wd, template.id);
          return template.id;
        } catch (e) {
          console.error('Create template failed', e);
          templates = templates.filter((t) => t.id !== tempId);
          if (builderAssignments[wd] === tempId) {
            builderAssignments = { ...builderAssignments, [wd]: null };
            applyLocalScheduleAssignment(wd, null);
          }
          templateError = formatDbError(e);
          return null;
        } finally {
          routineEditorPendingCreates.delete(wd);
        }
      })();
      routineEditorPendingCreates.set(wd, createPromise);
      void createPromise;
      return;
    }

    isCreatingTemplate = true;
    try {
      const template = await db.createTemplate(name);
      if (!template) {
        templateError = 'Could not create template.';
        return;
      }

      await db.assignTemplateToDay(wd, template.id);

      templates = [...templates, template];
      applyLocalScheduleAssignment(wd, template.id);

      newTemplateName = '';

      const rep = new Date(REAL_TODAY);
      rep.setDate(rep.getDate() - rep.getDay() + wd);
      selectedDate = rep;
      openTemplateEditor(template.id);
    } catch (e) {
      console.error('Create template failed', e);
      templateError = formatDbError(e);
    } finally {
      isCreatingTemplate = false;
    }
  }

  async function handleGoogleSignIn() {
    signingIn = true;
    authError = null;
    authSuccess = null;
    try {
      await db.signInWithGoogle();
    } catch (e) {
      console.error('Google sign-in failed', e);
      authError = formatAuthError(e, 'google');
    } finally {
      signingIn = false;
    }
  }

  async function handleGitHubSignIn() {
    signingIn = true;
    authError = null;
    authSuccess = null;
    try {
      await db.signInWithGitHub();
    } catch (e) {
      console.error('GitHub sign-in failed', e);
      authError = formatAuthError(e, 'github');
    } finally {
      signingIn = false;
    }
  }

  async function handleDiscordSignIn() {
    signingIn = true;
    authError = null;
    authSuccess = null;
    try {
      await db.signInWithDiscord();
    } catch (e) {
      console.error('Discord sign-in failed', e);
      authError = formatAuthError(e, 'discord');
    } finally {
      signingIn = false;
    }
  }

  async function handleXSignIn() {
    signingIn = true;
    authError = null;
    authSuccess = null;
    try {
      await db.signInWithX();
    } catch (e) {
      console.error('X sign-in failed', e);
      authError = formatAuthError(e, 'x');
    } finally {
      signingIn = false;
    }
  }

  function toggleEmailAuth() {
    authCredentialMethod = authCredentialMethod === 'email' ? 'username' : 'email';
    authError = null;
    authSuccess = null;
  }

  async function handleEmailAuth() {
    const email = authEmail.trim();
    if (!email || !authPassword) {
      authError = 'Enter your email and password.';
      authSuccess = null;
      return;
    }
    const emailErr = validateEmail(email);
    if (emailErr) {
      authError = emailErr;
      authSuccess = null;
      return;
    }
    if (authMode === 'signup' && authPassword !== authConfirmPassword) {
      authError = 'Passwords do not match.';
      authSuccess = null;
      return;
    }
    if (authPassword.length < 6) {
      authError = 'Password must be at least 6 characters.';
      authSuccess = null;
      return;
    }

    signingIn = true;
    authError = null;
    authSuccess = null;
    try {
      if (authMode === 'signup') {
        const { session, user } = await db.signUpWithEmail(email, authPassword);
        if (session) {
          currentUser = user;
          authPassword = '';
          authConfirmPassword = '';
        } else {
          authSuccess =
            'Account created. Check your email for a confirmation link, then sign in.';
          authMode = 'signin';
          authPassword = '';
          authConfirmPassword = '';
        }
      } else {
        const { session, user } = await db.signInWithEmail(email, authPassword);
        if (session?.user) currentUser = session.user;
        else if (user) currentUser = user;
        authPassword = '';
      }
    } catch (e) {
      console.error('Email auth failed', e);
      authError = formatAuthError(e, undefined, 'email');
    } finally {
      signingIn = false;
    }
  }

  async function handleUsernameAuth() {
    const username = authUsername.trim();
    if (!username || !authPassword) {
      authError = 'Enter your username and password.';
      authSuccess = null;
      return;
    }
    const usernameErr = validateUsername(username);
    if (usernameErr) {
      authError = usernameErr;
      authSuccess = null;
      return;
    }
    if (authMode === 'signup' && authPassword !== authConfirmPassword) {
      authError = 'Passwords do not match.';
      authSuccess = null;
      return;
    }
    if (authPassword.length < 6) {
      authError = 'Password must be at least 6 characters.';
      authSuccess = null;
      return;
    }

    signingIn = true;
    authError = null;
    authSuccess = null;
    try {
      if (authMode === 'signup') {
        const available = await db.isUsernameAvailable(username);
        if (!available) {
          authError = 'This username is already taken. Try another.';
          return;
        }

        const { session, user } = await db.signUpWithUsername(username, authPassword);
        if (session) {
          currentUser = user;
          authPassword = '';
          authConfirmPassword = '';
        } else {
          authSuccess =
            'Account created. If sign-in fails, disable “Confirm email” in Supabase Auth settings (username accounts have no inbox).';
          authMode = 'signin';
          authPassword = '';
          authConfirmPassword = '';
        }
      } else {
        const { session, user } = await db.signInWithUsername(username, authPassword);
        if (session?.user) currentUser = session.user;
        else if (user) currentUser = user;
        authPassword = '';
      }
    } catch (e) {
      console.error('Username auth failed', e);
      authError = formatAuthError(e, undefined, 'username');
    } finally {
      signingIn = false;
    }
  }

  function setAuthMode(mode: 'signin' | 'signup') {
    authMode = mode;
    authError = null;
    authSuccess = null;
    if (mode === 'signin') authConfirmPassword = '';
  }

  function openAccountPanel() {
    accountError = null;
    stopSignOutHold();
    stopDeleteAccountHold();
    showAccountPanel = true;
  }

  /** Closes panel and resets hold UI; safe to call during sign-out / auth changes. */
  function resetAccountPanelUi() {
    showAccountPanel = false;
    stopSignOutHold();
    stopDeleteAccountHold();
    accountError = null;
  }

  function closeAccountPanel() {
    if (accountBusy) return;
    resetAccountPanelUi();
  }

  async function handleSignOut() {
    if (accountBusy) return;
    accountBusy = true;
    accountError = null;
    resetAccountPanelUi();
    try {
      await db.signOut();
    } catch (e) {
      console.error('Sign out failed', e);
      accountError = formatAuthError(e);
    } finally {
      accountBusy = false;
    }
  }

  async function handleDeleteAccount() {
    if (accountBusy || !currentUser) return;
    accountBusy = true;
    accountError = null;
    stopDeleteAccountHold();
    try {
      await db.deleteAccount();
      currentUser = null;
      resetAccountPanelUi();
      schedule = [];
      templates = [];
      todayLog = null;
      viewedLog = null;
      weekLogs = {};
      workoutState = 'idle';
      justFinishedStatus = null;
      currentView = 'track';
    } catch (e) {
      console.error('Delete account failed', e);
      accountError = formatAccountError(e);
    } finally {
      accountBusy = false;
    }
  }



  async function undoRestLog(dateStr: string) {
    try {
      await db.deleteLogForDate(dateStr);
      weekLogs[dateStr] = null;
      if (selectedDateStr === dateStr) {
        viewedLog = null;
      }
    } catch (err) {
      console.error('undo rest log failed', err);
    }
  }

  function createTemplateFromRoutineBuilder() {
    void handleCreateTemplate('New Template');
  }

  function assignTemplateToBuilderDay(templateId: string | null) {
    if (editingRoutineTemplateNameId && editingRoutineTemplateNameId !== templateId) {
      const prev = templates.find((t) => t.id === editingRoutineTemplateNameId);
      if (prev) void commitRoutineTemplateNameEdit(prev);
    }
    builderAssignments = { ...builderAssignments, [builderEditingDay]: templateId };
  }

  function beginRoutineTemplateNameEdit(templateId: string) {
    assignTemplateToBuilderDay(templateId);
    editingRoutineTemplateNameId = templateId;
  }

  function commitRoutineTemplateNameEdit(template: Template) {
    editingRoutineTemplateNameId = null;
    const trimmed = (template.name ?? '').trim();
    if (!trimmed) {
      template.name = 'Workout';
      return;
    }
    template.name = trimmed;
    if (template.id.startsWith('temp-')) return;
    const previous = templates.find((t) => t.id === template.id)?.name;
    if (previous === trimmed) return;
    patchTemplateInCache(template.id, trimmed, template.exercises);
    void db.updateTemplateName(template.id, trimmed).catch((e) => {
      console.error('Template name save failed', e);
      templateError = 'Could not save template name.';
      void loadData({ preserveSession: true });
    });
  }

  async function deleteTemplateInBuilder(tpl: any) {
    if (editingRoutineTemplateNameId === tpl.id) {
      editingRoutineTemplateNameId = null;
    }
    try {
      await db.deleteTemplate(tpl.id);
      // clear from any pending assignments in builder
      for (let i = 0; i < 7; i++) {
        if (builderAssignments[i] === tpl.id) {
          builderAssignments[i] = null;
        }
      }
      await loadData();
    } catch (e) {
      console.error(e);
    }
  }

  function resetNewExerciseForm() {
    // No-op: the exercise editor no longer uses a separate new* buffer (edits are direct on draft items).
    // Kept for any legacy call sites on view exit etc.
  }

  function openTemplateEditor(templateId?: string) {
    if (!templateId && !showHeaderEditActions) return;
    const id = templateId ?? activeTemplate?.id;
    if (!id) return;
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    editingTemplateId = id;
    draftExercises = tpl.exercises.map((e) => ({ ...e }));
    draftTemplateName = tpl.name;
    selectedExerciseId = null;
    editingExerciseNameId = null;
    templateSaveError = null;
    resetNewExerciseForm();
    currentView = 'edit_template';
  }

  function patchTemplateInCache(
    templateId: string,
    name: string,
    exercises: Exercise[],
  ) {
    const trimmed = name.trim();
    templates = templates.map((t) =>
      t.id === templateId
        ? { ...t, name: trimmed || t.name, exercises }
        : t,
    );
  }

  function draftToExercises(templateId: string, draft: any[]): Exercise[] {
    const tpl = templates.find((t) => t.id === templateId);
    const uid = tpl?.user_id ?? currentUser?.id ?? '';
    return draft.map((d, i) => ({
      id: d.id,
      template_id: templateId,
      user_id: d.user_id ?? uid,
      name: d.name ?? 'Exercise',
      exercise_type: d.exercise_type,
      target_sets: d.target_sets ?? 0,
      target_reps: d.target_reps ?? 0,
      target_minutes: d.target_minutes ?? 0,
      target_seconds: d.target_seconds ?? 0,
      increment: d.increment ?? 0,
      current_weight: d.current_weight ?? null,
      display_order: i,
    }));
  }

  async function commitDraftExercises(
    templateId: string,
    exercises: any[],
    name: string,
    previousName: string,
  ) {
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== previousName) {
      await db.updateTemplateName(templateId, trimmedName);
    }
    const saved = await db.saveTemplateExercises(templateId, exercises);
    patchTemplateInCache(templateId, trimmedName || previousName, saved);
    await loadData({ preserveSession: true });
  }

  function exitEditTemplate() {
    const templateId = editingTemplateId || activeTemplate?.id;
    if (!templateId || templateSaveInFlight) return;

    const snapExercises = draftExercises.map((e) => ({ ...e }));
    const snapName = draftTemplateName;
    const previousName =
      templates.find((t) => t.id === templateId)?.name ?? snapName;
    const displayName = snapName.trim() || previousName;

    templateSaveError = null;
    patchTemplateInCache(templateId, displayName, draftToExercises(templateId, snapExercises));

    currentView = 'track';
    draftExercises = [];
    draftTemplateName = '';
    selectedExerciseId = null;
    editingExerciseNameId = null;
    editingTemplateId = '';

    templateSaveInFlight = true;
    void commitDraftExercises(templateId, snapExercises, snapName, previousName)
      .then(() => {
        templateSaveError = null;
      })
      .catch((err) => {
        console.error('template save failed', err);
        templateSaveError =
          err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
            ? err.message
            : 'Could not save template changes. Try again.';
        void loadData({ preserveSession: true }).catch(() => {});
      })
      .finally(() => {
        templateSaveInFlight = false;
      });
  }

  function activateOrSwitchTimeSet(exId: string, s: number) {
    if (workoutState !== 'active') return;
    if (activeTimerExerciseId === exId && activeTimerSetIndex === s) {
      toggleExerciseTimer();
      return;
    }
    if (activeTimerExerciseId) {
      cancelActiveTimer();
    }
    startTimedSet(exId, s);
  }

  function handleDeleteExercise(id: string) {
    if (currentView === 'edit_template' && draftExercises.length > 0) {
      draftExercises = draftExercises.filter((e: any) => e.id !== id);
      if (selectedExerciseId === id) {
        selectedExerciseId = draftExercises.length > 0 ? draftExercises[draftExercises.length - 1].id : null;
        if (selectedExerciseId) {
          // just set; form reads directly from object (no new* buffer population)
          // (selectExercise would also just set the id)
        } else {
          resetNewExerciseForm();
        }
      }
      return;
    }
    db.deleteExercise(id).then(() => loadData());
  }

  function selectExercise(id: string | null) {
    if (id !== editingExerciseNameId) {
      editingExerciseNameId = null;
    }
    selectedExerciseId = id;
    if (!id) {
      resetNewExerciseForm();
    }
    // No population of new* buffer anymore — the properties form reads/mutates the exercise object directly.
    // This eliminates the burst of effect runs + re-renders on select.
  }

  function beginExerciseNameEdit(id: string) {
    selectExercise(id);
    editingExerciseNameId = id;
  }

  function endExerciseNameEdit() {
    editingExerciseNameId = null;
  }

  function focusExerciseNameInput(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function addNewExercise() {
    if (!editingTemplateId) return;
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const newEx: any = {
      id: tempId,
      name: 'New Exercise',
      exercise_type: 'reps',
      target_sets: 3,
      target_reps: 12,
      target_minutes: 0,
      target_seconds: 30,
      increment: 2.5,
      current_weight: 15,
      display_order: draftExercises.length,
      template_id: editingTemplateId,
    };
    draftExercises = [...draftExercises, newEx];
    selectExercise(tempId);
    // The properties form will read the values directly from the newEx object (no intermediate new* state).
  }

  function deleteSelectedExercise() {
    if (!selectedExerciseId) return;
    const id = selectedExerciseId;
    draftExercises = draftExercises.filter((e: any) => e.id !== id);
    if (draftExercises.length > 0) {
      selectExercise(draftExercises[draftExercises.length - 1].id);
    } else {
      selectedExerciseId = null;
      resetNewExerciseForm();
    }
  }

  // Drag and drop reorder (replaces arrows)
  let draggedIndex = $state<number | null>(null);

  function handleDragStart(e: DragEvent, index: number) {
    draggedIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index.toString());
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  }

  function handleDrop(e: DragEvent, targetIndex: number) {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndex) {
      draggedIndex = null;
      return;
    }
    const arr = [...draftExercises];
    const [moved] = arr.splice(draggedIndex, 1);
    arr.splice(targetIndex, 0, moved);
    draftExercises = arr;
    // selectedExerciseId remains valid (same object moved)
    draggedIndex = null;
  }

  function handleDragEnd() {
    draggedIndex = null;
  }
</script>

<div class="app max-w-md mx-auto min-h-screen min-h-dvh select-none text-white bg-[#0a0a0a] p-4 flex flex-col gap-3 font-sans">

  {#if showAccountPanel && currentUser}
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-label="Account settings"
      onclick={(e) => { if (e.target === e.currentTarget) closeAccountPanel(); }}>
      <div class="w-full max-w-[300px] rounded-xl border border-[#1e1e1e] bg-[#141414] shadow-xl overflow-hidden text-left">
        <div class="flex items-center justify-between px-3 py-2 border-b border-[#1e1e1e] bg-[#111]">
          <span class="shrink-0 leading-none select-none">
            <span class="tracking-[2px] text-[11px] text-white font-black">LIFT</span><span class="text-[11px] text-zinc-500 font-semibold px-0.5">—</span><span class="font-semibold tracking-[0.5px] text-[11px] text-zinc-400">TRACKER</span>
          </span>
          <button
            type="button"
            aria-label="Close"
            class="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-[#1a1a1a] transition"
            disabled={accountBusy}
            onclick={closeAccountPanel}>
            <X class="size-3.5" />
          </button>
        </div>

        <div class="p-3 space-y-3">
          <div class="flex items-center gap-2.5">
            <div class="w-10 h-10 shrink-0 rounded-lg border border-[#1e1e1e] bg-[#0a0a0a] flex items-center justify-center text-sm font-black text-emerald-400">
              {accountInitial}
            </div>
            <div class="min-w-0">
              <div class="text-xs font-medium text-white truncate">{accountDisplayName}</div>
              <div class="text-[10px] text-zinc-500 mt-0.5">
                {accountProvider} · {accountMemberSince}
              </div>
            </div>
          </div>

          <p class="text-[9px] font-mono text-zinc-600 break-all leading-relaxed" title={currentUser.id}>
            {currentUser.id}
          </p>

          {#if accountError}
            <p class="text-[11px] text-red-300 leading-snug px-2.5 py-1.5 rounded-lg border border-red-900/50 bg-red-950/30">
              {accountError}
            </p>
          {/if}

          <p class="flex items-start gap-1.5 text-[10px] leading-snug text-zinc-500">
            <TriangleAlert class="size-3 shrink-0 mt-0.5 text-amber-500/90" aria-hidden="true" />
            <span>Hold <span class="text-amber-400/80 font-bold">SIGN OUT</span> or <span class="text-red-400/80 font-bold">DELETE</span> to confirm.</span>
          </p>

          <button
            type="button"
            title="Hold to sign out"
            class="w-full h-10 rounded-lg font-black text-[10px] tracking-[0.12em] flex items-center justify-center bg-[#0d0d0d] border relative overflow-hidden transition-all duration-150 hover:brightness-110 disabled:opacity-60 {signOutTapPulseActive ? 'hold-skip-tap-pulse' : signOutProgress > 0 ? 'border-amber-500 text-[#fbbf24]' : 'border-amber-900/35 text-amber-500/70'}"
            disabled={accountBusy}
            onmousedown={startSignOutHold}
            onmouseup={stopSignOutHold}
            onmouseleave={stopSignOutHold}
            ontouchstart={startSignOutHold}
            ontouchend={stopSignOutHold}
            onanimationend={onSignOutTapPulseEnd}>
            <div class="absolute inset-0 z-0 bg-amber-900/40 transition-all duration-[20ms]" style="width: {signOutProgress}%;"></div>
            <span class="relative z-10">{accountBusy ? '…' : 'SIGN OUT'}</span>
          </button>

          <button
            type="button"
            title="Hold to delete account and all data"
            class="w-full h-10 rounded-lg font-black text-[10px] tracking-[0.12em] flex items-center justify-center bg-[#0d0d0d] border relative overflow-hidden transition-all duration-150 hover:brightness-110 disabled:opacity-60 {deleteAccountTapPulseActive ? 'hold-cancel-tap-pulse' : deleteAccountProgress > 0 ? 'border-red-500 text-[#f87171]' : 'border-red-900/35 text-red-400/70'}"
            disabled={accountBusy}
            onmousedown={startDeleteAccountHold}
            onmouseup={stopDeleteAccountHold}
            onmouseleave={stopDeleteAccountHold}
            ontouchstart={startDeleteAccountHold}
            ontouchend={stopDeleteAccountHold}
            onanimationend={onDeleteAccountTapPulseEnd}>
            <div class="absolute inset-0 z-0 bg-red-900/50 transition-all duration-[20ms]" style="width: {deleteAccountProgress}%;"></div>
            <span class="relative z-10">{accountBusy ? '…' : 'DELETE'}</span>
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#snippet bootScreen()}
    <div class="flex flex-1 flex-col items-center justify-center pt-0 pb-10 px-2 gap-6 text-center min-h-0 -translate-y-6">
      <div class="w-20 h-20 rounded-2xl bg-[#141414] border border-[#1e1e1e] flex items-center justify-center">
        <Dumbbell class="size-10 text-zinc-400" />
      </div>

      <div class="text-center">
        <div class="text-6xl font-black tracking-[8px] text-white">LIFT</div>
        <div class="text-2xl font-light tracking-[6px] text-zinc-300 -mt-3">TRACKER</div>
        <div class="text-[10px] tracking-[2px] text-emerald-400/70 mt-1">v0.0.1</div>
      </div>

      <div class="boot-status-card w-full max-w-[300px] h-[360px] flex flex-col rounded-xl border border-[#1e1e1e] bg-[#141414] overflow-hidden text-left">
        <div class="flex shrink-0 items-center gap-2 px-3 py-2.5 border-b border-[#1e1e1e] bg-[#111]">
          <RefreshCw class="size-3.5 shrink-0 text-emerald-400 animate-spin" aria-hidden="true" />
          <span class="text-[10px] font-black tracking-[0.12em] text-zinc-200 truncate">{bootMessage}</span>
        </div>
        <div class="boot-status-card-body no-scrollbar flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
          {#if bootSections.length > 0}
            {#each bootSections as section, i}
              <div class="space-y-1 {i > 0 ? 'pt-3 border-t border-[#1e1e1e]' : ''}">
                <p class="text-[9px] font-black tracking-[0.14em] text-zinc-500 uppercase">{section.title}</p>
                {#each section.lines as line}
                  <p class="text-xs text-zinc-400 leading-snug">{line}</p>
                {/each}
              </div>
            {/each}
          {:else}
            {#each buildGuestBootSections() as section, i}
              <div class="space-y-1 {i > 0 ? 'pt-3 border-t border-[#1e1e1e]' : ''}">
                <p class="text-[9px] font-black tracking-[0.14em] text-zinc-500 uppercase">{section.title}</p>
                {#each section.lines as line}
                  <p class="text-xs text-zinc-400 leading-snug">{line}</p>
                {/each}
              </div>
            {/each}
          {/if}
        </div>
      </div>
    </div>
  {/snippet}

  <div class="app-stage flex-1 flex flex-col min-h-0 w-full relative">
  {#if currentUser}
    <div
      class="app-main-reveal flex flex-col gap-3 flex-1 min-h-0 w-full"
      class:app-main-reveal--active={appRevealActive}
    >
  <!-- Week box: collapsible header + compact day strip -->
  <div class="rounded-xl border border-[#1e1e1e] bg-[#141414] overflow-hidden">
    <div class="flex items-center gap-2 min-h-8 px-2 py-1.5 border-b border-[#1e1e1e] bg-[#111] text-[10px] tracking-[1px]">
      <button
        type="button"
        title="Account"
        aria-label="Account settings"
        class="w-7 h-7 shrink-0 rounded-lg border border-emerald-800 bg-emerald-950/40 text-emerald-400 flex items-center justify-center text-[10px] font-black hover:border-emerald-600 hover:text-emerald-300 transition"
        onclick={(e) => { e.stopPropagation(); openAccountPanel(); }}
      >
        {accountInitial}
      </button>
      <button
        type="button"
        class="flex-1 flex items-center gap-2 min-w-0 py-0.5 -my-0.5 px-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-[#1a1a1a] transition-colors"
        onclick={toggleWeekCalendar}
        aria-expanded={!weekCalendarCollapsed}
        title={weekCalendarCollapsed ? 'Expand week' : 'Collapse week'}
      >
        <span class="min-w-0 flex-1 truncate text-left leading-none font-bold text-zinc-200 pointer-events-none">{weekBarLabel}</span>
        {#if weekCalendarCollapsed}
          <ChevronDown class="size-3.5 shrink-0 text-zinc-400 pointer-events-none" aria-hidden="true" />
        {:else}
          <ChevronUp class="size-3.5 shrink-0 text-zinc-400 pointer-events-none" aria-hidden="true" />
        {/if}
        <span class="font-header-clock font-header-clock--fixed shrink-0 text-[10px] text-zinc-500 leading-none pointer-events-none">{clockTimeStr}</span>
      </button>
    </div>
    <div
      class="week-calendar-panel grid"
      class:week-calendar-panel--open={!weekCalendarCollapsed}
      class:week-calendar-panel--closing={weekCalendarClosing}
      style="grid-template-rows: {weekCalendarCollapsed ? '0fr' : '1fr'}"
    >
      <div class="overflow-hidden min-h-0 {weekCalendarCollapsed ? 'pointer-events-none' : ''}">
        <div class="flex items-stretch">
          <button 
            class="w-5 shrink-0 flex items-center justify-center bg-[#141414] border-r border-[#1e1e1e] text-zinc-400 hover:text-white active:bg-[#0d0d0d] transition disabled:opacity-40"
            onclick={goPrevWeek}
            title="Previous week"
            disabled={workoutState === 'active'}
          >
            <ChevronLeft class="size-3.5" />
          </button>
          <div
            class="day-strip grid grid-cols-7 gap-0.5 flex-1 min-w-0 bg-[#141414] p-1 {weekCalendarClosing
              ? 'week-calendar-closing'
              : !weekCalendarCollapsed
                ? 'week-calendar-open'
                : ''}"
          >
            {#each currentWeekDates as dayInfo (dayInfo.key)}
              {@const isSelected = dayInfo.key === selectedDateStr}
              {@const isRealToday = dayInfo.isRealToday}
              {@const daySchedule = schedule[dayInfo.weekday]}
              {@const hasTemplate = !!daySchedule?.template_id}
              {@const isRest = !hasTemplate}
              {@const dayLog = isRealToday ? todayLog : (weekLogs[dayInfo.key] ?? null)}
              {@const dayHasWorkoutLog = !!dayLog && !dayLog.workout_snapshot?.is_rest}
              {@const dayDone = isRealToday ? (workoutState === 'done' && !eraseRevertAnimating) : false}
              {@const daySkipped = isRealToday
                ? ((workoutState === 'skipped' || skipRevertAnimating) && !eraseRevertAnimating)
                : !!dayLog?.is_skipped}
              {@const effStatus = eraseRevertAnimating && isRealToday
                ? 'neutral'
                : skipRevertAnimating && isRealToday
                  ? 'skipped'
                  : isRealToday
                    ? (justFinishedStatus ?? todayCompletionStatus)
                    : viewedCompletionStatus}
              <button 
                class="day-btn aspect-square w-full flex flex-col items-center justify-center gap-0 rounded-md text-[10px] font-bold tracking-wide border-none bg-transparent text-zinc-600 hover:text-white relative origin-center
                  {(dayDone || (isSelected && !isRealToday && viewedLog && viewedCompletionStatus !== 'neutral' && viewedCompletionStatus !== 'skipped')) ? (effStatus === 'green' ? 'w-cal-green' : 'w-cal-yellow') : ''} 
                  {daySkipped ? 'w-cal-skipped' : ''} 
                  {(isSelected && !isRealToday && !dayDone && !daySkipped && !(viewedLog && viewedCompletionStatus !== 'neutral')) ? '!bg-[#1e1e1e] !text-white' : ''} 
                  {isRealToday && !dayDone && !daySkipped ? '!bg-white !text-black hover:!text-black' : ''} 
                  {isRest && !isSelected && !dayDone && !daySkipped ? 'text-zinc-500' : ''}"
                onclick={() => selectDate(dayInfo.date)}
                disabled={workoutState === 'active'}
                title={DAY_NAMES[dayInfo.weekday] + ' ' + dayInfo.key}
              >
                <div class="flex flex-col items-center justify-center leading-none">
                  <span class="text-[8px] font-bold tracking-[1px] {isSelected ? 'opacity-100' : 'opacity-60'}">{dayInfo.letter}</span>
                  <span class="text-[11px] font-black tabular-nums leading-none">{dayInfo.num}</span>
                </div>
                {#if isSelected}
                  <span class="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-px bg-current rounded-full"></span>
                {/if}
                {#if dayHasWorkoutLog && !isSelected && !isRealToday}
                  <span class="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-0.5 h-0.5 rounded-full bg-[var(--w-yellow-fg)] opacity-60"></span>
                {/if}
              </button>
            {/each}
          </div>
          <button 
            class="w-5 shrink-0 flex items-center justify-center bg-[#141414] border-l border-[#1e1e1e] text-zinc-400 hover:text-white active:bg-[#0d0d0d] transition disabled:opacity-40"
            onclick={goNextWeek}
            title="Next week"
            disabled={workoutState === 'active'}
          >
            <ChevronRight class="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  </div>

  {#snippet ctaBar(disabled = false)}
    <div class={(disabled && isViewingToday) ? 'opacity-40 pointer-events-none' : ''}>
      {#if workoutActionError}
        <p class="text-[10px] text-red-300 leading-snug mb-2">{workoutActionError}</p>
      {/if}
      {#if workoutState === 'idle' || workoutState === 'active' || workoutState === 'done' || workoutState === 'skipped'}
        <div class="grid grid-cols-5 gap-3">
          <!-- STATS (left, narrow) — matches SKIP at rest; no hold/tap interaction yet -->
          <button
            type="button"
            tabindex="-1"
            aria-disabled="true"
            class="{workoutSideBtnClass} border bg-[#0d0d0d] border-[#1e1e1e] text-zinc-500 pointer-events-none {!isViewingToday ? 'opacity-40' : ''}"
          >
            <span class={workoutSideLabelClass} style={ctaChStyle('STATS', SIDE_CTA_MAX_CH)}>STATS</span>
          </button>

          {#if workoutState === 'idle'}
            {#if skipRevertAnimating && isViewingToday}
              <button
                type="button"
                disabled
                class="{workoutCenterBtnClass} border-transparent hold-start-to-skipped"
              >
                <span
                  class={workoutCenterLabelClass}
                  style={ctaChStyle(skipRevertCenterLabel, CENTER_CTA_MAX_CH)}
                >{skipRevertCenterLabel}</span>
              </button>
              <button
                type="button"
                disabled
                class="{workoutSideBtnClass} border bg-[#0d0d0d] w-hold-skip-active hold-skip-side-to-erase"
              >
                <span
                  class={workoutSideLabelClass}
                  style={ctaChStyle(skipRevertSideLabel, SIDE_CTA_MAX_CH)}
                >{skipRevertSideLabel}</span>
              </button>
            {:else}
              <!-- Center: START WORKOUT (wider) or GO TO TODAY when on non-today -->
              {#if isViewingToday}
                <button
                  type="button"
                  class="{workoutCenterBtnClass} border-transparent bg-white text-black {startWorkoutAnimating ? 'hold-start-to-yellow' : ''}"
                  disabled={startWorkoutAnimating}
                  onclick={handleStartWorkoutTap}
                >
                  <span
                    class={workoutCenterLabelClass}
                    style={ctaChStyle(
                      startWorkoutAnimating ? startCtaLabel : START_CTA_SOURCE,
                      CENTER_CTA_MAX_CH,
                    )}
                  >
                    {startWorkoutAnimating ? startCtaLabel : START_CTA_SOURCE}
                  </span>
                </button>
              {:else}
                <button class="col-span-3 h-[52px] border-none rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-white text-black transition-all duration-150 hover:brightness-110  group !opacity-100" onclick={goToToday}>
                  <span class="transition-all group-hover:tracking-[0.2em]">GO TO TODAY</span>
                </button>
              {/if}
              <!-- Right: SKIP (hold, narrow) -- grayed when not today -->
              <button
                type="button"
                class="{workoutSideBtnClass} group border bg-[#0d0d0d] {!isViewingToday ? 'opacity-40 pointer-events-none' : ''} {startWorkoutAnimating ? 'pointer-events-none' : ''} {skipTapPulseActive ? 'hold-skip-tap-pulse' : skipProgress > 0 ? 'w-hold-skip-active' : 'border-[#1e1e1e] text-zinc-500'}"
                disabled={startWorkoutAnimating}
                onmousedown={startSkipHold}
                onmouseup={stopSkipHold}
                onmouseleave={stopSkipHold}
                ontouchstart={startSkipHold}
                ontouchend={stopSkipHold}
                onanimationend={onSkipTapPulseEnd}
              >
                <div class="absolute inset-0 z-0 bg-amber-900/40 transition-all duration-[20ms]" style="width: {skipProgress}%;"></div>
              <span
                class={workoutSideLabelClass}
                style={ctaChStyle(
                  startWorkoutAnimating ? sideCtaLabel : SKIP_CTA_SOURCE,
                  SIDE_CTA_MAX_CH,
                )}
              >
                {startWorkoutAnimating ? sideCtaLabel : SKIP_CTA_SOURCE}
              </span>
              </button>
            {/if}
          {:else if workoutState === 'active'}
            {#if cancelRevertAnimating}
              <button
                type="button"
                disabled
                class="{workoutCenterBtnClass} border-transparent bg-white text-black {cancelRevertWasPerfect ? 'hold-active-finish-green-to-start' : 'hold-active-finish-yellow-to-start'}"
              >
                <span
                  class={workoutCenterLabelClass}
                  style={ctaChStyle(cancelRevertCenterLabel, CENTER_CTA_MAX_CH)}
                >{cancelRevertCenterLabel}</span>
              </button>
              <button
                type="button"
                disabled
                class="{workoutSideBtnClass} border bg-[#0d0d0d] border-[#1e1e1e] text-zinc-500 hold-cancel-to-skip"
              >
                <span
                  class={workoutSideLabelClass}
                  style={ctaChStyle(cancelRevertSideLabel, SIDE_CTA_MAX_CH)}
                >{cancelRevertSideLabel}</span>
              </button>
            {:else}
              <!-- Center: FINISH (wider) -->
              <button
                type="button"
                class="{workoutCenterBtnClass} border-transparent {!isViewingToday ? 'opacity-40 pointer-events-none' : ''} {isPerfectDay ? 'w-cta-active-green' : 'w-cta-active-yellow'}"
                {...(finishHoldProgress > 0 ? { style: finishHoldButtonStyle } : {})}
                onmousedown={startFinishHold}
                onmouseup={stopFinishHold}
                onmouseleave={stopFinishHold}
                ontouchstart={startFinishHold}
                ontouchend={stopFinishHold}
              >
                <span
                  class={workoutCenterLabelClass}
                  style={ctaChStyle(START_CTA_TARGET, CENTER_CTA_MAX_CH)}
                >{START_CTA_TARGET}</span>
              </button>
              <!-- Right: CANCEL (hold, narrow) -->
              <button
                class="{workoutSideBtnClass} group border outline-none {!isViewingToday ? 'opacity-40 pointer-events-none' : ''} {cancelProgress > 0 ? 'cancel-btn-held' : cancelTapPulseActive ? 'hold-cancel-tap-pulse' : 'border-[#1e1e1e] bg-[#0d0d0d] text-zinc-500'}"
                onmousedown={startCancelHold}
                onmouseup={stopCancelHold}
                onmouseleave={stopCancelHold}
                ontouchstart={startCancelHold}
                ontouchend={stopCancelHold}
                onanimationend={onCancelTapPulseEnd}
              >
                <div class="absolute inset-0 z-0 bg-red-600/45 transition-all duration-[20ms]" style="width: {cancelProgress}%;"></div>
                <span class={workoutSideLabelClass} style={ctaChStyle(SKIP_CTA_TARGET, SIDE_CTA_MAX_CH)}>CANCEL</span>
              </button>
            {/if}
          {:else if workoutState === 'done'}
            {@const effectiveStatus = justFinishedStatus ?? todayCompletionStatus}
            {@const isYellowComplete = effectiveStatus === 'yellow' || effectiveStatus === 'neutral'}
            {#if eraseRevertAnimating}
              <button
                type="button"
                disabled
                class="{workoutCenterBtnClass} border-transparent bg-white text-black {isYellowComplete ? 'hold-complete-yellow-to-start' : 'hold-complete-green-to-start'}"
              >
                <span
                  class={workoutCenterLabelClass}
                  style={ctaChStyle(eraseRevertCenterLabel, CENTER_CTA_MAX_CH)}
                >{eraseRevertCenterLabel}</span>
              </button>
              <button
                type="button"
                disabled
                class="{workoutSideBtnClass} border bg-[#0d0d0d] border-[#1e1e1e] text-zinc-500 hold-erase-to-skip"
              >
                <span
                  class={workoutSideLabelClass}
                  style={ctaChStyle(eraseRevertSideLabel, SIDE_CTA_MAX_CH)}
                >{eraseRevertSideLabel}</span>
              </button>
            {:else}
              {@const completeIsYellow = finishCenterFading
                ? !finishFadeWasPerfect
                : isYellowComplete}
              <button
                class="{workoutCenterBtnClass} cursor-default {!isViewingToday ? 'opacity-40 pointer-events-none' : ''} {finishCenterFading ? 'pointer-events-none' : ''} {completeIsYellow ? 'w-cta-complete-yellow' : 'w-cta-complete-green'}"
              >
                <span
                  class="{workoutCenterLabelClass}{finishCenterFading ? ' workout-cta-text-fade workout-cta-text-fade--no-width' : ''}"
                  style="{ctaChStyle(COMPLETE_CTA_SOURCE, CENTER_CTA_MAX_CH)}{finishCenterFading ? `;opacity:${finishCenterOpacity}` : ''}"
                >{finishCenterFading ? finishCenterLabel : COMPLETE_CTA_SOURCE}</span>
              </button>
              <button
                type="button"
                class="{workoutSideBtnClass} group border bg-[#0d0d0d] hover:brightness-110 {!isViewingToday ? 'opacity-40 pointer-events-none' : ''} {finishCenterFading ? 'pointer-events-none' : ''} {eraseTapPulseActive ? 'hold-cancel-tap-pulse' : eraseProgress > 0 ? 'w-hold-erase-active' : 'border-[#1e1e1e] text-zinc-500'}"
                onmousedown={startEraseHold}
                onmouseup={stopEraseHold}
                onmouseleave={stopEraseHold}
                ontouchstart={startEraseHold}
                ontouchend={stopEraseHold}
                onanimationend={onEraseTapPulseEnd}
              >
                <div class="absolute inset-0 z-0 bg-red-900/50 transition-all duration-[20ms]" style="width: {eraseProgress}%;"></div>
                <span class={workoutSideLabelClass} style={ctaChStyle(ERASE_CTA_SOURCE, SIDE_CTA_MAX_CH)}>ERASE</span>
              </button>
            {/if}
          {:else if workoutState === 'skipped'}
            {#if eraseRevertAnimating}
              <button
                type="button"
                disabled
                class="{workoutCenterBtnClass} border-transparent bg-white text-black hold-skipped-to-start"
              >
                <span
                  class={workoutCenterLabelClass}
                  style={ctaChStyle(eraseRevertCenterLabel, CENTER_CTA_MAX_CH)}
                >{eraseRevertCenterLabel}</span>
              </button>
              <button
                type="button"
                disabled
                class="{workoutSideBtnClass} border bg-[#0d0d0d] border-[#1e1e1e] text-zinc-500 hold-erase-to-skip"
              >
                <span
                  class={workoutSideLabelClass}
                  style={ctaChStyle(eraseRevertSideLabel, SIDE_CTA_MAX_CH)}
                >{eraseRevertSideLabel}</span>
              </button>
            {:else}
              <button
                class="{workoutCenterBtnClass} w-cta-skipped cursor-default {!isViewingToday ? 'opacity-40 pointer-events-none' : ''}"
              >
                <span
                  class={workoutCenterLabelClass}
                  style={ctaChStyle(SKIPPED_CTA_SOURCE, CENTER_CTA_MAX_CH)}
                >{SKIPPED_CTA_SOURCE}</span>
              </button>
              <button
                type="button"
                class="{workoutSideBtnClass} group border bg-[#0d0d0d] hover:brightness-110 {!isViewingToday ? 'opacity-40 pointer-events-none' : ''} {eraseTapPulseActive ? 'hold-cancel-tap-pulse' : eraseProgress > 0 ? 'w-hold-erase-active' : 'border-[#1e1e1e] text-zinc-500'}"
                onmousedown={startEraseHold}
                onmouseup={stopEraseHold}
                onmouseleave={stopEraseHold}
                ontouchstart={startEraseHold}
                ontouchend={stopEraseHold}
                onanimationend={onEraseTapPulseEnd}
              >
                <div class="absolute inset-0 z-0 bg-red-900/50 transition-all duration-[20ms]" style="width: {eraseProgress}%;"></div>
                <span class={workoutSideLabelClass} style={ctaChStyle(ERASE_CTA_SOURCE, SIDE_CTA_MAX_CH)}>ERASE</span>
              </button>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  {/snippet}

    {#if (currentView === 'track' ? activeTemplate : true) && (currentView === 'track' || currentView === 'swap_template' || currentView === 'edit_template') && (isViewingToday || viewedLog || selectedDateStr > REAL_TODAY_STR || currentView !== 'track')}
      {@render ctaBar(currentView !== 'track' || !isViewingToday)}
    {/if}

  {#if currentView === 'track'}
    {@const isPast = selectedDateStr < REAL_TODAY_STR && !isViewingToday}
    {@const hasLog = !!viewedLog}
    {@const isRestLog = hasLog && viewedLog.workout_snapshot?.is_rest}
    {@const isPastNoLog = isPast && !hasLog}
    {@const currentScheduleIsRest = !activeTemplate}

    {#if templates.length === 0}
      <!-- Onboarding: entire routine is rest (starting out, or last template deleted). Not a tutorial; just a clean create-first page matching rest/unlogged style exactly. -->
      <div class="flex flex-col items-center justify-center py-10 px-2 gap-6">
        <!-- Hero icon -->
        <div class="w-20 h-20 rounded-2xl bg-[#141414] border border-[#1e1e1e] flex items-center justify-center transition-all duration-200 hover:border-[#2a2a2a]">
          <Dumbbell class="size-10 text-zinc-400" />
        </div>

        <div class="text-center">
          <div class="text-3xl font-semibold tracking-[-0.02em] text-white">START YOUR ROUTINE</div>
          <div class="text-[10px] uppercase tracking-[2px] text-zinc-500 mt-1">CREATE YOUR FIRST TEMPLATE</div>
        </div>

        <div class="max-w-[240px] text-center text-sm text-zinc-400 leading-snug hover:text-zinc-300 transition-colors duration-200">
          The only workout you regret is the one you never started.
        </div>

        <!-- Create form, same styling as other create sections and pages -->
        <form
          class="w-full max-w-xs space-y-2"
          onsubmit={(e) => { e.preventDefault(); handleCreateTemplate(); }}>
          <input 
            placeholder="Template name (e.g. Full Body, Push/Pull)" 
            class="w-full bg-black border border-[#1e1e1e] text-xs text-white p-2 rounded-lg outline-none focus:border-[#2a2a2a]" 
            bind:value={newTemplateName}
            disabled={!currentUser || isCreatingTemplate}
          />
          {#if templateError}
            <p class="text-[10px] text-red-300 leading-snug">{templateError}</p>
          {/if}
          <button 
            type="submit"
            class="w-full h-[52px] rounded-xl font-sans font-black text-[11px] tracking-[0.15em] bg-white text-black transition-all duration-150 hover:brightness-110 disabled:opacity-50"
            disabled={!currentUser || isCreatingTemplate}>
            {isCreatingTemplate ? 'CREATING…' : 'CREATE TEMPLATE'}
          </button>
        </form>
      </div>
    {:else if isPastNoLog}
      <!-- UNLOGGED for past with truly no history entry (distinguishes from current-schedule backtrack rests) -->
      <div class="flex flex-col items-center justify-center py-10 px-2 gap-6">
        <!-- Hero icon -->
        <div class="w-20 h-20 rounded-2xl bg-[#141414] border border-[#1e1e1e] flex items-center justify-center transition-all duration-200 hover:border-[#2a2a2a]">
          <FileX class="size-10 text-zinc-400" />
        </div>

        <div class="text-center">
          <div class="text-3xl font-semibold tracking-[-0.02em] text-white">UNLOGGED</div>
          <div class="text-[10px] uppercase tracking-[2px] text-zinc-500 mt-1">NO WORKOUT LOGGED FOR {selectedDateDisplay.nice}</div>
        </div>

        <div class="max-w-[240px] text-center text-sm text-zinc-400 leading-snug hover:text-zinc-300 transition-colors duration-200">
          Progress unlogged is progress lost.
        </div>

        {#if !isViewingToday}
          <button 
            class="h-[52px] border-none rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-white text-black transition-all duration-150 hover:brightness-110  w-full max-w-xs !opacity-100"
            onclick={goToToday}>
            GO TO TODAY
          </button>
        {/if}
      </div>
    {:else if isRestLog || (!isPast && currentScheduleIsRest)}
      <!-- REST DAY: current/future per schedule, or past explicitly logged rest (historical truth) -->
      <div class="flex flex-col items-center justify-center py-10 px-2 gap-6 {isFuture && !isRestLog ? 'opacity-80' : ''}">
        <!-- Hero icon -->
        <div class="w-20 h-20 rounded-2xl bg-[#141414] border border-[#1e1e1e] flex items-center justify-center transition-all duration-200 hover:border-[#2a2a2a]">
          <Bed class="size-10 text-zinc-500" />
        </div>

        <div class="text-center">
          <div class="text-3xl font-semibold tracking-[-0.02em] text-white">REST DAY</div>
          <div class="text-[10px] uppercase tracking-[2px] text-zinc-500 mt-1">
            {isRestLog ? `LOGGED FOR ${selectedDateDisplay.nice}` : 'NO TEMPLATE ASSIGNED'}
          </div>
        </div>

        <div class="max-w-[240px] text-center text-sm text-zinc-400 leading-snug hover:text-zinc-300 transition-colors duration-200">
          Recovery is where the gains happen. 
        </div>

        {#if !isViewingToday && !isRestLog}
          <button 
            class="h-[52px] border-none rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-white text-black transition-all duration-150 hover:brightness-110  w-full max-w-xs !opacity-100"
            onclick={goToToday}>
            GO TO TODAY
          </button>
        {/if}

        {#if !isRestLog}
          <!-- Week overview — tap to open routine editor -->
          <button
            type="button"
            class="w-full max-w-xs rounded-xl border border-transparent p-1 -m-1 transition-all duration-150 hover:border-[#2a2a2a] hover:bg-[#141414]/50 cursor-pointer"
            onclick={() => enterRoutineBuilder({ fromWeeklyPlan: true })}
            title="Open routine editor"
          >
            <div class="text-[9px] uppercase tracking-[1.5px] text-zinc-500 mb-2 text-center pointer-events-none">WEEKLY PLAN</div>
            <div class="grid grid-cols-7 gap-1 pointer-events-none">
              {#each weekPlan as d, i}
                <div class="flex flex-col items-center gap-0.5 transition-all duration-150">
                  <div class="text-[10px] font-medium {i === TODAY_WEEKDAY ? 'text-white' : 'text-zinc-400'}">{d.day}</div>
                  <div class="w-full aspect-square rounded-lg flex items-center justify-center border transition-all duration-150 {d.hasTemplate ? 'bg-emerald-950/30 border-emerald-900' : 'bg-[#1e1e1e] border-[#2a2a2a]'}">
                    {#if d.hasTemplate}
                      <Dumbbell class="size-3 text-emerald-400" />
                    {:else}
                      <Bed class="size-3 text-zinc-500" />
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
            <div class="text-center text-[10px] text-zinc-500 mt-2 pointer-events-none">
              {weekPlan.filter(d => d.hasTemplate).length} training • {weekPlan.filter(d => !d.hasTemplate).length} rest
            </div>
          </button>
        {:else}
          <div class="text-[10px] text-center text-zinc-500">This day was logged as a rest day. <button class="text-red-400 hover:text-red-500 underline" onclick={() => undoRestLog(selectedDateStr)}>undo</button></div>
        {/if}
      </div>
    {:else}
      <!-- Template box on main screen (supports historical past logged workouts even if current schedule has no template for the day, for edge cases like deleted templates) -->
      {#if templateSaveError}
        <p class="text-[10px] text-red-300 leading-snug px-2.5 py-2 rounded-lg border border-red-900/50 bg-red-950/30">{templateSaveError}</p>
      {/if}
      {@const useHistorical = isPast && viewedLog && !viewedLog.workout_snapshot?.is_rest}
      {@const dispTemplate = useHistorical ? { id: viewedLog.template_id, name: viewedLog.template_name_snapshot || 'Past Workout', exercises: viewedLog.workout_snapshot?.exercises || [] } : (workoutState === 'active' && activeWorkoutTemplate) ? activeWorkoutTemplate : activeTemplate}
      {@const exCount = (dispTemplate?.exercises || []).length}
      {@const setCount = (dispTemplate?.exercises || []).reduce((sum: number, ex: any) => sum + (ex.target_sets || 0), 0)}
      {@const showWorkoutCompleteTick = isViewingToday
        ? workoutState === 'done' && !eraseRevertAnimating
        : !!(viewedLog && !viewedLog.is_skipped && viewedLog.workout_snapshot && !viewedLog.workout_snapshot?.is_rest)}
      {@const tickStatus = isViewingToday ? (justFinishedStatus ?? todayCompletionStatus) : viewedCompletionStatus}
      {@const workoutTickVisible =
        showWorkoutCompleteTick && (tickStatus === 'green' || tickStatus === 'yellow')}
      {@const headerSkipped = headerSurfaceStatus === 'skipped'}
      <div
        class="tpl-header status-surface status-surface--prompt rounded-xl px-3 py-1 flex flex-col gap-0.5 {eraseRevertAnimating ? 'status-surface--instant' : ''} {headerSurfaceStatus === 'green'
          ? 'status-surface--green'
          : headerSurfaceStatus === 'yellow'
            ? 'status-surface--yellow'
            : headerSkipped
              ? 'status-surface--skipped'
              : 'status-surface--neutral'} {isFuture ? 'opacity-80' : ''}"
      >
        <div class="text-center leading-none">
          <div class="workout-label-row text-xs uppercase tracking-[1.5px] {headerSkipped ? 'w-fg-skipped' : headerSurfaceStatus === 'green' ? 'w-fg-green' : headerSurfaceStatus === 'yellow' ? 'w-fg-yellow' : 'text-zinc-500'}">
            <span class="workout-label-text">{workoutLabel}</span>
            <span
              class="workout-tick-slot"
              class:workout-tick-slot--visible={workoutTickVisible}
              aria-hidden={!workoutTickVisible}
            >
              <Check
                class="workout-complete-tick {tickStatus === 'green' ? 'w-fg-green' : 'w-fg-yellow'}"
                strokeWidth={2.5}
              />
            </span>
          </div>
        </div>
        <div class="tpl-header-body">
          <div class="flex items-center h-10 gap-2 shrink-0">
            {#if showHeaderEditActions}
              <button
                type="button"
                class="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center border bg-transparent self-center transition-opacity hover:bg-[#1a1a1a] hover:text-white {headerSurfaceStatus === 'green' ? 'w-hdr-icon-green' : headerSurfaceStatus === 'yellow' ? 'w-hdr-icon-yellow' : headerSurfaceStatus === 'skipped' ? 'w-hdr-icon-skipped' : 'border-[#1e1e1e] text-zinc-500'} {headerEditActionsFading ? 'opacity-0 pointer-events-none duration-[700ms]' : headerEditActionsRevealing ? 'header-edit-actions-reveal pointer-events-none' : isFuture ? 'opacity-70 pointer-events-none duration-150' : 'opacity-100 duration-150'}"
                onclick={() => enterRoutineBuilder()}
                title="Routine editor"
              ><CalendarDays class="size-5" /></button>
            {:else}
              <div class="w-10 h-10 shrink-0" aria-hidden="true"></div>
            {/if}
            <div class="flex-1 text-center min-w-0 self-center">
              <span class="tpl-name text-xl font-semibold tracking-tight truncate leading-none block {headerSkipped ? 'w-fg-skipped' : headerSurfaceStatus === 'green' ? 'w-fg-green' : headerSurfaceStatus === 'yellow' ? 'w-fg-yellow' : 'text-white'}">[ {dispTemplate?.name || 'Workout'} ]</span>
            </div>
            {#if showHeaderEditActions}
              <button
                type="button"
                class="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center border bg-transparent self-center transition-opacity hover:bg-[#1a1a1a] hover:text-white {headerSurfaceStatus === 'green' ? 'w-hdr-icon-green' : headerSurfaceStatus === 'yellow' ? 'w-hdr-icon-yellow' : headerSurfaceStatus === 'skipped' ? 'w-hdr-icon-skipped' : 'border-[#1e1e1e] text-zinc-500'} {headerEditActionsFading ? 'opacity-0 pointer-events-none duration-[700ms]' : headerEditActionsRevealing ? 'header-edit-actions-reveal pointer-events-none' : isFuture ? 'opacity-70 pointer-events-none duration-150' : 'opacity-100 duration-150'}"
                onclick={() => openTemplateEditor()}
                title="Edit Exercises"
              ><Pencil class="size-5" /></button>
            {:else}
              <div class="w-10 h-10 shrink-0" aria-hidden="true"></div>
            {/if}
          </div>
          <div class="tpl-header-slot">
            {#if !useHistorical && isPerfectDay}
              <span class="perfect-day-badge">PERFECT DAY</span>
            {:else}
              <div class="tpl-header-meta text-xs uppercase tracking-wide leading-none {headerSkipped ? 'w-fg-skipped-muted' : headerSurfaceStatus === 'green' ? 'w-fg-green' : headerSurfaceStatus === 'yellow' ? 'w-fg-yellow' : 'text-zinc-500'}">
                {exCount} EXERCISES • {setCount} SETS
              </div>
            {/if}
          </div>
          {#if useHistorical}
            <div class="h-1 w-full w-bg-green rounded-[1px] shrink-0"></div>
          {:else}
            <div class="flex gap-[1px] h-1 w-full shrink-0">
            {#each Array(setCounts.total) as _, i}
              <div
                class="tpl-progress-seg flex-1 rounded-[1px]"
                class:tpl-progress-seg--lit={i < setCounts.done}
                style={i < setCounts.done ? `background-color: ${progressBarColor}` : undefined}
              ></div>
            {/each}
            </div>
          {/if}
        </div>
      </div>

      <!-- Exercises in one shared box separated by horizontal dividers, with list numbers on left (like editor list) -->
      <div
        class="rounded-xl overflow-hidden border {eraseRevertAnimating ? 'status-surface--instant' : ''} {isFuture ? 'opacity-80' : ''} {headerSkipped
          ? 'status-surface status-surface--skipped'
          : 'bg-[#141414] border-[#1e1e1e]'}"
      >
        {#each (dispTemplate?.exercises || []) as exercise, index}
          {@const status = getExerciseStatus(exercise)}
          {@const exSurfaceClass = headerSkipped
            ? 'status-surface--skipped'
            : status === 'green'
              ? 'status-surface--green'
              : status === 'yellow'
                ? 'status-surface--yellow'
                : 'status-surface--neutral'}
          {@const isTimeEx = exercise.exercise_type === 'time'}
          {@const hasActiveTimerThis = isViewingToday && isTimeEx && activeTimerExerciseId === exercise.id && activeTimerSetIndex !== null}
          {@const timeTotal = isTimeEx ? (exercise.target_minutes * 60 + exercise.target_seconds) : 0}
          {@const logSrc = isViewingToday ? todayLog : viewedLog}
          {@const isDoneViewed = !!logSrc?.workout_snapshot?.exercises && (isViewingToday ? (workoutState === 'done') : true)}
          {@const loggedEx = isDoneViewed ? getLoggedEx(logSrc, exercise.id) : null}
          {@const displayCurrentWeight = loggedEx?.weight_before ?? exercise.current_weight}
          <div
            class="p-3 flex gap-1 status-surface {workoutExercisesEditable ? 'hover:brightness-110' : ''} {index > 0 ? (headerSkipped ? 'border-t border-[color:var(--w-skipped-border)]' : 'border-t border-[#1e1e1e]') : ''} {exSurfaceClass}"
          >
            <!-- list number on left: boxed, vertically centered in strip, slightly larger -->
            <div
              class="exercise-index status-surface w-6 flex-shrink-0 flex items-center justify-center rounded text-[10px] font-medium {headerSkipped ? 'text-current' : 'text-zinc-400'} {exSurfaceClass}"
            >
              {index + 1}
            </div>
            <div class="flex-1 flex flex-col gap-1.5">
              <div class="ex-top flex justify-between gap-3 {isTimeEx ? 'ex-top--time items-center' : 'items-start'}">
              <div class="truncate pr-2 min-w-0">
                <div class="ex-name-row {workoutExercisesEditable ? 'hover:brightness-110' : ''} transition-all">
                  {#if exercise.exercise_type === 'reps'}
                    <Dumbbell class="size-3.5 shrink-0 {headerSkipped ? 'text-current' : 'text-white'}" />
                  {:else}
                    <Timer class="size-3.5 shrink-0 {headerSkipped ? 'text-current' : 'text-white'}" />
                  {/if}
                  <span class="ex-name text-sm font-extrabold tracking-wide truncate {headerSkipped ? 'text-current' : 'text-white'}">{exercise.name}</span>
                  {#if showPrBadge(exercise, loggedEx)}
                    <span class="pr-badge">NEW PR</span>
                  {/if}
                </div>
                <div class="ex-meta text-xs mt-0.5 tracking-wide {headerSkipped ? 'w-fg-skipped-muted' : 'text-zinc-400'}">
                  {#if exercise.exercise_type === 'reps'}
                    {exercise.target_sets}×{exercise.target_reps} @{displayCurrentWeight ?? 0}kg +{exercise.increment}kg
                  {:else}
                    {exercise.target_sets}× {exercise.target_minutes}m {exercise.target_seconds.toString().padStart(2, '0')}s +{exercise.increment}s
                  {/if}
                </div>
              </div>

              {#if !isTimeEx}
                {#if displayCurrentWeight !== null}
                  <div class="weight-num font-timer text-2xl leading-none {headerSkipped ? 'text-current' : 'text-white'}">{displayCurrentWeight}<span class="unit text-[10px] font-sans font-normal ml-1 tracking-[1px] {headerSkipped ? 'w-fg-skipped-muted' : 'text-zinc-400'}">KG</span></div>
                {:else}
                  <!-- Narrow baseline input (fits ~3 digits) in the KG position, right-aligned -->
                  <div class="flex items-baseline justify-end">
                    <input type="number" placeholder="80" class="font-timer text-2xl leading-none text-white bg-transparent border-none outline-none w-12 text-right"
                      disabled={!workoutExercisesEditable}
                      onchange={async (e) => {
                        const val = parseFloat((e.target as HTMLInputElement).value);
                        if (val >= 0) { await db.saveExerciseBaseline(exercise.id, val); await loadData({ preserveSession: true }); }
                      }} />
                    <span class="unit text-[10px] text-zinc-400 font-normal ml-1 tracking-[1px]">KG</span>
                  </div>
                {/if}
              {:else if isTimeEx}
                {@const elapsed = countdownSeconds}
                {@const isOvertime = hasActiveTimerThis && elapsed >= timeTotal}
                {@const displaySecs =
                  hasActiveTimerThis && timeTotal > 0
                    ? isOvertime
                      ? elapsed - timeTotal
                      : timeTotal - elapsed
                    : timeTotal}
                {@const m = Math.floor(displaySecs / 60).toString().padStart(2, '0')}
                {@const s = (displaySecs % 60).toString().padStart(2, '0')}
                <div class="time-readout font-timer text-2xl {hasActiveTimerThis && isOvertime ? 'w-fg-green' : headerSkipped ? 'text-current' : 'text-white'}">
                  {#if hasActiveTimerThis && isOvertime}<span class="ex-time-digit ex-time-digit--plus">+</span>{/if}
                  <span class="ex-time-digit">{m}</span><span class="unit text-[10px] text-zinc-400 font-sans font-normal ml-1 tracking-[1px]">M</span>
                  <span class="ex-time-digit ml-1">{s}</span><span class="unit text-[10px] text-zinc-400 font-sans font-normal ml-1 tracking-[1px]">S</span>
                </div>
              {/if}
            </div>

            <!-- sets lane: placed right under name lane for "next to the name", packed to reduce empty gap -->
            {#if exercise.exercise_type === 'reps'}
              {#if exercise.current_weight !== null}
                <div class="set-row grid gap-1" style="grid-template-columns: repeat({exercise.target_sets}, minmax(0, 1fr));">
                  {#each Array(exercise.target_sets) as _, s}
                    {@const bubbleStatus = getSetBubbleStatus(exercise.id, s, exercise.target_reps)}
                    {@const repsValue = isViewingToday && useLiveSessionTracking()
                      ? trackedReps[`${exercise.id}-${s}`]
                      : getHistoricalReps(isViewingToday ? todayLog : viewedLog, exercise.id, s)}
                    {@const setKey = `${exercise.id}-${s}`}
                    {@const isEditingThisSet = editingSetKey === setKey}
                    {@const isHoldingSet = repSetHoldKey === setKey}
                    <div
                      class="set-bubble relative h-7 rounded-lg flex flex-col items-center justify-center overflow-hidden text-[10px] status-surface
                        {headerSkipped
                          ? 'set-bubble--empty status-surface--skipped'
                          : bubbleStatus === 'empty'
                            ? 'set-bubble--empty status-surface--neutral'
                            : ''}
                        {!headerSkipped && bubbleStatus === 'green' ? 'set-bubble--logged status-surface--green' : ''}
                        {!headerSkipped && bubbleStatus === 'yellow' ? 'set-bubble--logged status-surface--yellow' : ''}
                        {isHoldingSet ? 'set-bubble--holding' : ''}"
                    >
                      {#if isHoldingSet && !isEditingThisSet}
                        <div
                          class="set-bubble-hold-fill"
                          style="width: {repSetHoldProgress}%"
                        ></div>
                      {/if}

                      {#if isEditingThisSet}
                        <input type="number" id="input-{exercise.id}-{s}" value={repsValue !== undefined ? repsValue : ''} placeholder={exercise.target_reps.toString()}
                          class="absolute inset-0 z-10 w-full h-full bg-transparent border-none outline-none text-center font-sans text-[10px] font-extrabold text-white"
                          onblur={() => saveManualRepEdit(exercise.id, s)}
                          onkeydown={(e) => { if (e.key === 'Enter') saveManualRepEdit(exercise.id, s); }} />
                      {:else}
                        <button
                          type="button"
                          class="relative z-10 w-full h-full flex flex-col items-center justify-center bg-transparent border-none p-0 text-zinc-400 font-sans hover:brightness-110 select-none touch-none"
                          onmousedown={(e) => startRepSetHold(e, exercise.id, s, exercise.target_reps)}
                          onmouseup={() => stopRepSetHold(exercise.id, s)}
                          onmouseleave={cancelRepSetHold}
                          ontouchstart={(e) => startRepSetHold(e, exercise.id, s, exercise.target_reps)}
                          ontouchend={() => stopRepSetHold(exercise.id, s)}
                          ontouchcancel={cancelRepSetHold}
                          disabled={!workoutExercisesEditable}
                        >
                          <span class="sl text-[8px] tracking-wider opacity-60 block leading-none text-zinc-400">S{s + 1}</span>
                          <span class="sv text-[11px] font-extrabold block text-current leading-none">{repsValue !== undefined ? repsValue : '—'}</span>
                        </button>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            {:else}
              <div class="time-set-lane">
                {#if hasActiveTimerThis && activeTimerSetIndex !== null}
                  {@const s = activeTimerSetIndex}
                  {@const timerCubeCount = 36}
                  {@const timerMet = timeTotal > 0 && countdownSeconds >= timeTotal}
                  {@const litTimerCubes =
                    timeTotal > 0
                      ? timerMet
                        ? timerCubeCount
                        : Math.min(
                            timerCubeCount,
                            Math.floor((countdownSeconds / timeTotal) * timerCubeCount),
                          )
                      : 0}
                  <div class="time-active-bar">
                    <span class="time-active-set">S{s + 1}</span>
                    <div class="time-active-progress">
                      <div
                        class="timer-progress-cubes"
                        class:timer-progress-cubes--running={countdownRunning}
                      >
                        {#each Array(timerCubeCount) as _, i}
                          <div
                            class="timer-progress-cube"
                            class:timer-progress-cube--lit={i < litTimerCubes}
                            class:timer-progress-cube--met={timerMet && i < litTimerCubes}
                          ></div>
                        {/each}
                      </div>
                    </div>
                    <div class="time-active-actions">
                      <button
                        type="button"
                        class="timer-control-btn"
                        onclick={toggleExerciseTimer}
                        aria-label={countdownRunning ? 'Pause timer' : 'Resume timer'}
                      >
                        {#if countdownRunning}<Pause class="size-3.5 fill-current" />{:else}<Play class="size-3.5 fill-current" />{/if}
                      </button>
                      <button
                        type="button"
                        class="timer-control-btn"
                        aria-label="Stop and save set"
                        onclick={() => stopAndSaveTimedSet(exercise.id, s, timeTotal)}
                      >
                        <Square class="size-3.5 fill-current" />
                      </button>
                    </div>
                  </div>
                {:else}
                  <div
                    class="set-row set-row--time grid gap-1 h-7"
                    style="grid-template-columns: repeat({exercise.target_sets}, minmax(0, 1fr));"
                  >
                    {#each Array(exercise.target_sets) as _, s}
                      {@const bubbleStatus = getSetBubbleStatus(exercise.id, s, undefined, exercise)}
                      {@const saved = isViewingToday && useLiveSessionTracking()
                        ? completedTimers[`${exercise.id}-${s}`]
                        : getHistoricalTime(
                            isViewingToday ? todayLog : viewedLog,
                            exercise.id,
                            s,
                            timeTotal,
                          )}
                      <div
                        class="set-bubble relative h-7 rounded-lg flex flex-col items-center justify-center overflow-hidden text-[10px] status-surface
                          {headerSkipped
                            ? 'set-bubble--empty status-surface--skipped'
                            : bubbleStatus === 'empty'
                              ? 'set-bubble--empty status-surface--neutral'
                              : ''}
                          {!headerSkipped && bubbleStatus === 'green' ? 'set-bubble--logged status-surface--green' : ''}
                          {!headerSkipped && bubbleStatus === 'yellow' ? 'set-bubble--logged status-surface--yellow' : ''}"
                      >
                        <button
                          type="button"
                          class="relative z-10 w-full h-full flex flex-col items-center justify-center bg-transparent border-none p-0 font-sans {workoutExercisesEditable ? 'hover:brightness-110' : ''} {headerSkipped ? 'text-current' : 'text-white'}"
                          onclick={() => activateOrSwitchTimeSet(exercise.id, s)}
                          disabled={!workoutExercisesEditable}
                        >
                          <span class="sl text-[8px] tracking-wider opacity-60 block leading-none text-zinc-400">S{s + 1}</span>
                          <span class="sv font-timer text-[11px] block text-current leading-none tabular-nums">{saved ? saved.result : '—'}</span>
                        </button>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}

  {:else if currentView === 'swap_template'}
    <!-- Routine editor: assign templates to full SMTWTFS week -->
    <div class="bg-[#141414] border border-[#1e1e1e] rounded-xl p-3 space-y-3">
      <div class="flex items-center gap-2 border-b border-[#1e1e1e] pb-2 min-h-8">
        <button
          type="button"
          class="w-8 h-8 shrink-0 rounded-lg border border-[#1e1e1e] bg-transparent text-white flex items-center justify-center"
          title="Save and go back"
          onclick={exitRoutineEditor}
        >
          <ArrowLeft class="size-4" />
        </button>
        <span class="text-xs font-bold tracking-wider text-zinc-400 leading-none shrink-0">ROUTINE EDITOR</span>
        <div class="flex-1 min-w-0 flex items-center">
          <span
            class="w-full h-8 flex items-center justify-center px-2 rounded border bg-black text-xs font-medium truncate leading-none text-center {builderAssignedTemplateId === null ? 'border-[#2a2a2a] text-zinc-400' : 'border-emerald-700 text-emerald-400'}"
          >{builderDayAssignmentLabel}</span>
        </div>
      </div>

      <div class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none text-center">CLICK DAY TO ASSIGN</div>
      <div class="grid grid-cols-7 gap-1">
        {#each DAYS as d, i}
          {@const hasTemplate = !!builderAssignments[i]}
          <button
            type="button"
            class="flex flex-col items-center gap-0.5 transition-all duration-150"
            onclick={() => { builderEditingDay = i; }}
          >
            <div class="text-[10px] font-medium leading-none {builderEditingDay === i ? 'text-white' : 'text-zinc-400'}">{d}</div>
            <div
              class="w-full aspect-square rounded-lg flex items-center justify-center border transition-all duration-150 {builderEditingDay === i ? 'border-white' : hasTemplate ? 'border-emerald-900 hover:border-emerald-700' : 'border-[#2a2a2a] hover:border-[#3a3a3a]'} {hasTemplate ? 'bg-emerald-950/30' : 'bg-[#1e1e1e]'}"
            >
              {#if hasTemplate}
                <Dumbbell class="size-3 text-emerald-400" />
              {:else}
                <Bed class="size-3 text-zinc-500" />
              {/if}
            </div>
          </button>
        {/each}
      </div>

      <div class="space-y-1.5">
        <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">TEMPLATES</span>
        <div class="flex flex-col gap-1 min-w-0">
          <div class="flex items-stretch gap-1 h-8">
            <div
              class="w-6 h-8 shrink-0 flex items-center justify-center border rounded leading-none transition-colors {builderAssignedTemplateId === null ? 'bg-[#1e1e1e] border-[#2a2a2a]' : 'bg-[#141414] border-[#1e1e1e]'}"
              aria-hidden="true"
            >
              <Bed class="size-3 text-zinc-500" />
            </div>
            <button
              type="button"
              class="flex-1 h-8 min-w-0 px-1.5 border rounded text-xs flex items-center gap-1 cursor-pointer transition-colors text-zinc-400 hover:border-[#2a2a2a] {builderAssignedTemplateId === null ? 'bg-[#1e1e1e] border-[#2a2a2a] hover:bg-[#141414]' : 'bg-[#0d0d0d] border-[#1e1e1e] hover:bg-[#141414]'}"
              onclick={() => assignTemplateToBuilderDay(null)}
            >
              <span class="font-medium truncate leading-none flex-1 min-w-0 text-left">[ REST DAY ]</span>
              {#if builderAssignedTemplateId === null}
                <span class="text-[9px] shrink-0 bg-[#1e1e1e] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-zinc-500 leading-none">ASSIGNED</span>
              {/if}
            </button>
          </div>

          {#each templates as template, index (template.id)}
            {@const isAssigned = builderAssignedTemplateId === template.id}
            <div class="flex items-stretch gap-1 h-8">
              <div
                class="w-6 h-8 shrink-0 flex items-center justify-center border rounded text-[10px] font-medium leading-none transition-colors {isAssigned ? 'bg-emerald-950/40 border-emerald-800 text-emerald-400' : 'bg-[#141414] border-[#1e1e1e] text-zinc-400'}"
              >{index + 1}</div>
              <div
                class="flex-1 h-8 min-w-0 px-1.5 border rounded text-xs flex items-center cursor-pointer transition-colors {isAssigned ? 'bg-emerald-950/10 border-emerald-500 text-emerald-400 hover:bg-emerald-950/20' : 'bg-[#0d0d0d] border-[#1e1e1e] text-zinc-400 hover:bg-[#141414] hover:border-[#2a2a2a] hover:text-white'}"
                role="button"
                tabindex="0"
                onclick={() => assignTemplateToBuilderDay(template.id)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); assignTemplateToBuilderDay(template.id); } }}
              >
                <div class="flex items-center gap-1 min-w-0 flex-1">
                  {#if editingRoutineTemplateNameId === template.id}
                    <span class="shrink-0 {isAssigned ? 'text-emerald-400' : 'text-white'}">[</span>
                    <input
                      type="text"
                      value={template.name}
                      use:focusExerciseNameInput
                      onclick={(e) => e.stopPropagation()}
                      oninput={(e) => {
                        template.name = (e.currentTarget as HTMLInputElement).value;
                      }}
                      onblur={() => commitRoutineTemplateNameEdit(template)}
                      onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Escape') {
                          e.preventDefault();
                          (e.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      class="font-medium bg-transparent border-0 p-0 m-0 focus:outline-none focus:ring-0 text-xs flex-1 min-w-0 truncate leading-none {isAssigned ? 'text-emerald-400' : 'text-white'}"
                    />
                    <span class="shrink-0 {isAssigned ? 'text-emerald-400' : 'text-white'}">]</span>
                  {:else}
                    <span
                      class="font-medium truncate leading-none flex-1 min-w-0 select-none {isAssigned ? 'text-emerald-400' : 'text-white'}"
                      ondblclick={(e) => {
                        e.stopPropagation();
                        beginRoutineTemplateNameEdit(template.id);
                      }}
                    >[ {template.name} ]</span>
                  {/if}
                  {#if isAssigned}
                    <span class="text-[9px] shrink-0 bg-emerald-950 px-1.5 py-0.5 rounded border border-emerald-800 leading-none">ASSIGNED</span>
                  {/if}
                  {#if isAssigned}
                    <button
                      type="button"
                      class="w-6 h-6 shrink-0 flex items-center justify-center rounded border border-emerald-800 bg-emerald-950/50 text-emerald-400 hover:text-emerald-300 hover:border-emerald-700 transition-colors"
                      title="Edit template"
                      onclick={(e) => { e.stopPropagation(); openTemplateEditor(template.id); }}
                    >
                      <Pencil class="size-3 pointer-events-none" />
                    </button>
                    <button
                      type="button"
                      class="w-6 h-6 shrink-0 flex items-center justify-center rounded border border-red-900/80 bg-red-950/50 text-red-400 hover:text-red-300 hover:border-red-800 transition-colors"
                      title="Delete template"
                      onclick={(e) => { e.stopPropagation(); deleteTemplateInBuilder(template); }}
                    >
                      <Trash2 class="size-3 pointer-events-none" />
                    </button>
                  {/if}
                </div>
              </div>
            </div>
          {/each}
        </div>

        {#if templateError}
          <p class="text-[10px] text-red-300 leading-snug">{templateError}</p>
        {/if}

        <button
          type="button"
          class="w-full h-7 shrink-0 mt-1.5 rounded border border-[#1e1e1e] bg-white flex items-center justify-center text-black hover:bg-zinc-100 hover:border-[#2a2a2a] transition disabled:opacity-50"
          onclick={createTemplateFromRoutineBuilder}
          disabled={!currentUser}
          title="Create template"
          aria-label="Create template"
        >
          <Plus class="size-4" strokeWidth={2.5} />
        </button>
      </div>
    </div>

  {:else if currentView === 'edit_template'}
    <div class="bg-[#141414] border border-[#1e1e1e] rounded-xl p-3 space-y-3">
      <div class="flex items-center gap-2 border-b border-[#1e1e1e] pb-2 min-h-8">
        <button 
          class="w-8 h-8 shrink-0 rounded-lg border border-[#1e1e1e] bg-transparent text-white flex items-center justify-center"
          onclick={exitEditTemplate}
          title="Save and go back"
        >
          <ArrowLeft class="size-4" />
        </button>
        <span class="text-xs font-bold tracking-wider text-zinc-400 leading-none shrink-0">TEMPLATE EDITOR</span>
        <input 
          bind:value={draftTemplateName} 
          class="flex-1 min-w-0 h-8 bg-black border border-[#1e1e1e] text-xs text-white text-center px-2.5 rounded-lg outline-none focus:border-[#2a2a2a] placeholder:text-zinc-600"
          placeholder="Template name"
          disabled={!editingTemplate}
        />
      </div>

      {#if !editingTemplate}
        <div class="text-center py-6">
          <p class="text-xs text-zinc-500 mb-2">No template loaded for this weekday.</p>
          <button class="px-3 py-1 bg-[#141414] border border-[#1e1e1e] text-xs font-bold rounded-lg" onclick={() => enterRoutineBuilder()}>Assign or Create</button>
        </div>
      {:else}
        <!-- Exercises + properties: shared grid keeps headers, divider, and footers aligned -->
        <div class="grid grid-cols-[minmax(0,1fr)_9.25rem] gap-x-2 gap-y-1.5 items-stretch">
          <div class="col-start-1 row-start-1 h-5 flex items-center">
            <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">EXERCISES</span>
          </div>
          <div class="col-start-2 row-start-1 h-5 flex items-center border-l border-[#1e1e1e] pl-2">
            <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">PROPERTIES</span>
          </div>

          <div class="col-start-1 row-start-2 flex flex-col gap-1 min-h-0 min-w-0 self-stretch">
            {#if draftExercises.length === 0}
              <div class="text-center py-3 border border-dashed border-[#1e1e1e] rounded-lg text-[10px] text-zinc-500">No exercises yet. Tap + below.</div>
            {/if}

            <div class="space-y-1 flex-1 min-h-0">
              {#each draftExercises as exercise, index (exercise.id)}
                {@const isSelected = selectedExerciseId === exercise.id}
                <div 
                  class="flex items-stretch gap-1 h-8"
                  draggable="true"
                  ondragstart={(e) => handleDragStart(e, index)}
                  ondragover={handleDragOver}
                  ondrop={(e) => handleDrop(e, index)}
                  ondragend={handleDragEnd}
                >
                  <button
                    type="button"
                    class="w-5 h-8 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing border-0 bg-transparent p-0 transition-colors {isSelected ? 'text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'}"
                    title="Drag to reorder — click to select"
                    onclick={() => selectExercise(exercise.id)}
                  >
                    <GripVertical class="size-3 pointer-events-none" />
                  </button>
                  <button
                    type="button"
                    class="w-6 h-8 shrink-0 flex items-center justify-center border rounded text-[10px] font-medium leading-none transition-colors {isSelected ? 'bg-emerald-950/40 border-emerald-800 text-emerald-400' : 'bg-[#141414] border-[#1e1e1e] text-zinc-400 hover:border-[#2a2a2a] hover:text-zinc-200'}"
                    onclick={() => selectExercise(exercise.id)}
                  >
                    {index + 1}
                  </button>
                  <div 
                    class="flex-1 h-8 min-w-0 px-1.5 border rounded text-xs flex items-center cursor-pointer transition-colors {isSelected ? 'bg-emerald-950/10 border-emerald-500 text-emerald-400' : 'bg-[#0d0d0d] border-[#1e1e1e] hover:bg-[#141414] hover:border-[#2a2a2a]'}"
                    onclick={() => selectExercise(exercise.id)}
                  >
                    <div class="flex items-center gap-1 min-w-0 flex-1">
                      {#if exercise.exercise_type === 'reps'}
                        <Dumbbell class="size-3 shrink-0 {isSelected ? 'text-emerald-400' : 'text-white'}" />
                      {:else}
                        <Timer class="size-3 shrink-0 {isSelected ? 'text-emerald-400' : 'text-white'}" />
                      {/if}
                      {#if editingExerciseNameId === exercise.id}
                        <input
                          type="text"
                          value={exercise.name}
                          use:focusExerciseNameInput
                          onclick={(e) => e.stopPropagation()}
                          oninput={(e) => {
                            exercise.name = (e.currentTarget as HTMLInputElement).value;
                          }}
                          onblur={endExerciseNameEdit}
                          onkeydown={(e) => {
                            if (e.key === 'Enter' || e.key === 'Escape') {
                              e.preventDefault();
                              (e.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          class="font-medium bg-transparent border-0 p-0 m-0 focus:outline-none focus:ring-0 text-xs flex-1 min-w-0 truncate leading-none {isSelected ? 'text-emerald-400' : 'text-white'}"
                          placeholder="Name"
                        />
                      {:else}
                        <span
                          class="font-medium text-xs flex-1 min-w-0 truncate leading-none select-none {isSelected ? 'text-emerald-400' : 'text-white'}"
                          ondblclick={(e) => {
                            e.stopPropagation();
                            beginExerciseNameEdit(exercise.id);
                          }}
                        >{exercise.name || 'Name'}</span>
                      {/if}
                      {#if isSelected}
                        <button
                          type="button"
                          class="w-6 h-6 shrink-0 flex items-center justify-center rounded border border-red-900/80 bg-red-950/50 text-red-400 hover:text-red-300 hover:border-red-800 transition-colors"
                          title="Delete exercise"
                          onclick={(e) => { e.stopPropagation(); deleteSelectedExercise(); }}
                        >
                          <Trash2 class="size-3 pointer-events-none" />
                        </button>
                      {/if}
                    </div>
                  </div>
                </div>
              {/each}
            </div>

            <button
              type="button"
              class="w-full h-7 shrink-0 mt-1.5 rounded border border-[#1e1e1e] bg-white flex items-center justify-center text-black hover:bg-zinc-100 hover:border-[#2a2a2a] transition active:scale-[0.99]"
              onclick={addNewExercise}
              title="Add exercise"
              aria-label="Add exercise">
              <Plus class="size-4" strokeWidth={2.5} />
            </button>
          </div>

          <div class="col-start-2 row-start-2 flex flex-col min-h-0 self-stretch border-l border-[#1e1e1e] pl-2">
            <div class="flex-1 flex flex-col min-h-0 h-full">
              {#if selectedExerciseId}
                {@const ex = draftExercises.find((e: any) => e.id === selectedExerciseId)}
                {#if ex}
                  <div class="space-y-2">
                  <div
                    class="relative grid grid-cols-2 rounded-lg border border-[#1e1e1e] bg-[#0a0a0a] p-0.5"
                    role="group"
                    aria-label="Exercise type">
                    <div
                      class="pointer-events-none absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-4px)] rounded-md border border-[#2a2a2a] bg-[#141414] transition-transform duration-200 ease-out"
                      style="transform: translateX({ex.exercise_type === 'time' ? 'calc(100% + 4px)' : '0'})"
                    ></div>
                    <button
                      type="button"
                      class="relative z-10 h-7 flex items-center justify-center text-[9px] font-bold tracking-[0.12em] transition-colors {ex.exercise_type === 'reps' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}"
                      onclick={() => { ex.exercise_type = 'reps'; }}
                    >REPS</button>
                    <button
                      type="button"
                      class="relative z-10 h-7 flex items-center justify-center text-[9px] font-bold tracking-[0.12em] transition-colors {ex.exercise_type === 'time' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}"
                      onclick={() => { ex.exercise_type = 'time'; }}
                    >TIME</button>
                  </div>

                  {#if ex.exercise_type === 'reps'}
                    <div class="grid grid-cols-2 gap-1 text-[9px]">
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Sets</span>
                        <input type="number" class="w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" value={ex.target_sets} oninput={(e) => { ex.target_sets = +(e.currentTarget as HTMLInputElement).value; }} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Reps</span>
                        <input type="number" class="w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" value={ex.target_reps} oninput={(e) => { ex.target_reps = +(e.currentTarget as HTMLInputElement).value; }} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Base kg</span>
                        <input type="number" class="w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" value={ex.current_weight ?? 0} oninput={(e) => { ex.current_weight = +(e.currentTarget as HTMLInputElement).value; }} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">+ kg</span>
                        <input type="number" step="0.5" class="w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" value={ex.increment} oninput={(e) => { ex.increment = +(e.currentTarget as HTMLInputElement).value; }} />
                      </div>
                    </div>
                  {:else}
                    <div class="grid grid-cols-2 gap-1 text-[9px]">
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Sets</span>
                        <input type="number" class="w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" value={ex.target_sets} oninput={(e) => { ex.target_sets = +(e.currentTarget as HTMLInputElement).value; }} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Min</span>
                        <input type="number" class="w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" value={ex.target_minutes} oninput={(e) => { ex.target_minutes = +(e.currentTarget as HTMLInputElement).value; }} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Sec</span>
                        <input type="number" class="w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" value={ex.target_seconds} oninput={(e) => { ex.target_seconds = +(e.currentTarget as HTMLInputElement).value; }} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">+ s</span>
                        <input type="number" class="w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" value={ex.increment} oninput={(e) => { ex.increment = +(e.currentTarget as HTMLInputElement).value; draftExercises = [...draftExercises]; }} />
                      </div>
                    </div>
                  {/if}
                  </div>
                {/if}
              {:else}
                <div class="flex-1 min-h-0 flex items-center justify-center text-center px-1 text-[9px] leading-snug text-zinc-500 border border-dashed border-[#1e1e1e] rounded-lg">Select an exercise to edit.</div>
              {/if}
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/if}
    </div>
  {:else if !bootOverlayVisible}
    <div class="flex flex-1 flex-col items-center justify-center pt-0 pb-10 px-2 gap-6 text-center min-h-0 -translate-y-6">
      <div class="w-20 h-20 rounded-2xl bg-[#141414] border border-[#1e1e1e] flex items-center justify-center transition-all duration-200 hover:border-[#2a2a2a]">
        <Dumbbell class="size-10 text-zinc-400" />
      </div>

      <div class="text-center">
        <div class="text-6xl font-black tracking-[8px] text-white">LIFT</div>
        <div class="text-2xl font-light tracking-[6px] text-zinc-300 -mt-3">TRACKER</div>
        <div class="text-[10px] tracking-[2px] text-emerald-400/70 mt-1">v0.0.1</div>
      </div>

      <div class="w-full max-w-[300px] rounded-xl border border-[#1e1e1e] bg-[#141414] overflow-hidden">
        <div class="flex gap-1 p-1 border-b border-[#1e1e1e] bg-[#111]">
          <button
            type="button"
            class="flex-1 h-9 rounded-lg text-[10px] font-black tracking-[0.12em] transition-all {authMode === 'signin' ? 'bg-white text-black' : 'text-zinc-500 hover:text-white'}"
            disabled={signingIn}
            onclick={() => setAuthMode('signin')}>
            SIGN IN
          </button>
          <button
            type="button"
            class="flex-1 h-9 rounded-lg text-[10px] font-black tracking-[0.12em] transition-all {authMode === 'signup' ? 'bg-white text-black' : 'text-zinc-500 hover:text-white'}"
            disabled={signingIn}
            onclick={() => setAuthMode('signup')}>
            SIGN UP
          </button>
        </div>

        <div class="p-3 text-left">
          {#if authError}
            <p class="text-xs text-red-300 leading-snug px-2.5 py-2 mb-2.5 rounded-lg border border-red-900/50 bg-red-950/30">
              {authError}
            </p>
          {:else if authSuccess}
            <p class="text-xs text-emerald-300 leading-snug px-2.5 py-2 mb-2.5 rounded-lg border border-emerald-900/50 bg-emerald-950/30">
              {authSuccess}
            </p>
          {/if}

          <div class="relative mb-3" aria-hidden="true">
            <div class="flex justify-between gap-1.5 pointer-events-none select-none">
              <div
                class="relative overflow-hidden after:absolute after:inset-0 after:z-[1] after:bg-black/50 after:pointer-events-none after:content-[''] h-11 w-11 shrink-0 rounded-xl border border-[#1e1e1e] flex items-center justify-center bg-[#0a0a0a] text-zinc-400">
                <Mail class="size-5 relative z-0" />
              </div>
              <div
                class="relative overflow-hidden after:absolute after:inset-0 after:z-[1] after:bg-black/50 after:pointer-events-none after:content-[''] h-11 w-11 shrink-0 rounded-xl border border-[#30363d] flex items-center justify-center bg-[#24292f] text-white">
                <AuthBrandIcon brand="github" class="size-5 text-white relative z-0" />
              </div>
              <div
                class="relative overflow-hidden after:absolute after:inset-0 after:z-[1] after:bg-black/50 after:pointer-events-none after:content-[''] h-11 w-11 shrink-0 rounded-xl border border-[#dadce0] flex items-center justify-center bg-white">
                <AuthBrandIcon brand="google" class="size-5 relative z-0" />
              </div>
              <div
                class="relative overflow-hidden after:absolute after:inset-0 after:z-[1] after:bg-black/50 after:pointer-events-none after:content-[''] h-11 w-11 shrink-0 rounded-xl border border-[#4752c4] flex items-center justify-center bg-[#5865F2] text-white">
                <AuthBrandIcon brand="discord" class="size-5 text-white relative z-0" />
              </div>
              <div
                class="relative overflow-hidden after:absolute after:inset-0 after:z-[1] after:bg-black/50 after:pointer-events-none after:content-[''] h-11 w-11 shrink-0 rounded-xl border border-[#333] flex items-center justify-center bg-black text-white">
                <AuthBrandIcon brand="x" class="size-5 text-white relative z-0" />
              </div>
            </div>
            <div
              class="absolute inset-0 z-10 flex items-center justify-center rounded-xl pointer-events-none px-1">
              <p
                class="text-[10px] font-black tracking-[0.1em] uppercase text-white text-center leading-tight"
                style="text-shadow: 0 0 2px rgba(0,0,0,0.7), 0 1px 2px rgba(0,0,0,0.55);">
                CURRENTLY UNDER DEVELOPMENT
              </p>
            </div>
          </div>

          <form
            class="flex flex-col gap-2.5"
            onsubmit={(e) => {
              e.preventDefault();
              if (authCredentialMethod === 'email') handleEmailAuth();
              else handleUsernameAuth();
            }}>
            {#if authCredentialMethod === 'email'}
              <div class="relative">
                <Mail class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-zinc-500 pointer-events-none" />
                <input
                  type="email"
                  autocomplete="email"
                  bind:value={authEmail}
                  disabled={signingIn}
                  placeholder="you@example.com"
                  class="h-11 w-full pl-10 pr-3 rounded-xl bg-[#0a0a0a] border border-[#1e1e1e] text-sm text-white placeholder:text-zinc-600 outline-none focus:border-zinc-500 disabled:opacity-60"
                />
              </div>
            {:else}
              <div class="relative">
                <User class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-zinc-500 pointer-events-none" />
                <input
                  type="text"
                  autocomplete="username"
                  spellcheck="false"
                  bind:value={authUsername}
                  disabled={signingIn}
                  placeholder="username"
                  class="h-11 w-full pl-10 pr-3 rounded-xl bg-[#0a0a0a] border border-[#1e1e1e] text-sm text-white placeholder:text-zinc-600 outline-none focus:border-zinc-500 disabled:opacity-60"
                />
              </div>
            {/if}
            <div class="relative">
              <Lock class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-zinc-500 pointer-events-none" />
              <input
                type="password"
                autocomplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                bind:value={authPassword}
                disabled={signingIn}
                placeholder="••••••••"
                class="h-11 w-full pl-10 pr-3 rounded-xl bg-[#0a0a0a] border border-[#1e1e1e] text-sm text-white placeholder:text-zinc-600 outline-none focus:border-zinc-500 disabled:opacity-60"
              />
            </div>
            {#if authMode === 'signup'}
              <div
                class="relative"
                transition:slide={{ duration: 280, easing: cubicOut }}>
                <LockKeyhole class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-zinc-500 pointer-events-none z-10" />
                <input
                  type="password"
                  autocomplete="new-password"
                  bind:value={authConfirmPassword}
                  disabled={signingIn}
                  placeholder="••••••••"
                  class="h-11 w-full pl-10 pr-3 rounded-xl bg-[#0a0a0a] border border-[#1e1e1e] text-sm text-white placeholder:text-zinc-600 outline-none focus:border-zinc-500 disabled:opacity-60"
                />
              </div>
            {/if}
            <button
              type="submit"
              class="h-11 rounded-xl font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-emerald-600 text-white hover:brightness-110 disabled:opacity-60"
              disabled={signingIn}>
              {authMode === 'signup' ? 'CREATE ACCOUNT' : 'SIGN IN'}
            </button>
          </form>
        </div>
      </div>
    </div>
  {/if}

  {#if bootOverlayVisible}
    <div
      class="boot-overlay"
      class:boot-overlay--exit={bootOverlayExiting}
      ontransitionend={onBootOverlayTransitionEnd}
    >
      {@render bootScreen()}
    </div>
  {/if}
  </div>

  <div class="mt-auto pt-5 text-center text-[9px] tracking-[1px] text-zinc-500 shrink-0">
    © 2026 LIFT TRACKER — All rights reserved. Arya
  </div>

</div>
