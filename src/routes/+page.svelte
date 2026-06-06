<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { PUBLIC_SUPABASE_URL } from '$env/static/public';
  import { db, supabase, formatAccountError, formatAuthError, formatDbError, getAuthDisplayName, getAuthRedirectError, isUsernameAccount, isWorkoutInProgress, MAX_PASSWORD_LEN, MAX_USERNAME_LEN, sanitizePasswordInput, sanitizeUsernameInput, validateEmail, validatePassword, validateUsername, type Template, type Exercise, type WorkoutHistory } from '$lib/db';
  import { getDbActivitySnapshot, subscribeDbActivity, subscribeDbActivitySnapshot } from '$lib/dbActivity';
  import {
    formatBytes,
    formatSessionExpiry,
    formatSupabaseLatencyMs,
    fetchUserDataUsage,
    getSupabaseProjectInfo,
    loadSupabaseHealthSnapshot,
    loadSupabasePanelSnapshot,
    SUPABASE_HEALTH_POLL_MS,
    type SupabasePanelSnapshot,
  } from '$lib/supabaseStatus';
  import {
    clampTrackedRepsFieldInput,
    clampBaseKgFieldInput,
    formatOneDecimal,
    sanitizeTemplateName,
    validateDraftExercises,
    normalizeDraftExercise,
    DEFAULT_INCREMENT_SEC,
    DEFAULT_TARGET_MINUTES,
    syncClampedInput,
  } from '$lib/exerciseSanitize';
  import {
    clampedNumericProp,
    clampedTemplateNameProp,
    clampedExerciseNameProp,
  } from '$lib/clampedInputs';
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
    Lock,
    LockKeyhole,
    LogOut,
    Mail,
    Pause,
    Pencil,
    Play,
    Plus,
    Check,
    CircleAlert,
    CircleCheck,
    RefreshCw,
    Repeat,
    SkipForward,
    Square,
    Timer,
    Trash2,
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
  let dbIoFlash = $state(false);
  let dbIoFlashTimer: ReturnType<typeof setTimeout> | null = null;
  let dbActivitySnapshot = $state(getDbActivitySnapshot());
  let showSettingsPanel = $state(false);
  let supabasePanelLoading = $state(false);
  let supabasePanel = $state<SupabasePanelSnapshot | null>(null);
  let supabaseHealthPollTimer: ReturnType<typeof setInterval> | null = null;

  function flashDbIoIndicator() {
    dbIoFlash = true;
    if (dbIoFlashTimer) clearTimeout(dbIoFlashTimer);
    dbIoFlashTimer = setTimeout(() => {
      dbIoFlash = false;
      dbIoFlashTimer = null;
    }, 100);
  }

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
  let routineTemplateNameEditOriginal = $state<string | null>(null);
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
    routineTemplateNameEditOriginal = null;
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
  let newcomerBootstrapPending = $state(false);

  /** Empty app shell for new sign-ups — skips boot overlay, shows START YOUR ROUTINE immediately. */
  function bootstrapNewcomerAppState() {
    schedule = [];
    templates = [];
    todayLog = null;
    viewedLog = null;
    weekLogs = {};
    workoutState = 'idle';
    justFinishedStatus = null;
    activeWorkoutTemplate = null;
    currentView = 'track';
    hasInitialLoad = true;
    isLoading = false;
    isAuthLoading = false;
    newcomerBootstrapPending = false;
    bootOverlayVisible = false;
    bootOverlayExiting = false;
    stageRevealActive = true;
  }

  let weekCalendarCollapsed = $state(true);
  let weekCalendarClosing = $state(false);
  const WEEK_CALENDAR_MS = 260;

  function collapseWeekCalendar() {
    if (weekCalendarCollapsed) {
      weekCalendarClosing = false;
      return;
    }
    weekCalendarClosing = true;
    weekCalendarCollapsed = true;
    setTimeout(() => {
      weekCalendarClosing = false;
    }, WEEK_CALENDAR_MS);
  }

  function toggleWeekCalendar() {
    if (workoutState === 'active') return;
    if (weekCalendarCollapsed) {
      weekCalendarClosing = false;
      weekCalendarCollapsed = false;
      return;
    }
    collapseWeekCalendar();
  }

  // Auth state (powered by new db.ts + Supabase OAuth Google/GitHub)
  let currentUser = $state<any>(null);
  let isAuthLoading = $state(true);
  let showBootScreen = $derived(isAuthLoading || (currentUser !== null && isLoading));
  let bootOverlayVisible = $state(true);
  let bootOverlayExiting = $state(false);
  let stageRevealActive = $state(false);

  function onBootOverlayTransitionEnd(e: TransitionEvent) {
    if (e.propertyName !== 'opacity' || !bootOverlayExiting) return;
    bootOverlayVisible = false;
    bootOverlayExiting = false;
  }

  $effect(() => {
    if (showBootScreen) {
      bootOverlayVisible = true;
      bootOverlayExiting = false;
      stageRevealActive = false;
      return;
    }
    let cancelled = false;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    stageRevealActive = false;
    void tick().then(() => {
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (cancelled) return;
        stageRevealActive = true;
        if (currentUser && bootOverlayVisible) {
          bootOverlayExiting = true;
          fallback = setTimeout(() => {
            if (!bootOverlayExiting) return;
            bootOverlayVisible = false;
            bootOverlayExiting = false;
          }, 340);
        } else if (!currentUser) {
          bootOverlayVisible = false;
          bootOverlayExiting = false;
        }
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
  let authFeedbackExiting = $state(false);
  let authFeedbackEntering = $state(false);
  let authFeedbackExitTimer: ReturnType<typeof setTimeout> | null = null;
  const AUTH_FEEDBACK_CROSSFADE_MS = 240;

  let authFeedbackVisible = $derived(!!(authError || authSuccess));
  let authCrossfadeShowFeedback = $derived(authFeedbackVisible || authFeedbackExiting);
  let authSubmitBtnLit = $derived(
    !authFeedbackVisible || authFeedbackExiting || authFeedbackEntering,
  );
  let authFeedbackLit = $derived(
    authFeedbackVisible && !authFeedbackExiting && !authFeedbackEntering,
  );
  let authSubmitReady = $derived.by(() => {
    if (!authPassword) return false;
    if (authCredentialMethod === 'email') {
      if (!authEmail.trim()) return false;
    } else if (!authUsername.trim()) {
      return false;
    }
    if (authMode === 'signup' && !authConfirmPassword) return false;
    return true;
  });

  function finishAuthFeedbackExit() {
    if (authFeedbackExitTimer) {
      clearTimeout(authFeedbackExitTimer);
      authFeedbackExitTimer = null;
    }
    authError = null;
    authSuccess = null;
    authFeedbackExiting = false;
    authFeedbackEntering = false;
  }

  async function setAuthError(message: string | null) {
    finishAuthFeedbackExit();
    authError = message;
    if (message) {
      authSuccess = null;
      authFeedbackEntering = true;
      await tick();
      authFeedbackEntering = false;
    }
  }

  async function setAuthSuccess(message: string | null) {
    finishAuthFeedbackExit();
    authSuccess = message;
    if (message) {
      authError = null;
      authFeedbackEntering = true;
      await tick();
      authFeedbackEntering = false;
    }
  }

  async function clearAuthFeedback() {
    if (!authError && !authSuccess) return;
    if (authFeedbackExiting) return;
    authFeedbackExiting = true;
    await tick();
    authFeedbackExitTimer = setTimeout(
      finishAuthFeedbackExit,
      AUTH_FEEDBACK_CROSSFADE_MS + 20,
    );
  }

  function onAuthCrossfadeTransitionEnd(e: TransitionEvent) {
    if (e.propertyName !== 'opacity' || !authFeedbackExiting) return;
    finishAuthFeedbackExit();
  }

  let authMode = $state<'signin' | 'signup'>('signin');
  let authCredentialMethod = $state<'username' | 'email'>('username');
  let authUsername = $state('');
  let authEmail = $state('');
  let authPassword = $state('');
  let authConfirmPassword = $state('');

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
  let weekCalendarLocked = $derived(workoutState === 'active');
  let weekCalendarDisplayCollapsed = $derived(
    weekCalendarLocked || weekCalendarCollapsed,
  );

  $effect(() => {
    if (workoutState === 'active') {
      collapseWeekCalendar();
    }
  });

  $effect(() => {
    if (workoutState !== 'idle') {
      stopSkipHold();
    } else {
      stopSkipHold();
      stopEraseHold();
    }
    if (workoutState !== 'active') {
      stopCancelHold();
    }
  });
  /** Template locked in when START is pressed (finish uses this even if schedule changes). */
  let activeWorkoutTemplate = $state<Template | null>(null);
  let workoutActionError = $state<string | null>(null);
  let justFinishedStatus = $state<'green' | 'yellow' | 'untouched' | null>(null);

  // Data arrays
  let schedule = $state<any[]>([]);
  let templates = $state<Template[]>([]);
  let todayLog = $state<any>(null);

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
        const reps = displayTrackedReps();
        const times = displayCompletedTimers();
        for (let i = 0; i < (ex.target_sets || 0); i++) {
          const k = `${ex.id}-${i}`;
          if (ex.exercise_type === 'reps') {
            const repVal = reps[k];
            if (repsSetIsRecorded(repVal)) {
              done++;
              if (repsSetMeetsTarget(repVal, ex.target_reps)) green++;
            }
          } else if (times[k]) {
            done++;
            if (times[k].met) green++;
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
            if (repsSetIsRecorded(reps)) {
              done++;
              if (repsSetMeetsTarget(reps, ex.target_reps || 0)) green++;
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
              if (repsSetIsRecorded(val)) {
                done++;
                if (repsSetMeetsTarget(val, target)) green++;
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

  function isSkippedWorkoutView(): boolean {
    if (isViewingToday) {
      if (workoutState === 'idle') return false;
      return workoutState === 'skipped' || (!!todayLog && logIsSkipped(todayLog));
    }
    return logIsSkipped(viewedLog);
  }

  function displayTrackedReps(): Record<string, number> {
    return trackedReps;
  }

  function displayCompletedTimers(): Record<string, { result: string; met: boolean }> {
    return completedTimers;
  }

  let headerCompletionDisplay = $derived.by((): HeaderCompletionStatus => {
    if (isViewingToday) {
      return (justFinishedStatus ?? todayCompletionStatus) as HeaderCompletionStatus;
    }
    return viewedCompletionStatus as HeaderCompletionStatus;
  });

  function headerOutcomeCompletion(): HeaderCompletionStatus {
    return headerCompletionDisplay;
  }

  let isUntouchedDay = $derived.by(() => {
    if (isSkippedWorkoutView()) return true;
    if (!isCompletedWorkoutView()) return false;
    return headerOutcomeCompletion() === 'untouched';
  });

  let sessionStatus = $derived.by(() => {
    if (isPerfectDay) return 'green';
    if (setCounts.done > 0) return 'yellow';
    return 'neutral';
  });

  let progressBarColor = $derived.by(() => {
    const barStatus = workoutState === 'active' ? sessionStatus : headerSurfaceStatus;
    if (barStatus === 'green') return 'var(--w-green-fg)';
    if (barStatus === 'yellow') return 'var(--w-yellow-fg)';
    if (barStatus === 'skipped') return 'var(--w-skipped-fg)';
    return '#ffffff';
  });

  function logIsSkipped(log: { is_skipped?: boolean; workout_snapshot?: { skipped?: boolean } } | null) {
    return !!log?.is_skipped || !!log?.workout_snapshot?.skipped;
  }

  let todayCompletionStatus = $derived.by(() => {
    if (workoutState === 'idle') return 'neutral';
    if (workoutState === 'skipped') return 'skipped';
    if (finishSyncPending && justFinishedStatus) return justFinishedStatus;
    if (workoutState === 'active' && isWorkoutInProgress(todayLog)) return 'neutral';
    if (!todayLog) return 'neutral';
    if (logIsSkipped(todayLog)) return 'skipped';
    if (todayLog.workout_snapshot?.is_rest) return 'neutral';
    if (isWorkoutInProgress(todayLog)) return 'neutral';
    const status = completionStatusFromSnapshot(todayLog.workout_snapshot);
    if (status === 'untouched') return 'untouched';
    // Any saved today workout (non-rest) with some work logged counts as at least yellow
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

  let deleteTemplateHoldTimer: any = null;
  let deleteTemplateProgress = $state(0);
  let eraseHoldTimer: any = null;
  let eraseProgress = $state(0);
  let eraseTapPulseActive = $state(false);
  let signOutHoldTimer: ReturnType<typeof setInterval> | null = null;
  let signOutProgress = $state(0);
  let signOutTapPulseActive = $state(false);
  let deleteAccountHoldTimer: ReturnType<typeof setInterval> | null = null;
  let deleteAccountProgress = $state(0);
  let deleteAccountTapPulseActive = $state(false);
  const HOLD_CONFIRM_MS = 1000;

  const REP_SET_HOLD_MS = 250;
  const ACTIVE_SESSION_STORAGE_KEY = 'lift-tracker:active-session';
  const WORKOUT_PROGRESS_SAVE_MS = 450;
  const HEADER_TIMER_FADE_MS = 450;
  let workoutProgressSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let workoutProgressSaveInFlight = false;
  /** Bumped on finish/cancel/start so late autosaves cannot overwrite the completed log. */
  let workoutProgressSaveGen = 0;
  /** Keep showing in-memory sets until submitWorkoutSession + loadData finish. */
  let finishSyncPending = $state(false);
  const SIGN_OUT_HOLD_MS = 2000;
  const DELETE_ACCOUNT_HOLD_MS = 4000;
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
  function ctaChStyle(text: string, maxCh: number): string {
    const ch = Math.min(Math.max(text.length, 1), maxCh);
    return `--cta-ch:${ch};--cta-ch-side-max:${maxCh}`;
  }

  type HeaderSurfaceStatus = 'green' | 'yellow' | 'skipped' | 'neutral';
  type HeaderCompletionStatus = 'green' | 'yellow' | 'untouched' | 'neutral' | 'skipped';
  let headerTimerInDom = $state(false);
  let headerTimerOpaque = $state(false);
  let headerTimerFadeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Duration captured at finish — keeps header timer stable until todayLog reloads. */
  let finishedHeaderDuration = $state(0);

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
  let showHeaderEditActions = $derived.by(() => {
    if (!isViewingToday || selectedDateStr < REAL_TODAY_STR) return false;
    if (workoutState === 'skipped' || workoutState === 'done') return false;
    if (finishSyncPending) return false;
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

  let viewedCompletionStatus = $derived.by(() =>
    completionStatusForLog(viewedLog),
  );

  type DayCalendarStatus = 'green' | 'yellow' | 'neutral' | 'untouched' | 'skipped';

  /** Per-day status for week strip (never reuse the selected day's status on other cells). */
  function completionStatusForLog(log: any | null | undefined): DayCalendarStatus {
    if (!log) return 'neutral';
    if (logIsSkipped(log)) return 'skipped';
    if (log.workout_snapshot?.is_rest) return 'neutral';
    if (isWorkoutInProgress(log)) return 'neutral';
    const status = completionStatusFromSnapshot(log.workout_snapshot);
    if (status === 'untouched') return 'untouched';
    return status === 'neutral' ? 'yellow' : status;
  }

  function dayCalendarCompletionStatus(
    dayLog: any | null | undefined,
    isRealToday: boolean,
  ): DayCalendarStatus {
    if (isRealToday) return todayCompletionStatus as DayCalendarStatus;
    return completionStatusForLog(dayLog);
  }

  function completionToHeaderSurface(completion: HeaderCompletionStatus): HeaderSurfaceStatus {
    if (completion === 'untouched' || completion === 'skipped') return 'skipped';
    if (completion === 'green') return 'green';
    if (completion === 'yellow') return 'yellow';
    return 'neutral';
  }

  function exerciseStatusFromTracking(
    exercise: Exercise,
    repsMap: Record<string, number>,
    timersMap: Record<string, { result: string; met: boolean }>,
  ): 'green' | 'yellow' | 'neutral' {
    if (exercise.exercise_type === 'time') {
      let loggedSetsCount = 0;
      let allMet = true;
      for (let s = 0; s < exercise.target_sets; s++) {
        const t = timersMap[`${exercise.id}-${s}`];
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
      const reps = repsMap[`${exercise.id}-${s}`];
      if (repsSetIsRecorded(reps)) {
        loggedSetsCount++;
        if (!repsSetMeetsTarget(reps, exercise.target_reps)) allRepsMetTarget = false;
      } else {
        allRepsMetTarget = false;
      }
    }
    if (loggedSetsCount === exercise.target_sets && allRepsMetTarget) return 'green';
    if (loggedSetsCount > 0) return 'yellow';
    return 'neutral';
  }

  /** Header + routine icons: green / yellow / red(skipped) / neutral */
  let headerSurfaceStatus = $derived.by((): HeaderSurfaceStatus => {
    if (
      isViewingToday &&
      (workoutState === 'skipped' ||
        todayCompletionStatus === 'skipped' ||
        logIsSkipped(todayLog))
    ) {
      return 'skipped';
    }
    if (!isViewingToday && viewedCompletionStatus === 'skipped') return 'skipped';
    if (workoutState === 'active') return sessionStatus as HeaderSurfaceStatus;
    const completion = headerCompletionDisplay;
    if (completion === 'untouched' || completion === 'skipped') return 'skipped';
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

  function durationSecondsFromLog(log: { duration_seconds?: number | null; performance_snapshot?: { duration_seconds?: number }; workout_snapshot?: { duration_seconds?: number } } | null): number {
    if (!log) return 0;
    const raw =
      log.duration_seconds ??
      log.performance_snapshot?.duration_seconds ??
      log.workout_snapshot?.duration_seconds;
    if (raw == null || !Number.isFinite(raw)) return 0;
    return Math.max(0, Math.round(raw));
  }

  function resetHeaderWorkoutTimer() {
    clearInterval(workoutTimer);
    workoutTimer = null;
    workoutDuration = 0;
    workoutStartedAt = null;
    finishedHeaderDuration = 0;
  }

  function clearHeaderTimerFadeTimer() {
    if (headerTimerFadeTimer) clearTimeout(headerTimerFadeTimer);
    headerTimerFadeTimer = null;
  }

  function resetHeaderTimerDisplay() {
    clearHeaderTimerFadeTimer();
    headerTimerInDom = false;
    headerTimerOpaque = false;
  }

  function beginHeaderTimerFadeIn() {
    clearHeaderTimerFadeTimer();
    headerTimerInDom = true;
    headerTimerOpaque = false;
    void tick().then(() => {
      requestAnimationFrame(() => {
        headerTimerOpaque = true;
      });
    });
  }

  function beginHeaderTimerFadeOut() {
    clearHeaderTimerFadeTimer();
    headerTimerOpaque = false;
    headerTimerFadeTimer = setTimeout(() => {
      headerTimerFadeTimer = null;
      headerTimerInDom = false;
    }, HEADER_TIMER_FADE_MS);
  }

  function captureHeaderTimerSeconds(): number {
    if (workoutState === 'active' || finishSyncPending) return workoutDuration;
    if (isViewingToday && workoutState === 'done') {
      const fromLog = durationSecondsFromLog(todayLog);
      return fromLog > 0 ? fromLog : workoutDuration;
    }
    return durationSecondsFromLog(viewedLog);
  }

  let headerTimerSeconds = $derived.by(() => {
    if (workoutState === 'active' || finishSyncPending) return workoutDuration;
    if (isViewingToday) {
      if (workoutState === 'done') {
        const fromLog = durationSecondsFromLog(todayLog);
        if (fromLog > 0) return fromLog;
        if (finishedHeaderDuration > 0) return finishedHeaderDuration;
        return workoutDuration;
      }
      return 0;
    }
    return durationSecondsFromLog(viewedLog);
  });

  let headerTimerMinutes = $derived(
    Math.floor(headerTimerSeconds / 60)
      .toString()
      .padStart(2, '0'),
  );

  let headerTimerSecondsPart = $derived((headerTimerSeconds % 60).toString().padStart(2, '0'));

  let headerTimerVisible = $derived.by(() => {
    if (workoutState === 'active' || finishSyncPending) return true;
    if (isViewingToday && workoutState === 'done') {
      return headerTimerSeconds > 0 || finishedHeaderDuration > 0;
    }
    if (!isViewingToday && viewedLog && !viewedLog.workout_snapshot?.is_rest && !logIsSkipped(viewedLog)) {
      return headerTimerSeconds > 0;
    }
    return false;
  });

  let headerTimerShown = $derived(
    headerTimerVisible &&
      (headerTimerOpaque ||
        finishSyncPending ||
        workoutState === 'active' ||
        (workoutState === 'done' && finishedHeaderDuration > 0)),
  );

  /** Keep header timer mounted and visible through finish + DB sync. */
  $effect(() => {
    if (headerTimerFadeTimer) return;

    const keepTimer =
      workoutState === 'active' ||
      finishSyncPending ||
      headerTimerVisible ||
      (workoutState === 'done' && finishedHeaderDuration > 0);

    if (keepTimer) {
      headerTimerInDom = true;
      headerTimerOpaque = true;
    } else if (workoutState === 'idle' && headerTimerInDom) {
      resetHeaderTimerDisplay();
    }
  });

  function useLiveSessionTracking() {
    return workoutState === 'active' || finishSyncPending;
  }

  function todayLogForDisplay() {
    if (
      !isViewingToday ||
      workoutState === 'idle' ||
      !todayLog ||
      logIsSkipped(todayLog) ||
      todayLog.workout_snapshot?.is_rest
    ) {
      return null;
    }
    if (finishSyncPending || isWorkoutInProgress(todayLog)) {
      return null;
    }
    return todayLog;
  }

  /** Finished workout (today done or past logged day) — not active, skipped, or rest. */
  function isCompletedWorkoutView(): boolean {
    if (isViewingToday) {
      if (workoutState === 'skipped') return false;
      return workoutState === 'done';
    }
    const log = viewedLog;
    if (!log || logIsSkipped(log) || log.workout_snapshot?.is_rest || isWorkoutInProgress(log)) {
      return false;
    }
    return !!(log.workout_snapshot?.exercises?.length);
  }

  type SetBubbleStatus = 'empty' | 'green' | 'yellow';

  /** Zero reps = cleared (same as unlogged): grey bubble with —. */
  function repsSetIsRecorded(reps: number | null | undefined): boolean {
    return reps != null && reps > 0;
  }

  function repsSetMeetsTarget(reps: number | null | undefined, targetReps: number): boolean {
    return repsSetIsRecorded(reps) && (reps as number) >= targetReps;
  }

  function repsSetBubbleStatus(
    reps: number | null | undefined,
    targetReps: number,
  ): SetBubbleStatus {
    if (!repsSetIsRecorded(reps)) return 'empty';
    const n = reps as number;
    if (n >= targetReps) return 'green';
    return 'yellow';
  }

  function countExerciseTouchedSetsFromLog(log: any, exercise: Exercise): number {
    let count = 0;
    const targetSecs =
      exercise.exercise_type === 'time'
        ? (exercise.target_minutes || 0) * 60 + (exercise.target_seconds || 0)
        : 0;
    for (let s = 0; s < exercise.target_sets; s++) {
      if (exercise.exercise_type === 'reps') {
        if (repsSetIsRecorded(getHistoricalReps(log, exercise.id, s))) count++;
      } else if (getHistoricalTime(log, exercise.id, s, targetSecs)) {
        count++;
      }
    }
    return count;
  }

  function countExerciseTouchedSetsLive(exercise: Exercise): number {
    const reps = displayTrackedReps();
    const times = displayCompletedTimers();
    let count = 0;
    for (let s = 0; s < exercise.target_sets; s++) {
      const key = `${exercise.id}-${s}`;
      if (exercise.exercise_type === 'reps') {
        if (repsSetIsRecorded(reps[key])) count++;
      } else if (times[key]) {
        count++;
      }
    }
    return count;
  }

  function exerciseIsUntouched(exercise: Exercise): boolean {
    if (!isCompletedWorkoutView()) return false;
    if (isViewingToday && workoutState === 'done') {
      const log = todayLogForDisplay();
      if (log) return countExerciseTouchedSetsFromLog(log, exercise) === 0;
      return countExerciseTouchedSetsLive(exercise) === 0;
    }
    const log = viewedLog;
    if (!log) return false;
    return countExerciseTouchedSetsFromLog(log, exercise) === 0;
  }

  function repsExerciseMeetsTarget(exercise: Exercise): boolean {
    let touchedSetsCount = 0;
    let allRepsMetTarget = true;
    for (let s = 0; s < exercise.target_sets; s++) {
      const reps = displayTrackedReps()[`${exercise.id}-${s}`];
      if (repsSetIsRecorded(reps)) {
        touchedSetsCount++;
        if (!repsSetMeetsTarget(reps, exercise.target_reps)) allRepsMetTarget = false;
      } else {
        allRepsMetTarget = false;
      }
    }
    return touchedSetsCount === exercise.target_sets && allRepsMetTarget;
  }

  /** Live session: PR = every set logged and at/above target (matches green set bubbles). */
  function exerciseLiveIsPr(exercise: Exercise): boolean {
    if (exercise.exercise_type === 'time') {
      let loggedSetsCount = 0;
      let allMet = true;
      for (let s = 0; s < exercise.target_sets; s++) {
        const t = displayCompletedTimers()[`${exercise.id}-${s}`];
        if (t !== undefined && t !== null) {
          loggedSetsCount++;
          if (!t.met) allMet = false;
        } else {
          allMet = false;
        }
      }
      return loggedSetsCount === exercise.target_sets && allMet;
    }
    return repsExerciseMeetsTarget(exercise);
  }

  function showUntouchedBadge(exercise: Exercise): boolean {
    if (isSkippedWorkoutView()) return true;
    return exerciseIsUntouched(exercise);
  }

  /** Completed or skipped workout: unlogged sets show ✕ instead of S# / dash. */
  function setShowsUnrecordedCross(bubbleStatus: SetBubbleStatus): boolean {
    if (isSkippedWorkoutView()) return true;
    return isCompletedWorkoutView() && bubbleStatus === 'empty';
  }

  function showWorkoutHeaderOutcomeIcon(): boolean {
    if (isViewingToday) {
      return (
        workoutState === 'done' ||
        workoutState === 'skipped' ||
        (!!todayLog && logIsSkipped(todayLog))
      );
    }
    const log = viewedLog;
    return !!log && !log.workout_snapshot?.is_rest;
  }

  function showWorkoutHeaderCross(): boolean {
    if (!showWorkoutHeaderOutcomeIcon()) return false;
    const status = headerOutcomeCompletion();
    return status === 'untouched' || status === 'skipped';
  }

  function exerciseSetProgressFromLog(
    log: any,
    exercise: Exercise,
  ): { loggedCount: number; allSetsMet: boolean } {
    let loggedCount = 0;
    let allMet = true;
    const targetSecs =
      exercise.exercise_type === 'time'
        ? (exercise.target_minutes || 0) * 60 + (exercise.target_seconds || 0)
        : 0;
    const targetReps = exercise.target_reps || 0;

    for (let s = 0; s < exercise.target_sets; s++) {
      if (exercise.exercise_type === 'reps') {
        const reps = getHistoricalReps(log, exercise.id, s);
        if (repsSetIsRecorded(reps)) {
          loggedCount++;
          if (!repsSetMeetsTarget(reps, targetReps)) allMet = false;
        } else {
          allMet = false;
        }
      } else {
        const t = getHistoricalTime(log, exercise.id, s, targetSecs);
        if (t) {
          loggedCount++;
          if (!t.met) allMet = false;
        } else {
          allMet = false;
        }
      }
    }

    return {
      loggedCount,
      allSetsMet: loggedCount === exercise.target_sets && allMet,
    };
  }

  function exerciseAllSetsMetFromLog(log: any, exercise: Exercise): boolean {
    return exerciseSetProgressFromLog(log, exercise).allSetsMet;
  }

  function showPrBadge(exercise: Exercise, loggedEx: { exercise_is_pr?: boolean } | null): boolean {
    if (headerSurfaceStatus === 'skipped' || exerciseIsUntouched(exercise)) return false;
    if (isViewingToday && useLiveSessionTracking()) {
      return exerciseLiveIsPr(exercise);
    }
    if (isCompletedWorkoutView()) {
      const log = isViewingToday ? todayLogForDisplay() : viewedLog;
      if (log) return exerciseAllSetsMetFromLog(log, exercise);
      return exerciseLiveIsPr(exercise);
    }
    return false;
  }

  function exerciseStatusFromLog(log: any, exercise: Exercise): 'green' | 'yellow' | 'neutral' {
    const { loggedCount, allSetsMet } = exerciseSetProgressFromLog(log, exercise);

    if (allSetsMet) return 'green';
    if (loggedCount > 0) return 'yellow';
    return 'neutral';
  }

  function getExerciseStatus(exercise: Exercise): 'green' | 'yellow' | 'neutral' | 'skipped' {
    if (isSkippedWorkoutView()) return 'skipped';
    if (isCompletedWorkoutView() && exerciseIsUntouched(exercise)) return 'skipped';
    if (isViewingToday && useLiveSessionTracking()) {
      if (exercise.exercise_type === 'time') {
        let loggedSetsCount = 0;
        let allMet = true;
        const timers = displayCompletedTimers();
        for (let s = 0; s < exercise.target_sets; s++) {
          const t = timers[`${exercise.id}-${s}`];
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
      const repsMap = displayTrackedReps();

      for (let s = 0; s < exercise.target_sets; s++) {
        const reps = repsMap[`${exercise.id}-${s}`];
        if (repsSetIsRecorded(reps)) {
          loggedSetsCount++;
          if (!repsSetMeetsTarget(reps, exercise.target_reps)) allRepsMetTarget = false;
        } else {
          allRepsMetTarget = false;
        }
      }

      if (loggedSetsCount === exercise.target_sets && allRepsMetTarget) return 'green';
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
  ): SetBubbleStatus {
    const key = `${exerciseId}-${setIndex}`;

    if (isViewingToday && useLiveSessionTracking()) {
      if (targetReps !== undefined) {
        return repsSetBubbleStatus(displayTrackedReps()[key], targetReps);
      }
      const t = displayCompletedTimers()[key];
      if (!t) return 'empty';
      return t.met ? 'green' : 'yellow';
    }

    const log = isViewingToday ? todayLogForDisplay() : viewedLog;
    if (!log) return 'empty';

    if (targetReps !== undefined) {
      return repsSetBubbleStatus(getHistoricalReps(log, exerciseId, setIndex), targetReps);
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
      const raw = ex.sets[s]?.reps_completed;
      if (raw === null || raw === undefined || raw === 0) return undefined;
      return raw;
    }
    const legacy = ex.performed_sets?.[s];
    if (legacy === null || legacy === undefined || legacy === 0) return undefined;
    return legacy;
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
        const n = val as number;
        if (n > 0) reps[key] = n;
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
          if (
            row?.reps_completed != null &&
            row.reps_completed > 0 &&
            reps[key] === undefined
          ) {
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
    headerTimerInDom = true;
    headerTimerOpaque = true;
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
    headerTimerInDom = true;
    headerTimerOpaque = true;
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
  function completionStatusFromSnapshot(snap: any): 'green' | 'yellow' | 'neutral' | 'untouched' {
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
            if (repsSetIsRecorded(val)) {
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
          if (repsSetIsRecorded(val)) {
            doneSets++;
            if ((val as number) >= targetReps) greenSets++;
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
    if (doneSets === 0) return 'untouched';
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
          if (
            repsSetIsRecorded(row.reps_completed) ||
            (row.seconds_completed != null && !Number.isNaN(row.seconds_completed))
          ) {
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
    return getSupabaseProjectInfo().host;
  }

  function openSettingsPanel() {
    accountError = null;
    stopSignOutHold();
    stopDeleteAccountHold();
    showSettingsPanel = true;
    void refreshSupabaseUsage();
  }

  function closeSettingsPanel() {
    if (accountBusy) return;
    resetSettingsPanelUi();
  }

  function applySupabaseHealthError(e: unknown) {
    const message = formatDbError(e);
    supabasePanel = {
      project: getSupabaseProjectInfo(),
      health: {
        ok: false,
        latencyMs: null,
        server: null,
        projectRef: null,
        region: null,
        error: message,
      },
      sessionOk: false,
      sessionError: message,
      expiresAt: null,
      usage: supabasePanel?.usage ?? null,
    };
  }

  async function refreshSupabaseHealth() {
    try {
      const update = await loadSupabaseHealthSnapshot();
      supabasePanel = supabasePanel
        ? { ...supabasePanel, ...update }
        : {
            project: getSupabaseProjectInfo(),
            ...update,
            usage: null,
          };
    } catch (e) {
      if (!supabasePanel) applySupabaseHealthError(e);
      else {
        supabasePanel = {
          ...supabasePanel,
          health: {
            ok: false,
            latencyMs: null,
            server: null,
            projectRef: null,
            region: null,
            error: formatDbError(e),
          },
        };
      }
    }
  }

  async function refreshSupabaseUsage() {
    if (!currentUser) return;
    try {
      const usage = await fetchUserDataUsage();
      if (supabasePanel) supabasePanel = { ...supabasePanel, usage };
    } catch {
      /* keep cached usage */
    }
  }

  async function preloadSupabaseBackend() {
    const showLoading = supabasePanel === null;
    if (showLoading) supabasePanelLoading = true;
    try {
      supabasePanel = await loadSupabasePanelSnapshot();
    } catch (e) {
      applySupabaseHealthError(e);
    } finally {
      if (showLoading) supabasePanelLoading = false;
    }
  }

  function startSupabaseBackgroundSync() {
    if (supabaseHealthPollTimer) return;
    void preloadSupabaseBackend();
    supabaseHealthPollTimer = setInterval(() => {
      void refreshSupabaseHealth();
    }, SUPABASE_HEALTH_POLL_MS);
  }

  function stopSupabaseBackgroundSync() {
    if (supabaseHealthPollTimer) {
      clearInterval(supabaseHealthPollTimer);
      supabaseHealthPollTimer = null;
    }
    supabasePanel = null;
    supabasePanelLoading = false;
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
		if (newcomerBootstrapPending && !hasInitialLoad) {
			bootstrapNewcomerAppState();
		}
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
					workoutDuration = durationSecondsFromLog(todayLog);
					clearInterval(workoutTimer);
					workoutTimer = null;
					workoutStartedAt = null;
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
    const unsubDbActivity = subscribeDbActivity(flashDbIoIndicator);
    const unsubDbActivitySnapshot = subscribeDbActivitySnapshot(() => {
      dbActivitySnapshot = getDbActivitySnapshot();
    });

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
          startSupabaseBackgroundSync();
          if (newcomerBootstrapPending) {
            bootstrapNewcomerAppState();
            void loadData({ preserveSession: true });
          } else if (!hasInitialLoad) {
            bootMessage = 'Welcome back — loading data…';
            bootSections = buildAuthBootSections(currentUser);
            loadData();
          } else {
            void loadData({ preserveSession: true });
          }
        }

        if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') {
          resetSettingsPanelUi();
        }

        if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !currentUser)) {
          stopSupabaseBackgroundSync();
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
          newcomerBootstrapPending = false;
          bootMessage = 'Checking session…';
          bootSections = [];
        }
      })();
    });

    const redirectErr = getAuthRedirectError();
    if (redirectErr) setAuthError(redirectErr);

    void (async () => {
      try {
        // Handle legacy redirects that land on / with ?code= (redirectTo was origin)
        await db.handleAuthCallback();
      } catch (e) {
        console.error('Auth callback failed', e);
        setAuthError(formatAuthError(e));
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
      stopSupabaseBackgroundSync();
      unsubDbActivity();
      unsubDbActivitySnapshot();
      if (dbIoFlashTimer) clearTimeout(dbIoFlashTimer);
      subscription.unsubscribe();
      document.removeEventListener('visibilitychange', onPageHide);
    };
  });
  onDestroy(() => {
    finishAuthFeedbackExit();
    flushWorkoutProgressSave();
    if (workoutProgressSaveTimer) clearTimeout(workoutProgressSaveTimer);
    if (dbIoFlashTimer) clearTimeout(dbIoFlashTimer);
    clearInterval(workoutTimer);
    clearInterval(countdownTimer);
    cancelRepSetHold();
  });

  function computeWorkoutFinishStatus(
    template: Template,
    snapshot: { reps: Record<string, number>; times: Record<string, { result: string; met: boolean }> },
  ): 'green' | 'yellow' | 'untouched' {
    let total = 0;
    let green = 0;
    let done = 0;
    for (const ex of template.exercises) {
      total += ex.target_sets || 0;
      for (let i = 0; i < (ex.target_sets || 0); i++) {
        const k = `${ex.id}-${i}`;
        if (ex.exercise_type === 'reps') {
          const reps = snapshot.reps[k];
          if (repsSetIsRecorded(reps)) {
            done++;
            if (repsSetMeetsTarget(reps, ex.target_reps || 0)) green++;
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
    if (total > 0 && done === 0) return 'untouched';
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
    beginHeaderTimerFadeIn();
    writeActiveSessionBackup();
    void persistWorkoutProgressNow();
    scheduleWorkoutProgressSave();
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
    resetHeaderWorkoutTimer();
    finishedHeaderDuration = 0;
    clearInterval(countdownTimer);
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
    saveActiveTimerIfAny();
    skipProgress = 0;
    cancelProgress = 0;
    deleteTemplateProgress = 0;
    eraseProgress = 0;

    const elapsed = workoutElapsedSeconds();
    workoutDuration = elapsed;
    finishedHeaderDuration = elapsed;
    clearInterval(workoutTimer);
    workoutTimer = null;
    workoutStartedAt = null;

    const snapshot = {
      reps: { ...trackedReps },
      times: { ...completedTimers },
    };
    const duration = elapsed;
    const justFinished = computeWorkoutFinishStatus(template, snapshot);

    justFinishedStatus = justFinished;
    if (workoutProgressSaveTimer) {
      clearTimeout(workoutProgressSaveTimer);
      workoutProgressSaveTimer = null;
    }
    workoutProgressSaveGen++;
    finishSyncPending = true;
    clearActiveSessionBackup();
    activeWorkoutTemplate = null;
    workoutState = 'done';

    void syncWorkoutFinish(template, snapshot, duration);
  }

  async function syncWorkoutFinish(
    template: Template,
    snapshot: { reps: Record<string, number>; times: Record<string, { result: string; met: boolean }> },
    duration: number,
  ) {
    const opGen = workoutProgressSaveGen;
    try {
      await db.submitWorkoutSession(template, snapshot, duration);
      if (opGen !== workoutProgressSaveGen) {
        await db.deleteWorkoutLog().catch((err) => console.error('finish undo after erase failed', err));
        return;
      }
      await loadData({ preserveSession: true });
      if (opGen !== workoutProgressSaveGen) return;
    } catch (err) {
      if (opGen !== workoutProgressSaveGen) return;
      console.error('finish workout failed', err);
      workoutActionError = formatDbError(err);
      await loadData({ preserveSession: true });
    } finally {
      if (opGen !== workoutProgressSaveGen) {
        finishSyncPending = false;
        justFinishedStatus = null;
        return;
      }
      finishSyncPending = false;
      justFinishedStatus = null;
      const fromLog = durationSecondsFromLog(todayLog);
      if (fromLog > 0) workoutDuration = fromLog;
      finishedHeaderDuration = 0;
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
        trackedReps = { ...trackedReps, [key]: targetReps };
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
      const { value, display } = clampTrackedRepsFieldInput(inputEl.value);
      syncClampedInput(inputEl, display);
      if (inputEl.value.trim() !== '' && value > 0) {
        trackedReps = { ...trackedReps, [key]: value };
      } else {
        const next = { ...trackedReps };
        delete next[key];
        trackedReps = next;
      }
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
    completedTimers = {
      ...completedTimers,
      [key]: {
        result: `${Math.floor(countdownSeconds / 60).toString().padStart(2, '0')}m${(countdownSeconds % 60).toString().padStart(2, '0')}s`,
        met: countdownSeconds >= targetSeconds,
      },
    };
    activeTimerExerciseId = null;
    activeTimerSetIndex = null;
    countdownSeconds = 0;
    scheduleWorkoutProgressSave();
  }

  function saveActiveTimerIfAny() {
    if (activeTimerExerciseId == null || activeTimerSetIndex == null) return;
    const template = activeWorkoutTemplate ?? activeTemplate;
    const exercise = template?.exercises?.find((e) => e.id === activeTimerExerciseId);
    if (!exercise || exercise.exercise_type !== 'time') {
      cancelActiveTimer();
      return;
    }
    const targetSeconds = (exercise.target_minutes || 0) * 60 + (exercise.target_seconds || 0);
    stopAndSaveTimedSet(activeTimerExerciseId, activeTimerSetIndex, targetSeconds);
  }

  function cancelActiveTimer() {
    clearInterval(countdownTimer);
    countdownRunning = false;
    activeTimerExerciseId = null;
    activeTimerSetIndex = null;
    countdownSeconds = 0;
  }

  async function syncSkipWorkout() {
    const opGen = workoutProgressSaveGen;
    try {
      workoutActionError = null;
      await db.skipWorkout(activeTemplate?.id || null, activeTemplate?.name || null);
      if (opGen !== workoutProgressSaveGen) {
        await db.deleteWorkoutLog().catch((err) => console.error('skip undo after erase failed', err));
        return;
      }
      await loadData({ preserveSession: true });
      if (opGen !== workoutProgressSaveGen) return;
      if (logIsSkipped(todayLog)) {
        workoutState = 'skipped';
      }
    } catch (err) {
      if (opGen !== workoutProgressSaveGen) return;
      console.error('skip workout failed', err);
      workoutActionError = formatDbError(err);
      workoutState = 'idle';
      await loadData();
    }
  }

  function applySkipOptimisticLog() {
    if (!isViewingToday) return;
    todayLog = {
      template_id: activeTemplate?.id ?? null,
      template_name_snapshot: activeTemplate?.name ?? null,
      is_skipped: true,
      workout_snapshot: { skipped: true, template_name: activeTemplate?.name ?? undefined },
    };
    weekLogs = { ...weekLogs, [REAL_TODAY_STR]: todayLog };
    viewedLog = todayLog;
  }

  function beginSkipRevert() {
    if (workoutState !== 'idle' || !isViewingToday) return;
    stopSkipHold();
    justFinishedStatus = null;
    resetHeaderTimerDisplay();
    applySkipOptimisticLog();
    workoutState = 'skipped';
    void syncSkipWorkout();
  }

  function beginCancelRevert() {
    if (workoutState !== 'active' || !isViewingToday) return;
    stopCancelHold();
    resetHeaderTimerDisplay();
    applyCancelWorkoutState();
  }

  function applyEraseLocalReset() {
    if (workoutProgressSaveTimer) {
      clearTimeout(workoutProgressSaveTimer);
      workoutProgressSaveTimer = null;
    }
    workoutProgressSaveGen++;
    finishSyncPending = false;
    justFinishedStatus = null;
    finishedHeaderDuration = 0;
    clearActiveSessionBackup();
    resetHeaderWorkoutTimer();
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
    if (workoutState !== 'done' && workoutState !== 'skipped') return;
    stopEraseHold();
    resetHeaderTimerDisplay();
    applyEraseLocalReset();
    workoutState = 'idle';
    void eraseWorkoutLog();
  }

  function handleStartWorkoutTap(e: Event) {
    e.preventDefault();
    if (workoutState !== 'idle' || !isViewingToday) return;
    startWorkout();
  }

  function handleFinishWorkoutTap(e: Event) {
    e.preventDefault();
    if (workoutState !== 'active' || !isViewingToday) return;
    finishWorkout();
  }

  function pulseSkipTapFlash() {
    skipTapPulseActive = false;
    requestAnimationFrame(() => {
      skipTapPulseActive = true;
    });
  }

  function pulseCancelTapFlash() {
    cancelTapPulseActive = false;
    requestAnimationFrame(() => {
      cancelTapPulseActive = true;
    });
  }

  function pulseEraseTapFlash() {
    eraseTapPulseActive = false;
    requestAnimationFrame(() => {
      eraseTapPulseActive = true;
    });
  }

  function onSkipTapPulseEnd(e: AnimationEvent) {
    if (e.animationName === 'hold-skip-tap-pulse') skipTapPulseActive = false;
  }

  function onCancelTapPulseEnd(e: AnimationEvent) {
    if (e.animationName === 'hold-cancel-tap-pulse') cancelTapPulseActive = false;
  }

  function onEraseTapPulseEnd(e: AnimationEvent) {
    if (e.animationName === 'hold-cancel-tap-pulse') eraseTapPulseActive = false;
  }

  function startSkipHold(e: Event) {
    if (e.cancelable) e.preventDefault();
    if (workoutState !== 'idle' || !isViewingToday) return;
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
    skipTapPulseActive = false;
  }

  function startCancelHold(e: Event) {
    if (e.cancelable) e.preventDefault();
    if (workoutState !== 'active' || !isViewingToday) return;
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
    if (workoutState !== 'done' && workoutState !== 'skipped') {
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
    const opGen = workoutProgressSaveGen;
    stopEraseHold();
    stopSkipHold();
    try {
      workoutActionError = null;
      await db.deleteWorkoutLog(isViewingToday ? undefined : dateKey);
      if (opGen !== workoutProgressSaveGen) return;
      weekLogs = { ...weekLogs, [dateKey]: null };
      if (selectedDateStr === dateKey) {
        viewedLog = null;
        if (isViewingToday) todayLog = null;
      }
      await loadData({ preserveSession: true });
      if (opGen !== workoutProgressSaveGen) return;
      if (isViewingToday) {
        todayLog = null;
        viewedLog = null;
        weekLogs = { ...weekLogs, [REAL_TODAY_STR]: null };
      } else {
        weekLogs = { ...weekLogs, [dateKey]: null };
        if (selectedDateStr === dateKey) viewedLog = null;
      }
    } catch (err) {
      if (opGen !== workoutProgressSaveGen) return;
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
    if (editingRoutineTemplateNameId) {
      const pending = templates.find((t) => t.id === editingRoutineTemplateNameId);
      if (pending) commitRoutineTemplateNameEdit(pending);
    }
    const snapshot = { ...builderAssignments };
    const priorAssignments = new Map(
      schedule.map((s) => [s.day_of_week, s.template_id ?? null] as const),
    );
    applyLocalScheduleFromBuilder(snapshot);
    currentView = 'track';
    builderAssignments = {};
    builderEditingDay = 0;
    editingRoutineTemplateNameId = null;
    routineTemplateNameEditOriginal = null;
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
    const name = sanitizeTemplateName((defaultName ?? newTemplateName).trim());
    if (!name) {
      templateError = 'Enter a template name.';
      return;
    }

    const wd =
      (currentView === 'swap_template' ? builderEditingDay : selectedWeekday) ?? 0;

    if (currentView === 'swap_template') {
      if (!currentUser) {
        templateError = 'Not signed in';
        return;
      }
      const uid = currentUser.id;
      templateError = null;

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
          const stillPending = templates.some((t) => t.id === tempId);
          if (!stillPending) {
            await db.deleteTemplate(template.id).catch((err) =>
              console.error('orphan template cleanup failed', err),
            );
            return null;
          }
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

    templateError = null;
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
    setAuthError(null);
    authSuccess = null;
    try {
      await db.signInWithGoogle();
    } catch (e) {
      console.error('Google sign-in failed', e);
      setAuthError(formatAuthError(e, 'google'));
    } finally {
      signingIn = false;
    }
  }

  async function handleGitHubSignIn() {
    signingIn = true;
    setAuthError(null);
    authSuccess = null;
    try {
      await db.signInWithGitHub();
    } catch (e) {
      console.error('GitHub sign-in failed', e);
      setAuthError(formatAuthError(e, 'github'));
    } finally {
      signingIn = false;
    }
  }

  async function handleDiscordSignIn() {
    signingIn = true;
    setAuthError(null);
    authSuccess = null;
    try {
      await db.signInWithDiscord();
    } catch (e) {
      console.error('Discord sign-in failed', e);
      setAuthError(formatAuthError(e, 'discord'));
    } finally {
      signingIn = false;
    }
  }

  async function handleXSignIn() {
    signingIn = true;
    setAuthError(null);
    authSuccess = null;
    try {
      await db.signInWithX();
    } catch (e) {
      console.error('X sign-in failed', e);
      setAuthError(formatAuthError(e, 'x'));
    } finally {
      signingIn = false;
    }
  }

  function toggleEmailAuth() {
    authCredentialMethod = authCredentialMethod === 'email' ? 'username' : 'email';
    setAuthError(null);
    authSuccess = null;
  }

  async function handleEmailAuth() {
    const email = authEmail.trim();
    if (!email || !authPassword) {
      setAuthError('Enter your email and password.');
      authSuccess = null;
      return;
    }
    const emailErr = validateEmail(email);
    if (emailErr) {
      setAuthError(emailErr);
      authSuccess = null;
      return;
    }
    if (authMode === 'signup' && authPassword !== authConfirmPassword) {
      setAuthError('Passwords do not match.');
      authSuccess = null;
      return;
    }
    const passwordErr = validatePassword(authPassword);
    if (passwordErr) {
      setAuthError(passwordErr);
      authSuccess = null;
      return;
    }

    signingIn = true;
    setAuthError(null);
    authSuccess = null;
    await tick();
    try {
      if (authMode === 'signup') {
        newcomerBootstrapPending = true;
        const { session, user } = await db.signUpWithEmail(email, authPassword);
        if (session) {
          currentUser = user;
          bootstrapNewcomerAppState();
          authPassword = '';
          authConfirmPassword = '';
        } else {
          newcomerBootstrapPending = false;
          setAuthSuccess(
            'Account created. Check your email for a confirmation link, then sign in.',
          );
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
      newcomerBootstrapPending = false;
      setAuthError(formatAuthError(e, undefined, 'email'));
    } finally {
      signingIn = false;
    }
  }

  async function handleUsernameAuth() {
    const username = authUsername.trim();
    if (!username || !authPassword) {
      setAuthError('Enter your username and password.');
      authSuccess = null;
      return;
    }
    const usernameErr = validateUsername(username);
    if (usernameErr) {
      setAuthError(usernameErr);
      authSuccess = null;
      return;
    }
    if (authMode === 'signup' && authPassword !== authConfirmPassword) {
      setAuthError('Passwords do not match.');
      authSuccess = null;
      return;
    }
    const passwordErr = validatePassword(authPassword);
    if (passwordErr) {
      setAuthError(passwordErr);
      authSuccess = null;
      return;
    }

    signingIn = true;
    setAuthError(null);
    authSuccess = null;
    await tick();
    try {
      if (authMode === 'signup') {
        newcomerBootstrapPending = true;
        const { session, user } = await db.signUpWithUsername(username, authPassword);
        if (session) {
          currentUser = user;
          bootstrapNewcomerAppState();
          authPassword = '';
          authConfirmPassword = '';
        } else {
          newcomerBootstrapPending = false;
          setAuthSuccess(
            'Account created. If sign-in fails, disable “Confirm email” in Supabase Auth settings (username accounts have no inbox).',
          );
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
      newcomerBootstrapPending = false;
      setAuthError(formatAuthError(e, undefined, 'username'));
    } finally {
      signingIn = false;
    }
  }

  function setAuthMode(mode: 'signin' | 'signup') {
    authMode = mode;
    setAuthError(null);
    authSuccess = null;
    if (mode === 'signin') authConfirmPassword = '';
  }

  /** Closes panel and resets hold UI; safe to call during sign-out / auth changes. */
  function resetSettingsPanelUi() {
    showSettingsPanel = false;
    stopSignOutHold();
    stopDeleteAccountHold();
    accountError = null;
  }

  async function handleSignOut() {
    if (accountBusy) return;
    accountBusy = true;
    accountError = null;
    resetSettingsPanelUi();
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
      resetSettingsPanelUi();
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
    const tpl = templates.find((t) => t.id === templateId);
    routineTemplateNameEditOriginal = tpl
      ? sanitizeTemplateName((tpl.name ?? '').trim())
      : null;
  }

  function commitRoutineTemplateNameEdit(template: Template) {
    const originalName = routineTemplateNameEditOriginal;
    editingRoutineTemplateNameId = null;
    routineTemplateNameEditOriginal = null;
    const trimmed = sanitizeTemplateName((template.name ?? '').trim());
    const savedName = trimmed || 'WORKOUT';
    template.name = savedName;
    if (template.id.startsWith('temp-')) return;
    if (originalName === savedName) return;
    patchTemplateInCache(template.id, savedName, template.exercises);
    void db.updateTemplateName(template.id, savedName).catch((e) => {
      console.error('Template name save failed', e);
      templateError = 'Could not save template name.';
      void loadData({ preserveSession: true });
    });
  }

  function templateIdAfterDeletedTemplate(deletedId: string): string | null {
    const idx = templates.findIndex((t) => t.id === deletedId);
    if (idx < 0) return null;
    if (idx < templates.length - 1) return templates[idx + 1].id;
    if (idx > 0) return templates[idx - 1].id;
    return null;
  }

  function applyBuilderTemplateRemoval(deletedId: string, replacementId: string | null) {
    templates = templates.filter((t) => t.id !== deletedId);
    const nextAssignments = { ...builderAssignments };
    for (let i = 0; i < 7; i++) {
      if (nextAssignments[i] === deletedId) {
        nextAssignments[i] = replacementId;
        applyLocalScheduleAssignment(i, replacementId);
      }
    }
    builderAssignments = nextAssignments;
  }

  async function deleteTemplateInBuilder(tpl: Template) {
    if (editingRoutineTemplateNameId === tpl.id) {
      editingRoutineTemplateNameId = null;
      routineTemplateNameEditOriginal = null;
    }
    const deletedId = tpl.id;
    const replacementId = templateIdAfterDeletedTemplate(deletedId);
    const affectedDays: number[] = [];
    for (let i = 0; i < 7; i++) {
      if (builderAssignments[i] === deletedId) affectedDays.push(i);
    }
    applyBuilderTemplateRemoval(deletedId, replacementId);

    if (deletedId.startsWith('temp-')) {
      for (const wd of affectedDays) {
        routineEditorPendingCreates.delete(wd);
      }
      return;
    }

    void db.deleteTemplate(deletedId).catch(async (e) => {
      console.error(e);
      templateError = formatDbError(e);
      await loadData({ preserveSession: true });
    });
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
    draftExercises = tpl.exercises.map((e) => {
      const copy = { ...e };
      normalizeDraftExercise(copy);
      return copy;
    });
    draftTemplateName = sanitizeTemplateName(tpl.name);
    selectedExerciseId = draftExercises.length > 0 ? draftExercises[0].id : null;
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
    return draft.map((d, i) => {
      const copy = { ...d };
      normalizeDraftExercise(copy);
      return {
        id: copy.id,
        template_id: templateId,
        user_id: copy.user_id ?? uid,
        name: copy.name ?? 'EXERCISE',
        exercise_type: copy.exercise_type,
        target_sets: copy.target_sets ?? 0,
        target_reps: copy.target_reps ?? 0,
        target_minutes: copy.target_minutes ?? 0,
        target_seconds: copy.target_seconds ?? 0,
        increment: copy.increment ?? 0,
        current_weight: copy.current_weight ?? null,
        display_order: i,
      };
    });
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
    const snapName = sanitizeTemplateName(draftTemplateName.trim());
    const validationErr = validateDraftExercises(snapExercises);
    if (validationErr) {
      templateSaveError = validationErr;
      return;
    }
    const previousName =
      templates.find((t) => t.id === templateId)?.name ?? snapName;
    const displayName = snapName || previousName;

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

  function touchDraft() {
    draftExercises = [...draftExercises];
  }

  function switchDraftExerciseType(
    ex: {
      exercise_type: 'reps' | 'time';
      increment: number;
      target_minutes?: number;
      target_seconds?: number;
    },
    type: 'reps' | 'time',
  ) {
    ex.exercise_type = type;
    if (type === 'time') {
      ex.target_minutes = DEFAULT_TARGET_MINUTES;
      if ((ex.target_seconds ?? 0) === 0) {
        ex.target_seconds = 30;
      }
      ex.increment = DEFAULT_INCREMENT_SEC;
    } else {
      ex.increment = 2.5;
    }
    touchDraft();
  }

  function addNewExercise() {
    if (!editingTemplateId) return;
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const newEx: any = {
      id: tempId,
      name: 'NEW EXERCISE',
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

  let exerciseRowDragged = false;

  function handleDragEnd() {
    const wasDragging = draggedIndex !== null;
    draggedIndex = null;
    if (wasDragging) {
      exerciseRowDragged = true;
      setTimeout(() => {
        exerciseRowDragged = false;
      }, 100);
    }
  }
</script>

<div class="app max-w-md mx-auto min-h-screen min-h-dvh select-none text-white bg-[#0a0a0a] p-4 flex flex-col gap-3 font-sans">

  {#if showSettingsPanel}
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-label="Account and backend"
      tabindex="-1"
      onclick={(e) => { if (e.target === e.currentTarget) closeSettingsPanel(); }}
    >
      <div class="settings-panel-dialog w-full rounded-xl border border-[#1e1e1e] bg-[#141414] shadow-xl overflow-hidden text-left">
        <div class="settings-panel-header">
          <div class="settings-panel-header__title">
            {#if currentUser}
              <div class="settings-panel-header__avatar">{accountInitial}</div>
              <div class="settings-panel-header__identity">
                <span class="settings-panel-header__name">{accountDisplayName}</span>
                <span class="settings-panel-header__user-id" title={currentUser.id}>{currentUser.id}</span>
              </div>
            {:else}
              <span class="settings-panel-header__name text-zinc-400">Backend</span>
            {/if}
          </div>
          <div class="settings-panel-header__supabase" aria-label="Supabase connection">
            <span class="settings-panel-header__supabase-label">Supabase</span>
            <span class="settings-panel-header__dot-wrap" aria-hidden="true">
              <span
                class="db-io-dot settings-panel-header__dot"
                class:db-io-dot--active={!!supabasePanel && supabasePanel.health.ok && supabasePanel.sessionOk}
              ></span>
            </span>
            <span class="settings-panel-header__latency">
              {#if supabasePanelLoading}
                …
              {:else if supabasePanel?.health.latencyMs != null}
                {formatSupabaseLatencyMs(supabasePanel.health.latencyMs)}
              {:else}
                —
              {/if}
            </span>
          </div>
          <button
            type="button"
            aria-label="Close"
            class="settings-panel-header__close"
            disabled={accountBusy}
            onclick={closeSettingsPanel}
          >
            <X class="size-3.5" />
          </button>
        </div>
        <div class="p-3 space-y-3 text-[10px] leading-snug max-h-[min(70dvh,440px)] overflow-y-auto">
          {#if supabasePanelLoading && !supabasePanel}
            <p class="text-zinc-500 py-4 text-center">Loading backend…</p>
          {:else if supabasePanel}
            {@const panel = supabasePanel}
            <div class="settings-panel-brand" aria-hidden="true">
              <span class="settings-panel-brand__lift">LIFT</span>
              <span class="settings-panel-brand__dash">—</span>
              <span class="settings-panel-brand__tracker">TRACKER</span>
            </div>
            <div class="settings-panel-table-wrap">
              <table class="settings-panel-table">
                <tbody>
                  {#if currentUser}
                    <tr>
                      <th scope="row">Provider</th>
                      <td>{accountProvider}</td>
                    </tr>
                    <tr>
                      <th scope="row">Joined</th>
                      <td>{accountMemberSince}</td>
                    </tr>
                  {/if}
                  {#if panel.health.server}
                    <tr>
                      <th scope="row">Server</th>
                      <td class="settings-panel-table__mono settings-panel-table__truncate" title={panel.health.server}>{panel.health.server}</td>
                    </tr>
                  {/if}
                  {#if panel.health.region}
                    <tr>
                      <th scope="row">Edge</th>
                      <td class="settings-panel-table__mono">{panel.health.region}</td>
                    </tr>
                  {/if}
                  {#if currentUser}
                    <tr>
                      <th scope="row">Session</th>
                      <td>{formatSessionExpiry(panel.expiresAt)}</td>
                    </tr>
                  {/if}
                  <tr>
                    <th scope="row">Size</th>
                    <td class="settings-panel-table__strong">
                      {#if panel.usage}
                        {panel.usage.exact ? '' : '~'}{formatBytes(panel.usage.estimated_bytes)}
                      {:else if currentUser}
                        —
                      {:else}
                        Sign in
                      {/if}
                    </td>
                  </tr>
                  {#if panel.usage}
                    <tr>
                      <th scope="row">Library</th>
                      <td>{panel.usage.templates} tpl · {panel.usage.exercises} ex</td>
                    </tr>
                    <tr>
                      <th scope="row">Logs</th>
                      <td>{panel.usage.workout_history}</td>
                    </tr>
                  {/if}
                  <tr>
                    <th scope="row">Calls</th>
                    <td>{dbActivitySnapshot.totalPulses}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {#if panel.health.error || panel.sessionError}
              <p class="text-red-300 px-2.5 py-1.5 rounded-lg border border-red-900/50 bg-red-950/30 leading-snug">
                {panel.sessionError ?? panel.health.error}
              </p>
            {/if}
          {/if}

          {#if currentUser}
            {#if accountError}
              <p class="text-red-300 px-2.5 py-1.5 rounded-lg border border-red-900/50 bg-red-950/30 leading-snug">
                {accountError}
              </p>
            {/if}

            <div class="settings-panel-actions">
              <button
                type="button"
                title="Hold 2s to sign out"
                class="settings-panel-action-btn {signOutTapPulseActive ? 'hold-skip-tap-pulse' : signOutProgress > 0 ? 'settings-panel-action-btn--signout-active' : 'settings-panel-action-btn--signout'}"
                disabled={accountBusy}
                onmousedown={startSignOutHold}
                onmouseup={stopSignOutHold}
                onmouseleave={stopSignOutHold}
                ontouchstart={startSignOutHold}
                ontouchend={stopSignOutHold}
                onanimationend={onSignOutTapPulseEnd}>
                <div class="settings-panel-action-btn__fill settings-panel-action-btn__fill--signout" style="width: {signOutProgress}%;"></div>
                <span class="settings-panel-action-btn__label">
                  <LogOut class="size-3 shrink-0 pointer-events-none" aria-hidden="true" />
                  {accountBusy ? '…' : 'SIGN OUT'}
                </span>
              </button>

              <button
                type="button"
                title="Hold 4s to delete account and all data"
                class="settings-panel-action-btn {deleteAccountTapPulseActive ? 'hold-cancel-tap-pulse' : deleteAccountProgress > 0 ? 'settings-panel-action-btn--delete-active' : 'settings-panel-action-btn--delete'}"
                disabled={accountBusy}
                onmousedown={startDeleteAccountHold}
                onmouseup={stopDeleteAccountHold}
                onmouseleave={stopDeleteAccountHold}
                ontouchstart={startDeleteAccountHold}
                ontouchend={stopDeleteAccountHold}
                onanimationend={onDeleteAccountTapPulseEnd}>
                <div class="settings-panel-action-btn__fill settings-panel-action-btn__fill--delete" style="width: {deleteAccountProgress}%;"></div>
                <span class="settings-panel-action-btn__label">
                  <Trash2 class="size-3 shrink-0 pointer-events-none" aria-hidden="true" />
                  {accountBusy ? '…' : 'DELETE'}
                </span>
              </button>
            </div>
          {/if}
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
  <div
    class="app-stage-reveal flex flex-col flex-1 min-h-0 w-full gap-3"
    class:app-stage-reveal--active={stageRevealActive}
  >
  {#if currentUser}
  <!-- Week box: collapsible header + compact day strip -->
  <div class="rounded-xl border border-[#1e1e1e] bg-[#141414] overflow-hidden">
    <div class="flex items-center gap-2 min-h-8 px-2 py-1.5 border-b border-[#1e1e1e] bg-[#111] text-[10px] tracking-[1px]">
      <button
        type="button"
        title="Account and backend"
        aria-label="Account and backend"
        class="w-7 h-7 shrink-0 rounded-lg border border-emerald-800 bg-emerald-950/40 text-emerald-400 flex items-center justify-center text-[10px] font-black hover:border-emerald-600 hover:text-emerald-300 transition"
        onclick={(e) => { e.stopPropagation(); openSettingsPanel(); }}
      >
        {accountInitial}
      </button>
      <div class="flex-1 flex items-center gap-2 min-w-0">
        <button
          type="button"
          class="flex-1 flex items-center gap-2 min-w-0 py-0.5 -my-0.5 px-1 rounded-md transition-colors {weekCalendarLocked ? 'text-zinc-600 cursor-default' : 'text-zinc-500 hover:text-zinc-300 hover:bg-[#1a1a1a]'}"
          onclick={toggleWeekCalendar}
          disabled={weekCalendarLocked}
          aria-expanded={!weekCalendarDisplayCollapsed}
          aria-disabled={weekCalendarLocked}
          title={weekCalendarLocked ? 'Week calendar locked during workout' : weekCalendarCollapsed ? 'Expand week' : 'Collapse week'}
        >
          <span class="min-w-0 flex-1 truncate text-left leading-none font-bold text-zinc-200 pointer-events-none">{weekBarLabel}</span>
          {#if !weekCalendarLocked}
            {#if weekCalendarDisplayCollapsed}
              <ChevronDown class="size-3.5 shrink-0 text-zinc-400 pointer-events-none" aria-hidden="true" />
            {:else}
              <ChevronUp class="size-3.5 shrink-0 text-zinc-400 pointer-events-none" aria-hidden="true" />
            {/if}
          {/if}
        </button>
        <span class="header-clock-group shrink-0">
          <span class="font-header-clock font-header-clock--fixed text-[10px] text-zinc-500 leading-none">{clockTimeStr}</span>
          <button
            type="button"
            class="db-io-dot-btn"
            aria-label="Account and backend"
            title="Account and backend"
            onclick={openSettingsPanel}
          >
            <span
              class="db-io-dot"
              class:db-io-dot--active={dbIoFlash}
              aria-hidden="true"
            ></span>
          </button>
        </span>
      </div>
    </div>
    <div
      class="week-calendar-panel grid"
      class:week-calendar-panel--open={!weekCalendarDisplayCollapsed}
      class:week-calendar-panel--closing={weekCalendarClosing}
      style="grid-template-rows: {weekCalendarDisplayCollapsed ? '0fr' : '1fr'}"
    >
      <div class="overflow-hidden min-h-0 {weekCalendarDisplayCollapsed ? 'pointer-events-none' : ''}">
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
              : !weekCalendarDisplayCollapsed
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
              {@const dayDone = isRealToday ? workoutState === 'done' : false}
              {@const daySkipped = isRealToday
                ? workoutState === 'skipped'
                : logIsSkipped(dayLog)}
              {@const dayCompletion = dayCalendarCompletionStatus(dayLog, isRealToday)}
              <button 
                class="day-btn aspect-square w-full flex flex-col items-center justify-center gap-0 rounded-md text-[10px] font-bold tracking-wide border-none bg-transparent text-zinc-600 hover:text-white relative origin-center
                  {(dayDone || (!isRealToday && dayHasWorkoutLog && dayCompletion !== 'neutral' && dayCompletion !== 'skipped' && dayCompletion !== 'untouched')) ? (dayCompletion === 'green' ? 'w-cal-green' : dayCompletion === 'untouched' ? 'w-cal-skipped' : 'w-cal-yellow') : ''} 
                  {daySkipped || dayCompletion === 'untouched' ? 'w-cal-skipped' : ''} 
                  {(isSelected && !isRealToday && !dayDone && !daySkipped && dayCompletion === 'neutral') ? '!bg-[#1e1e1e] !text-white' : ''}
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
              <!-- Center: START WORKOUT (wider) or GO TO TODAY when on non-today -->
              {#if isViewingToday}
                <button
                  type="button"
                  class="{workoutCenterBtnClass} border-transparent bg-white text-black"
                  onclick={handleStartWorkoutTap}
                >
                  <span
                    class={workoutCenterLabelClass}
                    style={ctaChStyle(START_CTA_SOURCE, CENTER_CTA_MAX_CH)}
                  >
                    {START_CTA_SOURCE}
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
                class="{workoutSideBtnClass} group border bg-[#0d0d0d] transition-all duration-150 {skipTapPulseActive ? 'hold-skip-tap-pulse' : skipProgress > 0 ? 'border-amber-500 text-[#fbbf24]' : 'border-[#1e1e1e] text-zinc-500'} {!isViewingToday ? 'opacity-40 pointer-events-none' : ''}"
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
                  style={ctaChStyle(SKIP_CTA_SOURCE, SIDE_CTA_MAX_CH)}
                >
                  {SKIP_CTA_SOURCE}
                </span>
              </button>
          {:else if workoutState === 'active'}
              <!-- Center: FINISH (wider) -->
              <button
                type="button"
                class="{workoutCenterBtnClass} {isPerfectDay ? 'w-cta-complete-green' : 'w-cta-finish'} {!isViewingToday ? 'opacity-40 pointer-events-none' : ''}"
                onclick={handleFinishWorkoutTap}
              >
                <span
                  class={workoutCenterLabelClass}
                  style={ctaChStyle(START_CTA_TARGET, CENTER_CTA_MAX_CH)}
                >{START_CTA_TARGET}</span>
              </button>
              <!-- Right: CANCEL (hold, narrow) -->
              <button
                class="{workoutSideBtnClass} group border bg-[#0d0d0d] transition-all duration-150 {cancelTapPulseActive ? 'hold-cancel-tap-pulse' : cancelProgress > 0 ? 'border-red-500 text-[#f87171]' : 'border-[#1e1e1e] text-zinc-500'} {!isViewingToday ? 'opacity-40 pointer-events-none' : ''}"
                onmousedown={startCancelHold}
                onmouseup={stopCancelHold}
                onmouseleave={stopCancelHold}
                ontouchstart={startCancelHold}
                ontouchend={stopCancelHold}
                onanimationend={onCancelTapPulseEnd}
              >
                <div class="absolute inset-0 z-0 bg-red-900/40 transition-all duration-[20ms]" style="width: {cancelProgress}%;"></div>
                <span class={workoutSideLabelClass} style={ctaChStyle(SKIP_CTA_TARGET, SIDE_CTA_MAX_CH)}>CANCEL</span>
              </button>
          {:else if workoutState === 'done'}
            {@const effectiveStatus = justFinishedStatus ?? todayCompletionStatus}
            {@const isUntouchedComplete = effectiveStatus === 'untouched'}
            {@const isYellowComplete = !isUntouchedComplete && (effectiveStatus === 'yellow' || effectiveStatus === 'neutral')}
              <button
                class="{workoutCenterBtnClass} cursor-default {!isViewingToday ? 'opacity-40 pointer-events-none' : ''} {isUntouchedComplete ? 'w-cta-skipped' : isYellowComplete ? 'w-cta-complete-yellow' : 'w-cta-complete-green'}"
              >
                <span
                  class={workoutCenterLabelClass}
                  style={ctaChStyle(COMPLETE_CTA_SOURCE, CENTER_CTA_MAX_CH)}
                >{COMPLETE_CTA_SOURCE}</span>
              </button>
              <button
                type="button"
                class="{workoutSideBtnClass} group border bg-[#0d0d0d] transition-all duration-150 {eraseTapPulseActive ? 'hold-cancel-tap-pulse' : eraseProgress > 0 ? 'border-red-500 text-[#f87171]' : 'border-[#1e1e1e] text-zinc-500'} {!isViewingToday ? 'opacity-40 pointer-events-none' : ''}"
                onmousedown={startEraseHold}
                onmouseup={stopEraseHold}
                onmouseleave={stopEraseHold}
                ontouchstart={startEraseHold}
                ontouchend={stopEraseHold}
                onanimationend={onEraseTapPulseEnd}
              >
                <div class="absolute inset-0 z-0 bg-red-900/40 transition-all duration-[20ms]" style="width: {eraseProgress}%;"></div>
                <span class={workoutSideLabelClass} style={ctaChStyle(ERASE_CTA_SOURCE, SIDE_CTA_MAX_CH)}>ERASE</span>
              </button>
          {:else if workoutState === 'skipped'}
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
                class="{workoutSideBtnClass} group border bg-[#0d0d0d] transition-all duration-150 {eraseTapPulseActive ? 'hold-cancel-tap-pulse' : eraseProgress > 0 ? 'border-red-500 text-[#f87171]' : 'border-[#1e1e1e] text-zinc-500'} {!isViewingToday ? 'opacity-40 pointer-events-none' : ''}"
                onmousedown={startEraseHold}
                onmouseup={stopEraseHold}
                onmouseleave={stopEraseHold}
                ontouchstart={startEraseHold}
                ontouchend={stopEraseHold}
                onanimationend={onEraseTapPulseEnd}
              >
                <div class="absolute inset-0 z-0 bg-red-900/40 transition-all duration-[20ms]" style="width: {eraseProgress}%;"></div>
                <span class={workoutSideLabelClass} style={ctaChStyle(ERASE_CTA_SOURCE, SIDE_CTA_MAX_CH)}>ERASE</span>
              </button>
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
            placeholder="Template name (e.g. FULL BODY)" 
            class="w-full bg-black border border-[#1e1e1e] text-xs text-white uppercase p-2 rounded-lg outline-none focus:border-[#2a2a2a]" 
            autocomplete="off"
            use:clampedTemplateNameProp={{
              getValue: () => newTemplateName,
              setValue: (v) => { newTemplateName = v; },
            }}
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
      {@const useHistorical = isPast && viewedLog && !viewedLog.workout_snapshot?.is_rest && !logIsSkipped(viewedLog)}
      {@const skippedDisplayLog = isSkippedWorkoutView() ? (isViewingToday ? todayLog : viewedLog) : null}
      {@const skippedDisplayTemplate = skippedDisplayLog?.template_id
        ? templates.find((t) => t.id === skippedDisplayLog.template_id)
        : null}
      {@const dispTemplate = useHistorical
        ? { id: viewedLog.template_id, name: viewedLog.template_name_snapshot || 'Past Workout', exercises: viewedLog.workout_snapshot?.exercises || [] }
        : workoutState === 'active' && activeWorkoutTemplate
          ? activeWorkoutTemplate
          : skippedDisplayTemplate ?? activeTemplate}
      {@const exCount = (dispTemplate?.exercises || []).length}
      {@const setCount = (dispTemplate?.exercises || []).reduce((sum: number, ex: any) => sum + (ex.target_sets || 0), 0)}
      {@const tickStatus = headerOutcomeCompletion()}
      {@const workoutTickVisible =
        showWorkoutHeaderOutcomeIcon() && (tickStatus === 'green' || tickStatus === 'yellow')}
      {@const workoutCrossVisible = showWorkoutHeaderCross()}
      {@const headerSkipped = headerSurfaceStatus === 'skipped'}
      {@const showHeaderTimers = headerTimerInDom}
      {@const headerTimerTheme = headerSkipped
        ? 'tpl-workout-timer--skipped'
        : headerSurfaceStatus === 'green'
          ? 'tpl-workout-timer--green'
          : headerSurfaceStatus === 'yellow'
            ? 'tpl-workout-timer--yellow'
            : 'tpl-workout-timer--neutral'}
      <div class="flex flex-col gap-3">
      <div
        class="tpl-header status-surface status-surface--prompt rounded-xl px-3 py-1 flex flex-col gap-0.5 {headerSurfaceStatus === 'green'
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
              class:workout-tick-slot--visible={workoutTickVisible || workoutCrossVisible}
              aria-hidden={!workoutTickVisible && !workoutCrossVisible}
            >
              {#if workoutCrossVisible}
                <X class="workout-complete-tick w-fg-skipped" strokeWidth={2.5} />
              {:else if workoutTickVisible}
                <Check
                  class="workout-complete-tick {tickStatus === 'green' ? 'w-fg-green' : 'w-fg-yellow'}"
                  strokeWidth={2.5}
                />
              {/if}
            </span>
          </div>
        </div>
        <div class="tpl-header-body">
          <div class="tpl-header-toolbar min-h-[3.25rem] shrink-0 w-full">
            <div class="tpl-toolbar-side tpl-toolbar-side--start">
              {#if showHeaderEditActions}
                <button
                  type="button"
                  class="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center border bg-transparent self-center hover:bg-[#1a1a1a] hover:text-white {headerSurfaceStatus === 'green' ? 'w-hdr-icon-green' : headerSurfaceStatus === 'yellow' ? 'w-hdr-icon-yellow' : headerSurfaceStatus === 'skipped' ? 'w-hdr-icon-skipped' : 'border-[#1e1e1e] text-zinc-500'}"
                  onclick={() => enterRoutineBuilder()}
                  title="Routine editor"
                ><CalendarDays class="size-5" /></button>
              {/if}
              {#if showHeaderTimers}
                <span
                  class="tpl-workout-timer tpl-workout-timer--min shrink-0 {headerTimerTheme} {headerTimerShown ? 'tpl-workout-timer--visible' : ''}"
                  aria-hidden={!headerTimerShown}
                >{headerTimerMinutes}</span>
              {/if}
            </div>
            <span class="tpl-name min-w-0 text-xl font-semibold tracking-tight leading-none text-center {headerSkipped ? 'w-fg-skipped' : headerSurfaceStatus === 'green' ? 'w-fg-green' : headerSurfaceStatus === 'yellow' ? 'w-fg-yellow' : 'text-white'}">[ {dispTemplate?.name || 'Workout'} ]</span>
            <div class="tpl-toolbar-side tpl-toolbar-side--end">
              {#if showHeaderTimers}
                <span
                  class="tpl-workout-timer tpl-workout-timer--sec shrink-0 {headerTimerTheme} {headerTimerShown ? 'tpl-workout-timer--visible' : ''}"
                  aria-hidden={!headerTimerShown}
                >{headerTimerSecondsPart}</span>
              {/if}
              {#if showHeaderEditActions}
                <button
                  type="button"
                  class="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center border bg-transparent self-center hover:bg-[#1a1a1a] hover:text-white {headerSurfaceStatus === 'green' ? 'w-hdr-icon-green' : headerSurfaceStatus === 'yellow' ? 'w-hdr-icon-yellow' : headerSurfaceStatus === 'skipped' ? 'w-hdr-icon-skipped' : 'border-[#1e1e1e] text-zinc-500'}"
                  onclick={() => openTemplateEditor()}
                  title="Edit Exercises"
                ><Pencil class="size-5" /></button>
              {/if}
            </div>
          </div>
          <div class="tpl-header-slot">
            {#if !useHistorical && isUntouchedDay}
              <span class="untouched-badge">UNTOUCHED</span>
            {:else if !useHistorical && isPerfectDay}
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
            {@const progressCounts = setCounts}
            <div class="flex gap-[1px] h-1 w-full shrink-0">
            {#each Array(progressCounts.total) as _, i}
              <div
                class="tpl-progress-seg flex-1 rounded-[1px]"
                class:tpl-progress-seg--lit={i < progressCounts.done}
                style={i < progressCounts.done ? `background-color: ${progressBarColor}` : undefined}
              ></div>
            {/each}
            </div>
          {/if}
        </div>
      </div>

      <!-- Exercises in one shared box separated by horizontal dividers, with list numbers on left (like editor list) -->
      <div
        class="rounded-xl overflow-hidden border {isFuture ? 'opacity-80' : ''} {headerSkipped
          ? 'status-surface status-surface--skipped'
          : 'bg-[#141414] border-[#1e1e1e]'}"
      >
        {#each (dispTemplate?.exercises || []) as exercise, index}
          {@const status = getExerciseStatus(exercise)}
          {@const exRed = headerSkipped || status === 'skipped'}
          {@const exSurfaceClass = exRed
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
          {@const displayCurrentWeight = formatOneDecimal(loggedEx?.weight_before ?? exercise.current_weight ?? 0)}
          {@const displayIncrementKg = formatOneDecimal(exercise.increment)}
          <div
            class="p-3 flex gap-1 status-surface {workoutExercisesEditable ? 'hover:brightness-110' : ''} {index > 0 ? (exRed ? 'border-t border-[color:var(--w-skipped-border)]' : 'border-t border-[#1e1e1e]') : ''} {exSurfaceClass}"
          >
            <!-- list number on left: boxed, vertically centered in strip, slightly larger -->
            <div
              class="exercise-index status-surface w-6 flex-shrink-0 flex items-center justify-center rounded text-[10px] font-medium {exRed ? 'text-current' : 'text-zinc-400'} {exSurfaceClass}"
            >
              {index + 1}
            </div>
            <div class="flex-1 flex flex-col gap-1.5">
              <div class="ex-top flex justify-between gap-3 {isTimeEx ? 'ex-top--time items-center' : 'items-start'}">
              <div class="truncate pr-2 min-w-0">
                <div class="ex-name-row {workoutExercisesEditable ? 'hover:brightness-110' : ''}">
                  {#if exercise.exercise_type === 'reps'}
                    <Dumbbell class="size-3.5 shrink-0 {exRed ? 'text-current' : 'text-white'}" />
                  {:else}
                    <Timer class="size-3.5 shrink-0 {exRed ? 'text-current' : 'text-white'}" />
                  {/if}
                  <span class="ex-name text-sm font-extrabold tracking-wide truncate {exRed ? 'text-current' : 'text-white'}">{exercise.name}</span>
                  {#if showUntouchedBadge(exercise)}
                    <span class="untouched-badge">UNTOUCHED</span>
                  {:else if showPrBadge(exercise, loggedEx)}
                    <span class="pr-badge">NEW PR</span>
                  {/if}
                </div>
                <div class="ex-meta text-xs mt-0.5 tracking-wide {exRed ? 'w-fg-skipped-muted' : 'text-zinc-400'}">
                  {#if exercise.exercise_type === 'reps'}
                    {exercise.target_sets}×{exercise.target_reps} @{displayCurrentWeight}kg +{displayIncrementKg}kg
                  {:else}
                    {exercise.target_sets}× {exercise.target_minutes}m {exercise.target_seconds.toString().padStart(2, '0')}s +{exercise.increment}s
                  {/if}
                </div>
              </div>

              {#if !isTimeEx}
                {#if displayCurrentWeight !== null}
                  <div class="weight-num font-timer text-2xl leading-none {exRed ? 'text-current' : 'text-white'}">{displayCurrentWeight}<span class="unit text-[10px] font-sans font-normal ml-1 tracking-[1px] {exRed ? 'w-fg-skipped-muted' : 'text-zinc-400'}">KG</span></div>
                {:else}
                  <!-- Narrow baseline input (fits ~3 digits) in the KG position, right-aligned -->
                  <div class="flex items-baseline justify-end">
                    <input type="text" inputmode="decimal" autocomplete="off" placeholder="80" class="prop-num-input font-timer text-2xl leading-none text-white bg-transparent border-none outline-none w-12 text-right"
                      disabled={!workoutExercisesEditable}
                      use:clampedNumericProp={{
                        kind: 'baseKg',
                        getValue: () => exercise.current_weight ?? 0,
                        setValue: () => {},
                      }}
                      onchange={async (e) => {
                        const input = e.currentTarget as HTMLInputElement;
                        const { value } = clampBaseKgFieldInput(input.value);
                        await db.saveExerciseBaseline(exercise.id, value);
                        await loadData({ preserveSession: true });
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
                <div class="time-readout font-timer text-2xl {hasActiveTimerThis && isOvertime ? 'w-fg-green' : exRed ? 'text-current' : 'text-white'}">
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
                    {@const setUnrecorded = setShowsUnrecordedCross(bubbleStatus)}
                    {@const setBubbleSkipped = exRed || setUnrecorded}
                    <div
                      class="set-bubble relative h-7 rounded-lg flex flex-col items-center justify-center overflow-hidden text-[10px] status-surface
                        {setBubbleSkipped
                          ? 'set-bubble--empty status-surface--skipped'
                          : bubbleStatus === 'empty'
                            ? 'set-bubble--empty status-surface--neutral'
                            : ''}
                        {!setBubbleSkipped && bubbleStatus === 'green' ? 'set-bubble--logged status-surface--green' : ''}
                        {!setBubbleSkipped && bubbleStatus === 'yellow' ? 'set-bubble--logged status-surface--yellow' : ''}
                        {isHoldingSet ? 'set-bubble--holding' : ''}"
                    >
                      {#if isHoldingSet && !isEditingThisSet}
                        <div
                          class="set-bubble-hold-fill"
                          style="width: {repSetHoldProgress}%"
                        ></div>
                      {/if}

                      {#if setUnrecorded}
                        <div class="set-bubble-unrecorded relative z-10 w-full h-full flex items-center justify-center" aria-label="Set not recorded">
                          <X class="size-3.5 shrink-0 opacity-90" strokeWidth={2.5} />
                        </div>
                      {:else if isEditingThisSet}
                        <input type="text" inputmode="numeric" autocomplete="off" id="input-{exercise.id}-{s}" placeholder={exercise.target_reps.toString()}
                          class="prop-num-input absolute inset-0 z-10 w-full h-full bg-transparent border-none outline-none text-center font-sans text-[10px] font-extrabold text-white"
                          use:clampedNumericProp={{
                            kind: 'trackedReps',
                            getValue: () => repsValue ?? 0,
                            setValue: () => {},
                          }}
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
                      {@const setUnrecorded = setShowsUnrecordedCross(bubbleStatus)}
                      {@const setBubbleSkipped = exRed || setUnrecorded}
                      <div
                        class="set-bubble relative h-7 rounded-lg flex flex-col items-center justify-center overflow-hidden text-[10px] status-surface
                          {setBubbleSkipped
                            ? 'set-bubble--empty status-surface--skipped'
                            : bubbleStatus === 'empty'
                              ? 'set-bubble--empty status-surface--neutral'
                              : ''}
                          {!setBubbleSkipped && bubbleStatus === 'green' ? 'set-bubble--logged status-surface--green' : ''}
                          {!setBubbleSkipped && bubbleStatus === 'yellow' ? 'set-bubble--logged status-surface--yellow' : ''}"
                      >
                        {#if setUnrecorded}
                          <div class="set-bubble-unrecorded relative z-10 w-full h-full flex items-center justify-center" aria-label="Set not recorded">
                            <X class="size-3.5 shrink-0 opacity-90" strokeWidth={2.5} />
                          </div>
                        {:else}
                          <button
                            type="button"
                            class="relative z-10 w-full h-full flex flex-col items-center justify-center bg-transparent border-none p-0 font-sans {workoutExercisesEditable ? 'hover:brightness-110' : ''} {exRed ? 'text-current' : 'text-white'}"
                            onclick={() => activateOrSwitchTimeSet(exercise.id, s)}
                            disabled={!workoutExercisesEditable}
                          >
                            <span class="sl text-[8px] tracking-wider opacity-60 block leading-none text-zinc-400">S{s + 1}</span>
                            <span class="sv font-timer text-[11px] block text-current leading-none tabular-nums">{saved ? saved.result : '—'}</span>
                          </button>
                        {/if}
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
                      autocomplete="off"
                      use:focusExerciseNameInput
                      use:clampedTemplateNameProp={{
                        getValue: () => template.name,
                        setValue: (v) => { template.name = v; },
                      }}
                      onclick={(e) => e.stopPropagation()}
                      onblur={() => commitRoutineTemplateNameEdit(template)}
                      onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Escape') {
                          e.preventDefault();
                          (e.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      class="font-medium bg-transparent border-0 p-0 m-0 focus:outline-none focus:ring-0 text-xs uppercase flex-1 min-w-0 truncate leading-none {isAssigned ? 'text-emerald-400' : 'text-white'}"
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
          type="button"
          class="w-8 h-8 shrink-0 rounded-lg border border-[#1e1e1e] bg-transparent text-white flex items-center justify-center"
          onclick={exitEditTemplate}
          title="Save and go back"
        >
          <ArrowLeft class="size-4" />
        </button>
        <span class="text-xs font-bold tracking-wider text-zinc-400 leading-none shrink-0">TEMPLATE EDITOR</span>
        <div class="flex-1 min-w-0 flex items-center">
          <input
            autocomplete="off"
            class="w-full h-8 bg-black border text-xs font-medium uppercase text-center px-2 rounded outline-none placeholder:text-zinc-600 {editingTemplate ? 'border-emerald-700 text-emerald-400 focus:border-emerald-600' : 'border-[#1e1e1e] text-white focus:border-[#2a2a2a]'}"
            placeholder="Template name"
            disabled={!editingTemplate}
            use:clampedTemplateNameProp={{
              getValue: () => draftTemplateName,
              setValue: (v) => { draftTemplateName = v; },
            }}
          />
        </div>
      </div>
      {#if templateSaveError && currentView === 'edit_template'}
        <p class="text-[10px] text-red-300 leading-snug">{templateSaveError}</p>
      {/if}

      {#if !editingTemplate}
        <div class="text-center py-6">
          <p class="text-xs text-zinc-500 mb-2">No template loaded for this weekday.</p>
          <button type="button" class="h-8 px-3 bg-[#141414] border border-[#1e1e1e] text-xs font-bold rounded" onclick={() => enterRoutineBuilder()}>Assign or Create</button>
        </div>
      {:else}
        <div class="space-y-1.5">
        <!-- Exercises + properties: shared grid keeps headers, divider, and footers aligned -->
        <div class="grid grid-cols-[minmax(0,1fr)_9.25rem] gap-x-2 gap-y-1.5 items-stretch">
          <div class="col-start-1 row-start-1 h-5 flex items-center">
            <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">EXERCISES</span>
          </div>
          <div class="col-start-2 row-start-1 h-5 flex items-center border-l border-[#1e1e1e] pl-2">
            <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">PROPERTIES</span>
          </div>

          <div class="col-start-1 row-start-2 flex flex-col min-h-0 min-w-0 self-stretch">
            <div class="flex flex-col gap-1 min-w-0 flex-1 min-h-0">
              {#if draftExercises.length === 0}
                <div class="text-center py-3 border border-dashed border-[#1e1e1e] rounded text-[10px] text-zinc-500">No exercises yet. Tap + below.</div>
              {/if}

              {#each draftExercises as exercise, index (exercise.id)}
                {@const isSelected = selectedExerciseId === exercise.id}
                <div
                  class="flex items-stretch gap-1 h-8"
                  ondragover={handleDragOver}
                  ondrop={(e) => handleDrop(e, index)}
                >
                  <button
                    type="button"
                    draggable="true"
                    class="w-6 h-8 shrink-0 flex items-center justify-center border rounded text-[10px] font-medium leading-none cursor-grab active:cursor-grabbing transition-colors {isSelected ? 'bg-emerald-950/40 border-emerald-800 text-emerald-400' : 'bg-[#141414] border-[#1e1e1e] text-zinc-400 hover:border-[#2a2a2a] hover:text-zinc-200'}"
                    title="Drag to reorder — click to select"
                    onclick={() => {
                      if (exerciseRowDragged) return;
                      selectExercise(exercise.id);
                    }}
                    ondragstart={(e) => handleDragStart(e, index)}
                    ondragend={handleDragEnd}
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
                          autocomplete="off"
                          use:focusExerciseNameInput
                          use:clampedExerciseNameProp={{
                            getValue: () => exercise.name,
                            setValue: (v) => { exercise.name = v; touchDraft(); },
                          }}
                          onclick={(e) => e.stopPropagation()}
                          onblur={endExerciseNameEdit}
                          onkeydown={(e) => {
                            if (e.key === 'Enter' || e.key === 'Escape') {
                              e.preventDefault();
                              (e.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          class="font-medium bg-transparent border-0 p-0 m-0 focus:outline-none focus:ring-0 text-xs uppercase flex-1 min-w-0 truncate leading-none {isSelected ? 'text-emerald-400' : 'text-white'}"
                          placeholder="NAME"
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
              class="w-full h-7 shrink-0 mt-1.5 rounded border border-[#1e1e1e] bg-white flex items-center justify-center text-black hover:bg-zinc-100 hover:border-[#2a2a2a] transition"
              onclick={addNewExercise}
              title="Add exercise"
              aria-label="Add exercise"
            >
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
                    class="relative grid grid-cols-2 rounded border border-[#1e1e1e] bg-[#0a0a0a] p-0.5"
                    role="group"
                    aria-label="Exercise type">
                    <div
                      class="pointer-events-none absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-4px)] rounded bg-white transition-transform duration-200 ease-out"
                      style="transform: translateX({ex.exercise_type === 'time' ? 'calc(100% + 4px)' : '0'})"
                    ></div>
                    <button
                      type="button"
                      class="relative z-10 h-7 flex items-center justify-center text-[9px] font-black tracking-[0.12em] transition-colors {ex.exercise_type === 'reps' ? 'text-black' : 'text-zinc-500 hover:text-zinc-300'}"
                      onclick={() => switchDraftExerciseType(ex, 'reps')}
                    >REPS</button>
                    <button
                      type="button"
                      class="relative z-10 h-7 flex items-center justify-center text-[9px] font-black tracking-[0.12em] transition-colors {ex.exercise_type === 'time' ? 'text-black' : 'text-zinc-500 hover:text-zinc-300'}"
                      onclick={() => switchDraftExerciseType(ex, 'time')}
                    >TIME</button>
                  </div>

                  {#if ex.exercise_type === 'reps'}
                    <div class="grid grid-cols-2 gap-1 text-[9px]">
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Sets</span>
                        <input type="text" inputmode="numeric" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'sets', getValue: () => ex.target_sets, setValue: (v) => { ex.target_sets = v; touchDraft(); } }} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Reps</span>
                        <input type="text" inputmode="numeric" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'reps', getValue: () => ex.target_reps, setValue: (v) => { ex.target_reps = v; touchDraft(); } }} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Base kg</span>
                        <input type="text" inputmode="decimal" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'baseKg', getValue: () => ex.current_weight ?? 0, setValue: (v) => { ex.current_weight = v; touchDraft(); } }} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">+ kg</span>
                        <input type="text" inputmode="decimal" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'incKg', getValue: () => ex.increment, setValue: (v) => { ex.increment = v; touchDraft(); } }} />
                      </div>
                    </div>
                  {:else}
                    <div class="grid grid-cols-2 gap-1 text-[9px]">
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Sets</span>
                        <input type="text" inputmode="numeric" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'sets', getValue: () => ex.target_sets, setValue: (v) => { ex.target_sets = v; touchDraft(); } }} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Min</span>
                        <input type="text" inputmode="numeric" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'mins', getValue: () => ex.target_minutes, setValue: (v) => { ex.target_minutes = v; touchDraft(); } }} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Sec</span>
                        <input type="text" inputmode="numeric" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'secs', getValue: () => ex.target_seconds, setValue: (v) => { ex.target_seconds = v; touchDraft(); } }} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">+ s</span>
                        <input type="text" inputmode="numeric" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'incSec', getValue: () => ex.increment, setValue: (v) => { ex.increment = v; touchDraft(); } }} />
                      </div>
                    </div>
                  {/if}
                  </div>
                {/if}
              {:else}
                <div class="flex-1 min-h-0 flex items-center justify-center text-center px-1 text-[9px] leading-snug text-zinc-500 border border-dashed border-[#1e1e1e] rounded">Select an exercise to edit.</div>
              {/if}
            </div>
          </div>
        </div>
        </div>
      {/if}
    </div>
  {/if}
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
        <div class="p-1 border-b border-[#1e1e1e] bg-[#111]">
          <div
            class="relative grid grid-cols-2 rounded border border-[#1e1e1e] bg-[#0a0a0a] p-0.5"
            role="group"
            aria-label="Authentication mode"
          >
            <div
              class="pointer-events-none absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-4px)] rounded bg-white transition-transform duration-200 ease-out"
              style="transform: translateX({authMode === 'signup' ? 'calc(100% + 4px)' : '0'})"
            ></div>
            <button
              type="button"
              class="relative z-10 h-9 flex items-center justify-center text-[10px] font-black tracking-[0.12em] transition-colors {authMode === 'signin' ? 'text-black' : 'text-zinc-500 hover:text-zinc-300'}"
              disabled={signingIn}
              onclick={() => setAuthMode('signin')}
            >
              SIGN IN
            </button>
            <button
              type="button"
              class="relative z-10 h-9 flex items-center justify-center text-[10px] font-black tracking-[0.12em] transition-colors {authMode === 'signup' ? 'text-black' : 'text-zinc-500 hover:text-zinc-300'}"
              disabled={signingIn}
              onclick={() => setAuthMode('signup')}
            >
              SIGN UP
            </button>
          </div>
        </div>

        <div class="p-3 text-left">
          <div class="relative mb-3" aria-hidden="true">
            <div class="flex justify-between gap-1.5 pointer-events-none select-none">
              <div
                class="relative overflow-hidden after:absolute after:inset-0 after:z-[1] after:bg-black/50 after:pointer-events-none after:content-[''] h-11 w-11 shrink-0 rounded-xl flex items-center justify-center bg-[#0a0a0a] text-zinc-400">
                <Mail class="size-5 relative z-0" />
              </div>
              <div
                class="relative overflow-hidden after:absolute after:inset-0 after:z-[1] after:bg-black/50 after:pointer-events-none after:content-[''] h-11 w-11 shrink-0 rounded-xl border border-[#30363d] flex items-center justify-center bg-[#24292f] text-white">
                <AuthBrandIcon brand="github" class="size-5 text-white relative z-0" />
              </div>
              <div
                class="relative overflow-hidden after:absolute after:inset-0 after:z-[1] after:bg-black/50 after:pointer-events-none after:content-[''] h-11 w-11 shrink-0 rounded-xl flex items-center justify-center bg-white">
                <AuthBrandIcon brand="google" class="size-5 relative z-0" />
              </div>
              <div
                class="relative overflow-hidden after:absolute after:inset-0 after:z-[1] after:bg-black/50 after:pointer-events-none after:content-[''] h-11 w-11 shrink-0 rounded-xl flex items-center justify-center bg-[#5865F2] text-white">
                <AuthBrandIcon brand="discord" class="size-5 text-white relative z-0" />
              </div>
              <div
                class="relative overflow-hidden after:absolute after:inset-0 after:z-[1] after:bg-black/50 after:pointer-events-none after:content-[''] h-11 w-11 shrink-0 rounded-xl flex items-center justify-center bg-black text-white">
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
              if (signingIn || authError || authSuccess || !authSubmitReady) return;
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
                  oninput={clearAuthFeedback}
                />
              </div>
            {:else}
              <div class="relative">
                <User class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-zinc-500 pointer-events-none" />
                <input
                  type="text"
                  autocomplete="username"
                  spellcheck="false"
                  maxlength={MAX_USERNAME_LEN}
                  bind:value={authUsername}
                  disabled={signingIn}
                  placeholder="username"
                  class="h-11 w-full pl-10 pr-3 rounded-xl bg-[#0a0a0a] border border-[#1e1e1e] text-sm text-white placeholder:text-zinc-600 outline-none focus:border-zinc-500 disabled:opacity-60"
                  oninput={(e) => {
                    clearAuthFeedback();
                    authUsername = sanitizeUsernameInput((e.currentTarget as HTMLInputElement).value);
                  }}
                />
              </div>
            {/if}
            <div>
              <div class="relative">
                <Lock class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-zinc-500 pointer-events-none" />
                <input
                  type="password"
                  autocomplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                  maxlength={MAX_PASSWORD_LEN}
                  bind:value={authPassword}
                  disabled={signingIn}
                  placeholder="••••••••"
                  class="h-11 w-full pl-10 pr-3 rounded-xl bg-[#0a0a0a] border border-[#1e1e1e] text-sm text-white placeholder:text-zinc-600 outline-none focus:border-zinc-500 disabled:opacity-60"
                  oninput={(e) => {
                    clearAuthFeedback();
                    authPassword = sanitizePasswordInput((e.currentTarget as HTMLInputElement).value);
                  }}
                />
              </div>
              <div
                class="auth-confirm-reveal"
                class:auth-confirm-reveal--open={authMode === 'signup'}
                aria-hidden={authMode !== 'signup'}
              >
                <div class="auth-confirm-reveal__inner">
                  <div class="relative">
                    <LockKeyhole class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-zinc-500 pointer-events-none z-10" />
                    <input
                      type="password"
                      autocomplete="new-password"
                      maxlength={MAX_PASSWORD_LEN}
                      bind:value={authConfirmPassword}
                      disabled={signingIn || authMode !== 'signup'}
                      placeholder=""
                      tabindex={authMode === 'signup' ? 0 : -1}
                      aria-label="Confirm password"
                      class="h-11 w-full pl-10 pr-3 rounded-xl bg-[#0a0a0a] border border-[#1e1e1e] text-sm text-white outline-none focus:border-zinc-500 disabled:opacity-60"
                      oninput={(e) => {
                        clearAuthFeedback();
                        authConfirmPassword = sanitizePasswordInput((e.currentTarget as HTMLInputElement).value);
                      }}
                    />
                    {#if authMode === 'signup' && !authConfirmPassword}
                      <span
                        class="absolute left-10 top-1/2 -translate-y-1/2 text-sm text-zinc-600 pointer-events-none select-none"
                        aria-hidden="true"
                      >••••••••</span>
                    {/if}
                  </div>
                </div>
              </div>
            </div>
            <div class="auth-submit-crossfade h-11 min-h-11">
              <button
                type="submit"
                class="auth-submit-crossfade__layer auth-submit-btn auth-submit-btn--default h-11 min-h-11 rounded-xl font-black text-[11px] tracking-[0.15em] flex items-center justify-center px-3 text-center leading-snug
                  {authSubmitBtnLit ? 'auth-submit-crossfade__layer--lit auth-submit-crossfade__layer--interactive' : ''}
                  {authFeedbackExiting ? 'auth-submit-crossfade__layer--top' : ''}"
                disabled={signingIn || authFeedbackLit || (!authSubmitReady && !authFeedbackExiting)}
                aria-hidden={!authSubmitBtnLit}
                aria-busy={signingIn}
                aria-label={signingIn ? 'Checking credentials' : authMode === 'signup' ? 'Sign up' : 'Sign in'}
                tabindex={authSubmitBtnLit ? 0 : -1}
              >
                {#if signingIn}
                  <RefreshCw class="size-4 shrink-0 animate-spin" aria-hidden="true" />
                {:else}
                  {authMode === 'signup' ? 'SIGN UP' : 'SIGN IN'}
                {/if}
              </button>
              {#if authCrossfadeShowFeedback}
                <div
                  role="status"
                  aria-live="polite"
                  class="auth-submit-crossfade__layer auth-submit-btn auth-submit-btn--feedback h-11 min-h-11 rounded-xl font-black text-[11px] tracking-[0.15em] flex items-center justify-center px-3 text-center leading-snug
                    {authError ? 'auth-submit-btn--error' : 'auth-submit-btn--success'}
                    {authFeedbackLit ? 'auth-submit-crossfade__layer--lit auth-submit-crossfade__layer--top' : ''}
                    {authError && authFeedbackLit ? 'auth-submit-btn--error-nudge' : ''}"
                  title={authError ?? authSuccess ?? undefined}
                  ontransitionend={onAuthCrossfadeTransitionEnd}
                >
                  <span class="auth-submit-btn__feedback flex items-center gap-1.5 min-w-0 max-w-full">
                    {#if authError}
                      <CircleAlert class="auth-submit-btn__icon size-3.5 shrink-0" aria-hidden="true" />
                    {:else}
                      <CircleCheck class="auth-submit-btn__icon size-3.5 shrink-0" aria-hidden="true" />
                    {/if}
                    <span class="line-clamp-2 min-w-0">{authError ?? authSuccess}</span>
                  </span>
                </div>
              {/if}
            </div>
          </form>
        </div>
      </div>
    </div>
  {/if}
  </div>

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
    © 2026 LIFT TRACKER — All rights reserved by Arya
  </div>

</div>
