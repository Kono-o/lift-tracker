<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { PUBLIC_SUPABASE_URL } from '$env/static/public';
  import { db, supabase, canChangePassword, formatAccountError, formatAuthError, formatDbError, getAuthDisplayName, getAuthRedirectError, isTemplateAssignable, isUsernameAccount, isWorkoutInProgress, MAX_PASSWORD_LEN, MAX_USERNAME_LEN, sanitizePasswordInput, sanitizeUsernameInput, validateEmail, validatePassword, validateUsername, type Template, type Exercise, type TrackedStat, type StatLogSnapshotRow, type WorkoutHistory } from '$lib/db';
  import GeneratedAvatar from '$lib/components/GeneratedAvatar.svelte';
  import HeaderClock from '$lib/components/HeaderClock.svelte';
  import { horizontalSwipe } from '$lib/horizontalSwipe';
  import { scrollEdgeFade } from '$lib/scrollEdgeFade';
  import { getDbActivitySnapshot, runDbActivityBatch, subscribeDbActivity, subscribeDbActivitySnapshot } from '$lib/dbActivity';
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
    captureExerciseTypeFields,
    mergeExerciseTypeStash,
    applyDraftExerciseType,
    DEFAULT_TARGET_MINUTES,
    DEFAULT_TARGET_REPS,
    DEFAULT_BASE_KG,
    DEFAULT_INCREMENT_KG,
    DEFAULT_TARGET_SECONDS,
    type ExerciseTypeFieldStash,
    syncClampedInput,
  } from '$lib/exerciseSanitize';
  import {
    MAX_STATS,
    normalizeDraftStat,
    toTrackedStat,
    sanitizeStatLogValue,
    validateDraftStats,
  } from '$lib/statSanitize';
  import {
    clampedNumericProp,
    clampedTemplateNameProp,
    clampedExerciseNameProp,
    clampedStatNameProp,
    clampedStatUnitProp,
  } from '$lib/clampedInputs';
  import {
    ArrowLeft,
    BarChart3,
    Bed,
    CalendarDays,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Dumbbell,
    FileX,
    HardDrive,
    History,
    List,
    Lock,
    Minus,
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
  import {
    APP_VERSION,
  } from '$lib/version';
  import {
    checkForPostUpdateChangelog,
    dismissUpdateThisLaunch,
    fetchLatestRelease,
    openInstallPermissionSettings,
    promptInstallApk,
    releaseToUpdateInfo,
    shouldShowUpdatePrompt,
    UpdaterNative,
    type UpdateInfo,
  } from '$lib/updater';
  import { isNativeApp } from '$lib/native';
  import { App } from '@capacitor/app';
  import confetti from 'canvas-confetti';

  // Constants
  const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const TEMPLATE_COLORS: string[] = [
    '#4ADE80', // green (was orange)
    '#afe64f', // saturated lime (25% less saturated, slightly brighter)
    '#65c7e9', // sky blue (25% less saturated, slightly brighter)
    '#9173eb', // blurple (25% less saturated, slightly brighter)
    '#eb7393', // pink (25% less saturated, slightly brighter)
  ];

  function getTemplateColor(id: number): string {
    return TEMPLATE_COLORS[Math.max(0, Math.min(4, Math.floor(id || 0)))];
  }

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

  let dbIoFlash = $state(false);
  let dbIoFlashTimer: ReturnType<typeof setTimeout> | null = null;
  let dbActivitySnapshot = $state(getDbActivitySnapshot());
  let showSettingsPanel = $state(false);

  // Self-update (Android sideload only). Mirrors settings panel UX: centered + blur.
  let showUpdatePrompt = $state(false);
  let updateInfo = $state<UpdateInfo | null>(null);
  let updateDownloadProgress = $state(0);
  /** Once user taps Install we become unclosable until the OS install prompt or failure. */
  let updateInstalling = $state(false);
  let updateError = $state<string | null>(null);
  /** Path returned by native downloadUpdate (e.g. "updates/lift-tracker-update.apk").
   *  Lets us re-attempt *only* the install step after the user grants unknown-sources permission
   *  and returns to the app, without re-downloading or hitting the updateInstalling guard.
   */
  let downloadedApkPath = $state<string | null>(null);

  /** Reactive flag for the pre-download permission gate UI state. */
  let isWaitingForUpdatePermission = $derived(
    updateInstalling &&
    updateDownloadProgress === 0 &&
    !!updateError &&
    /unknown|permission|Install unknown apps/i.test(updateError)
  );

  // Post-update "what's new" shown on first launch of a new binary.
  let showPostUpdate = $state(false);
  let postUpdateVersion = $state('');
  let postUpdateNotes = $state('');

  // Confetti spray when the updated menu opens (for nice celebration)
  $effect(() => {
    if (showPostUpdate) {
      // Radiate out from center, a little bit, not too long
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 }
      });
      confetti({
        particleCount: 50,
        angle: 90,
        spread: 50,
        origin: { y: 0.6 }
      });
    }
  });

  // Same confetti spray on website when the (pre) update menu opens via footer demo
  $effect(() => {
    if (showUpdatePrompt && !isNativeApp()) {
      // Radiate out from center, a little bit, not too long
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 }
      });
      confetti({
        particleCount: 50,
        angle: 90,
        spread: 50,
        origin: { y: 0.6 }
      });
    }
  });

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

  // State
  let selectedDate = $state(new Date(REAL_TODAY));
  let viewedLog = $state<any>(null);
  let weekLogs = $state<Record<string, any | null>>({});
  let trackedStats = $state<TrackedStat[]>([]);
  let statLogs = $state<Record<string, Record<string, number>>>({});
  let statLogSnapshots = $state<StatLogSnapshotRow[]>([]);
  let draftStats = $state<TrackedStat[]>([]);
  let selectedDraftStatId = $state<string | null>(null);
  let editingStatNameId = $state<string | null>(null);
  let statSaveError = $state<string | null>(null);
  let statDraftSaveInFlight = false;
  let statDraggedIndex = $state<number | null>(null);
  let statRowDragged = false;
  let currentView = $state<'track' | 'swap_template' | 'edit_template' | 'stats' | 'edit_stats'>('track');
  let templateEditorReturnView = $state<'track' | 'swap_template'>('track');

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
      clearInterval(visualUpdateTimer);
      timerStartTimestamp = null;
      currentVisualDot = 0;
      visualMsPerDot = 0;
      visualRawStep = 0;
      visualRawStep = 0;
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

  function shiftSelectedDate(days: number) {
    if (weekCalendarLocked) return;
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + days);
    selectDate(d);
  }

  function goPrevDay() {
    shiftSelectedDate(-1);
  }

  function goNextDay() {
    shiftSelectedDate(1);
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
  function effectiveAssignmentTemplateId(templateId: string | null): string | null {
    if (!templateId) return null;
    const tpl = templates.find((t) => t.id === templateId);
    return isTemplateAssignable(tpl) ? templateId : null;
  }

  let builderAssignedTemplateId = $derived(
    effectiveAssignmentTemplateId(builderAssignments[builderEditingDay] ?? null),
  );
  let builderDayAssignmentLabel = $derived.by(() => {
    const day = DAY_NAMES[builderEditingDay].toUpperCase();
    const tid = effectiveAssignmentTemplateId(builderAssignments[builderEditingDay] ?? null);
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
    templateErrorFading = false;
    editingRoutineTemplateNameId = null;
    routineTemplateNameEditOriginal = null;
    const newAssignments: Record<number, string | null> = {};
    for (const s of schedule) {
      const tid = s.template_id ?? null;
      if (tid) {
        const tpl = templates.find((t) => t.id === tid);
        newAssignments[s.day_of_week] = isTemplateAssignable(tpl) ? tid : null;
      } else {
        newAssignments[s.day_of_week] = null;
      }
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
    exerciseLibrary = [];
    deletedLibraryExerciseIds = new Set();
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
  let bootAccountReveal = $state(false);
  let stageRevealActive = $state(false);
  const BOOT_ACCOUNT_REVEAL_HOLD_MS = 900;

  function onBootOverlayTransitionEnd(e: TransitionEvent) {
    if (e.propertyName !== 'opacity' || !bootOverlayExiting) return;
    bootOverlayVisible = false;
    bootOverlayExiting = false;
    bootAccountReveal = false;
  }

  $effect(() => {
    if (showBootScreen) {
      bootOverlayVisible = true;
      bootOverlayExiting = false;
      bootAccountReveal = false;
      stageRevealActive = false;
      return;
    }
    let cancelled = false;
    let revealHoldTimer: ReturnType<typeof setTimeout> | undefined;
    let exitFallbackTimer: ReturnType<typeof setTimeout> | undefined;
    stageRevealActive = false;
    bootAccountReveal = false;

    if (!currentUser) {
      bootOverlayVisible = false;
      bootOverlayExiting = false;
      void tick().then(() => {
        if (cancelled) return;
        stageRevealActive = true;
      });
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      await tick();
      if (cancelled) return;
      await preloadSupabaseBackend();
      if (cancelled) return;
      bootAccountReveal = true;
      revealHoldTimer = setTimeout(() => {
        if (cancelled) return;
        stageRevealActive = true;
        bootOverlayExiting = true;
        exitFallbackTimer = setTimeout(() => {
          if (cancelled || !bootOverlayExiting) return;
          bootOverlayVisible = false;
          bootOverlayExiting = false;
          bootAccountReveal = false;
        }, 340);
      }, BOOT_ACCOUNT_REVEAL_HOLD_MS);
    })();

    return () => {
      cancelled = true;
      if (revealHoldTimer) clearTimeout(revealHoldTimer);
      if (exitFallbackTimer) clearTimeout(exitFallbackTimer);
    };
  });

  /** One-time startup update checks (Android native only). Non-blocking.
   *  ONLY after the user is logged in (currentUser) AND all their data has finished loading (hasInitialLoad)
   *  AND the main menu is fully visible (post boot, post reveal).
   */
  let didRunStartupUpdateCheck = false;
  $effect(() => {
    if (didRunStartupUpdateCheck) return;
    if (!isNativeApp()) return;

    // Strict guard: must be logged in + data loaded + main UI ready
    if (!currentUser || !hasInitialLoad || !stageRevealActive || isLoading || bootOverlayVisible || showBootScreen) return;

    // Extra safety: double-check we are past the entire boot sequence for this user
    if (showBootScreen || bootOverlayVisible) return;

    didRunStartupUpdateCheck = true;

    // Small delay so the main menu has time to fully settle and render before the update prompt appears.
    // This prevents it from feeling like "the first thing" on app open.
    setTimeout(() => {
      // Fire and forget — we show modals when data arrives.
      // Errors (e.g. no network, GitHub rate limit) are non-fatal; we just skip the prompt.
      void (async () => {
        try {
          // Post-update changelog takes precedence in presentation order (only shows on fresh binary).
          const post = await checkForPostUpdateChangelog();
          if (post && !showUpdatePrompt) {
            postUpdateVersion = post.version;
            postUpdateNotes = post.notes ?? '';
            showPostUpdate = true;
            return; // don't also nag about "update available" on the same launch
          }

          const info = await shouldShowUpdatePrompt();
          if (info) {
            updateInfo = info;
            updateDownloadProgress = 0;
            updateInstalling = false;
            updateError = null;
            downloadedApkPath = null;
            showUpdatePrompt = true;
          }
        } catch (e) {
          // Silent — update is a nice-to-have. "Failed to fetch" etc. will appear in console only.
          console.error('[updater] startup check failed (non-fatal)', e);
        }
      })();
    }, 600);
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
  let editingAccountName = $state(false);
  let accountNameEditValue = $state('');
  let showChangePasswordForm = $state(false);
  let changePasswordNew = $state('');
  let changePasswordConfirm = $state('');
  let changePasswordError = $state<string | null>(null);
  let changePasswordSuccess = $state<string | null>(null);
  let changePasswordFeedbackExiting = $state(false);
  let changePasswordFeedbackEntering = $state(false);
  let changePasswordFeedbackExitTimer: ReturnType<typeof setTimeout> | null = null;

  let changePasswordFeedbackVisible = $derived(!!(changePasswordError || changePasswordSuccess));
  let changePasswordCrossfadeShowFeedback = $derived(
    changePasswordFeedbackVisible || changePasswordFeedbackExiting,
  );
  let changePasswordSubmitBtnLit = $derived(
    !changePasswordFeedbackVisible ||
      changePasswordFeedbackExiting ||
      changePasswordFeedbackEntering,
  );
  let changePasswordFeedbackLit = $derived(
    changePasswordFeedbackVisible &&
      !changePasswordFeedbackExiting &&
      !changePasswordFeedbackEntering,
  );
  let changePasswordSubmitReady = $derived(
    !!changePasswordNew && !!changePasswordConfirm,
  );

  let accountDisplayName = $derived(getAuthDisplayName(currentUser));
  let accountProvider = $derived.by(() => {
    if (isUsernameAccount(currentUser)) return 'Username';
    const id = currentUser?.identities?.[0]?.provider ?? currentUser?.app_metadata?.provider;
    if (!id || id === 'email') return 'Email';
    return String(id).charAt(0).toUpperCase() + String(id).slice(1);
  });
  let accountCanChangePassword = $derived(canChangePassword(currentUser));
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
  let exerciseLibrary = $state<Exercise[]>([]);
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
  let timerStartTimestamp = $state<number | null>(null);
  let currentVisualDot = $state(0);
  let visualMsPerDot = $state(0);
  let visualDotCount = $state(42);
  let visualRawStep = $state(0);
  let visualUpdateTimer: any = null;
  let activeTimerExerciseId = $state<string | null>(null);
  let activeTimerSetIndex = $state<number | null>(null);

  // Tracking data maps
  let trackedReps = $state<Record<string, number>>({});
  let completedTimers = $state<Record<string, { result: string; met: boolean }>>({});
  let editingSetKey = $state<string | null>(null);
  let repSetHoldTimer: ReturnType<typeof setInterval> | null = null;
  let repSetHoldKey = $state<string | null>(null);
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

  let holdCautionDisplayKind = $state<'signout' | 'delete' | null>(null);
  let holdCautionMorphFade = $state(true);

  let holdCautionKind = $derived.by((): 'signout' | 'delete' | null => {
    if (deleteAccountProgress > 0) return 'delete';
    if (signOutProgress > 0) return 'signout';
    return null;
  });
  let holdCautionMessage = $derived(
    holdCautionDisplayKind === 'delete'
      ? 'Permanently deletes your account and all workout data.'
      : holdCautionDisplayKind === 'signout'
        ? 'Ends your session on this device.'
        : '',
  );
  const HOLD_CONFIRM_MS = 1000;

  const REP_SET_HOLD_MS = 250;
  const ACTIVE_SESSION_STORAGE_KEY = 'lift-tracker:active-session';

  const HEADER_TIMER_FADE_MS = 450;
  let workoutProgressSaveInFlight = false;
  let workoutProgressSavePending = false;
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
  const REST_CTA_SOURCE = 'REST DAY';
  const ERASE_CTA_SOURCE = 'ERASE';
  const workoutCenterBtnClass =
    'workout-cta-center font-sans col-span-3 rounded-xl flex items-center justify-center text-center border-2 hover:brightness-110 group relative';
  const workoutSideBtnClass =
    'workout-cta-side font-sans col-span-1 rounded-xl flex items-center justify-center text-center relative overflow-hidden hover:brightness-110 group';
  const workoutCtaEmptyClass =
    'workout-cta-empty bg-[#0d0d0d] pointer-events-none';
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
  let templateErrorClearTimer: number | null = null;
  let templateErrorFading = $state(false);
  let isCreatingTemplate = $state(false);

  // Draft state for template editing (local until commit on finish)
  let draftExercises = $state<any[]>([]);
  /** Preserves reps/time fields across type toggles (DB nulls inactive type columns). */
  let exerciseTypeFieldStash = $state<Record<string, ExerciseTypeFieldStash>>({});
  let draftTemplateName = $state('');
  let draftTemplateColor = $state(0); // 0-4 (5 colors)
  let selectedExerciseId = $state<string | null>(null);
  let editingExerciseNameId = $state<string | null>(null);
  let showExerciseLibraryPicker = $state(false);
  let libraryPickerClosing = $state(false);
  const LIBRARY_PICKER_MS = 220;
  let selectedLibraryExerciseId = $state<string | null>(null);
  let deletedLibraryExerciseIds = $state(new Set<string>());

  function isLibraryExerciseId(id: string | null | undefined): boolean {
    return !!id && !id.startsWith('temp-');
  }

  /** All persisted exercises the user owns (library row + any linked on templates). */
  let librarySourcePool = $derived.by(() => {
    const byId = new Map<string, Exercise>();
    for (const ex of exerciseLibrary) {
      if (isLibraryExerciseId(ex.id)) byId.set(ex.id, ex);
    }
    for (const tpl of templates) {
      for (const ex of tpl.exercises) {
        if (isLibraryExerciseId(ex.id) && !byId.has(ex.id)) byId.set(ex.id, ex);
      }
    }
    return byId;
  });

  let libraryExercisesAvailable = $derived.by(() => {
    const inDraft = new Set(
      draftExercises.map((e) => e.id).filter((id) => isLibraryExerciseId(id)),
    );
    return [...librarySourcePool.values()].filter((ex) => !inDraft.has(ex.id));
  });

  let showLibraryButton = $derived(libraryExercisesAvailable.length > 0);

  // Filtered version for the library panel that excludes ones we just optimistically deleted (for instant UI)
  let availableLibraryForPicker = $derived.by(() => {
    return libraryExercisesAvailable.filter((ex) => !deletedLibraryExerciseIds.has(ex.id));
  });

  function closeLibraryPicker() {
    if (!showExerciseLibraryPicker || libraryPickerClosing) return;
    libraryPickerClosing = true;
    selectedLibraryExerciseId = null;
    deletedLibraryExerciseIds = new Set();
    setTimeout(() => {
      showExerciseLibraryPicker = false;
      libraryPickerClosing = false;
    }, LIBRARY_PICKER_MS);
  }

  // Close the library picker when nothing is available to pick or the button hides.
  $effect(() => {
    if (showExerciseLibraryPicker && (!showLibraryButton || availableLibraryForPicker.length === 0)) {
      closeLibraryPicker();
    }
  });

  function selectLibraryExercise(id: string | null) {
    if (selectedLibraryExerciseId === id) {
      selectedLibraryExerciseId = null;
    } else {
      selectedLibraryExerciseId = id;
    }
  }

  function moveLibraryExerciseToTemplate(exercise: Exercise) {
    if (!editingTemplateId) return;
    if (draftExercises.some((e) => e.id === exercise.id)) return;
    const copy = { ...exercise };
    normalizeDraftExercise(copy);
    copy.display_order = draftExercises.length;
    draftExercises = [...draftExercises, copy];
    selectExercise(exercise.id);
    selectedLibraryExerciseId = null;
    void persistTemplateExercisesNow();
  }

  function deleteLibraryExercise(exercise: Exercise) {
    if (!editingTemplateId) return;
    const id = exercise.id;

    deletedLibraryExerciseIds = new Set([...deletedLibraryExerciseIds, id]);
    selectedLibraryExerciseId = null;

    draftExercises = draftExercises.filter((e: any) => e.id !== id);
    if (selectedExerciseId === id) {
      selectedExerciseId = draftExercises.length > 0 ? draftExercises[draftExercises.length - 1].id : null;
    }

    templates = templates.map((t) => ({
      ...t,
      exercises: t.exercises.filter((ex) => ex.id !== id),
    }));
    exerciseLibrary = exerciseLibrary.filter((ex) => ex.id !== id);

    void db.deleteExercise(id).catch((err) => {
      console.error('Failed to delete exercise from library', err);
      const reverted = new Set(deletedLibraryExerciseIds);
      reverted.delete(id);
      deletedLibraryExerciseIds = reverted;
      void loadData({ preserveSession: true }).catch(() => {});
    });
  }

  let editingTemplateId = $state('');
  let templateSaveError = $state<string | null>(null);
  let templateDraftSaveInFlight = false;
  let templateDraftSavePending = false;
  let templateNamePersistTimer: ReturnType<typeof setTimeout> | null = null;
  let templateNamePersistId: string | null = null;
  let editorExitSaving = $state(false);
  let editingTemplate = $derived(
    editingTemplateId ? templates.find((t) => t.id === editingTemplateId) ?? null : null,
  );

  // Svelte 5 Derived State
  let selectedDateStr = $derived(toDateStr(selectedDate));
  let selectedWeekday = $derived(selectedDate.getDay());
  let currentDaySchedule = $derived(schedule.find(s => s.day_of_week === selectedWeekday));
  let activeTemplate = $derived.by(() => {
    const tid = effectiveAssignmentTemplateId(currentDaySchedule?.template_id ?? null);
    if (!tid) return null;
    return templates.find((t) => t.id === tid) ?? null;
  });
  let isViewingToday = $derived(selectedDateStr === REAL_TODAY_STR);
  let isFuture = $derived(selectedDateStr > REAL_TODAY_STR);
  let isPastSelected = $derived(selectedDateStr < REAL_TODAY_STR && !isViewingToday);
  let accountCreatedDateStr = $derived.by(() => {
    const raw = currentUser?.created_at;
    if (!raw) return null;
    return toDateStr(new Date(raw));
  });
  let isBeforeAccountCreation = $derived(
    accountCreatedDateStr != null && selectedDateStr < accountCreatedDateStr,
  );
  /** No template on this weekday in the current routine. */
  let isScheduledRestDay = $derived(!activeTemplate && templates.length > 0);
  /** Real workout log for the selected day (completed, skipped, or in progress — not rest). */
  let hasViewedWorkoutLog = $derived(!!viewedLog && !viewedLog.workout_snapshot?.is_rest);
  /** Past day log fetch finished (null = confirmed no log). */
  let isSelectedDayLogResolved = $derived(isViewingToday || weekLogs[selectedDateStr] !== undefined);
  let isSelectedDayLogLoading = $derived(!isViewingToday && !!currentUser && !isSelectedDayLogResolved);
  /** Past day with no log — includes every day before the account existed. */
  let isPastUnloggedWorkoutDay = $derived(
    isPastSelected &&
      isSelectedDayLogResolved &&
      weekLogs[selectedDateStr] === null &&
      (isBeforeAccountCreation || !!activeTemplate),
  );
  /** Rest day screen: logged rest or scheduled rest with no workout log to show. */
  let isRestDayView = $derived(
    !!viewedLog?.workout_snapshot?.is_rest ||
      (isScheduledRestDay && !hasViewedWorkoutLog && !isBeforeAccountCreation),
  );
  let isPastUnloggedView = $derived(isPastUnloggedWorkoutDay);
  /** Rest / unlogged days: dotted side slots + go-to-today when not on today. */
  let isNoWorkoutCtaMode = $derived(isRestDayView || isPastUnloggedView);
  /** Use rest/unlogged CTA layout even if today's session state is non-idle while viewing a rest day. */
  let useNoWorkoutCtaLayout = $derived(
    isNoWorkoutCtaMode && (workoutState === 'idle' || !isViewingToday || isRestDayView),
  );
  /** Stats CTA on today's rest-day layout (including during an active session). */
  let statsCtaEnabled = $derived(isViewingToday && isScheduledRestDay);
  let ctaBarEditorDisabled = $derived(
    currentView === 'swap_template' ||
      currentView === 'edit_template' ||
      currentView === 'edit_stats' ||
      (currentView === 'stats' && workoutState !== 'active'),
  );
  let ctaBarVisible = $derived(
    (currentView === 'track' ? (activeTemplate || isNoWorkoutCtaMode) : true) &&
      (currentView === 'track' ||
        currentView === 'swap_template' ||
        currentView === 'edit_template' ||
        currentView === 'stats' ||
        currentView === 'edit_stats') &&
      (isViewingToday ||
        viewedLog ||
        selectedDateStr > REAL_TODAY_STR ||
        isNoWorkoutCtaMode ||
        currentView !== 'track'),
  );
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

  // Precompute all per-day data for the week strip once per render.
  // This avoids repeating expensive lookups + function calls inside the Svelte {#each},
  // which helps a lot on lower-powered phones when expanding the week calendar.
  let weekDayData = $derived.by(() => {
    return currentWeekDates.map((dayInfo) => {
      const isSelected = dayInfo.key === selectedDateStr;
      const isRealToday = dayInfo.isRealToday;
      const daySchedule = schedule[dayInfo.weekday];
      const hasTemplate = !!effectiveAssignmentTemplateId(daySchedule?.template_id ?? null);
      const isRest = !hasTemplate;
      const dayLog = isRealToday ? todayLog : (weekLogs[dayInfo.key] ?? null);
      const dayHasWorkoutLog = !!dayLog && !dayLog.workout_snapshot?.is_rest;
      const dayDone = isRealToday ? workoutState === 'done' : false;
      const daySkipped = isRealToday
        ? workoutState === 'skipped'
        : logIsSkipped(dayLog);
      const dayCompletion = dayCalendarCompletionStatus(dayLog, isRealToday);

      // Build the dynamic part of the class string once
      const dynamicClasses = [
        (dayDone || (!isRealToday && dayHasWorkoutLog && dayCompletion !== 'neutral' && dayCompletion !== 'skipped' && dayCompletion !== 'untouched'))
          ? (dayCompletion === 'green' ? 'w-cal-green' : dayCompletion === 'untouched' ? 'w-cal-skipped' : 'w-cal-yellow')
          : '',
        (daySkipped || dayCompletion === 'untouched') ? 'w-cal-skipped' : '',
        (isSelected && !isRealToday && !dayDone && !daySkipped && dayCompletion === 'neutral') ? '!bg-[#1e1e1e] !text-white' : '',
        (isRealToday && !dayDone && !daySkipped) ? '!bg-white !text-black hover:!text-black' : '',
        (isRest && !isSelected && !dayDone && !daySkipped) ? 'text-zinc-500' : '',
      ].filter(Boolean).join(' ');

      return {
        dayInfo,
        isSelected,
        isRealToday,
        hasTemplate,
        isRest,
        dayLog,
        dayHasWorkoutLog,
        dayDone,
        daySkipped,
        dayCompletion,
        dynamicClasses,
      };
    });
  });
  let weekPlan = $derived.by(() =>
    Array.from({ length: 7 }, (_, dayOfWeek) => {
      const row = schedule.find((s) => s.day_of_week === dayOfWeek);
      const tid = effectiveAssignmentTemplateId(row?.template_id ?? null);
      const tpl = tid ? templates.find((t) => t.id === tid) : null;
      const color = tpl ? getTemplateColor(tpl.color ?? 0) : null;
      return {
        day: DAYS[dayOfWeek],
        hasTemplate: !!tid,
        color,
      };
    }),
  );
  let selectedDayLabel = $derived.by(() => {
    if (isViewingToday) return 'TODAY';
    const realTomorrow = new Date(REAL_TODAY);
    realTomorrow.setDate(REAL_TODAY.getDate() + 1);
    if (selectedDateStr === toDateStr(realTomorrow)) return 'TOMORROW';
    const realYesterday = new Date(REAL_TODAY);
    realYesterday.setDate(REAL_TODAY.getDate() - 1);
    if (selectedDateStr === toDateStr(realYesterday)) return 'YESTERDAY';
    if (isFuture) return selectedDateDisplay.nice;
    return DAY_NAMES[selectedWeekday].toUpperCase();
  });
  let workoutLabel = $derived(`${selectedDayLabel}'S WORKOUT`);
  let unloggedHeroLine = $derived.by(() => {
    const realYesterday = new Date(REAL_TODAY);
    realYesterday.setDate(REAL_TODAY.getDate() - 1);
    if (selectedDateStr === toDateStr(realYesterday)) {
      return 'NO WORKOUT WAS LOGGED YESTERDAY';
    }
    return `NO WORKOUT WAS LOGGED ON ${selectedDateDisplay.nice}`;
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
    if (workoutState === 'active' && isViewingToday) return sessionStatus as HeaderSurfaceStatus;
    const completion = headerCompletionDisplay;
    if (completion === 'untouched' || completion === 'skipped') return 'skipped';
    if (completion === 'green') return 'green';
    if (completion === 'yellow') return 'yellow';
    return 'neutral';
  });

  $effect(() => {
    const kind = holdCautionKind;
    if (kind) {
      holdCautionMorphFade = false;
      holdCautionDisplayKind = kind;
    } else if (holdCautionDisplayKind) {
      holdCautionMorphFade = true;
      holdCautionDisplayKind = null;
    }
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
    viewedLog = null;
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

  // Fetch logs for week strip only when expanded (avoid work while collapsed)
  $effect(() => {
    if (!currentUser || weekCalendarDisplayCollapsed) return;
    const visible = currentWeekDates;
    const missing: string[] = [];
    for (const d of visible) {
      const k = d.key;
      if (k === REAL_TODAY_STR) {
        if (weekLogs[k] !== todayLog) {
          weekLogs = { ...weekLogs, [k]: todayLog };
        }
        continue;
      }
      if (!(k in weekLogs)) {
        missing.push(k);
      }
    }
    if (missing.length === 0) return;

    // Defer fetch until the open animation finishes so it does not jank the transition.
    const delay = WEEK_CALENDAR_MS;

    setTimeout(() => {
      // Re-check visibility in case the user navigated away very quickly
      const stillVisibleNow = new Set(currentWeekDates.map((d) => d.key));
      const stillMissing = missing.filter((k) => stillVisibleNow.has(k) && !(k in weekLogs));
      if (stillMissing.length === 0) return;

      db.getLogsForDates(stillMissing)
        .then((logsByDate) => {
          const stillVisible = new Set(currentWeekDates.map((d) => d.key));
          const updates: Record<string, any | null> = {};
          for (const [k, log] of Object.entries(logsByDate)) {
            if (stillVisible.has(k)) {
              updates[k] = log;
            }
          }
          if (Object.keys(updates).length > 0) {
            weekLogs = { ...weekLogs, ...updates };
          }
        })
        .catch((err) => {
          console.error('week log batch fetch failed', err);
        });
    }, delay);
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

  function parseSecondsFromTimeResult(result: string | null | undefined): number {
    if (!result) return 0;
    // New format: MM:SS (or M:SS)
    let match = result.match(/(\d+):(\d{1,2})/);
    if (match) return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    // Legacy format: 00m00s (or 0m0s)
    match = result.match(/(\d+)m(\d+)s/i);
    if (match) return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    return 0;
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

  function timeExerciseMeetsTarget(exercise: Exercise): boolean {
    if (exercise.target_sets <= 0) return false;
    const targetSeconds = (exercise.target_minutes || 0) * 60 + (exercise.target_seconds || 0);
    const timers = displayCompletedTimers();
    for (let s = 0; s < exercise.target_sets; s++) {
      const key = `${exercise.id}-${s}`;
      const isActiveSet =
        activeTimerExerciseId === exercise.id && activeTimerSetIndex === s;
      if (isActiveSet) {
        if (targetSeconds <= 0 || countdownSeconds < targetSeconds) return false;
        continue;
      }
      const t = timers[key];
      if (!t?.met) return false;
    }
    return true;
  }

  /** Live session: PR = every set logged and at/above target (matches green set bubbles). */
  function exerciseLiveIsPr(exercise: Exercise): boolean {
    if (exercise.exercise_type === 'time') return timeExerciseMeetsTarget(exercise);
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

  function exerciseActiveTimerOvertime(exercise: Exercise): boolean {
    if (activeTimerExerciseId !== exercise.id || activeTimerSetIndex === null) return false;
    if (exercise.exercise_type !== 'time') return false;
    const targetSeconds = (exercise.target_minutes || 0) * 60 + (exercise.target_seconds || 0);
    return targetSeconds > 0 && countdownSeconds >= targetSeconds;
  }

  function getExerciseStatus(exercise: Exercise): 'green' | 'yellow' | 'neutral' | 'skipped' {
    if (isSkippedWorkoutView()) return 'skipped';
    if (isCompletedWorkoutView() && exerciseIsUntouched(exercise)) return 'skipped';
    if (isViewingToday && useLiveSessionTracking()) {
      if (exercise.exercise_type === 'time') {
        if (exerciseActiveTimerOvertime(exercise)) return 'green';
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
        secs = parseSecondsFromTimeResult(String(str));
      }
    }
    if (secs == null) return undefined;
    const met =
      targetSecs != null && targetSecs > 0 ? secs >= targetSecs : secs > 0;
    return { result: formatTime(secs), met };
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
        const secs = parseSecondsFromTimeResult(e.result);
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
            times[key] = {
              result: formatTime(secs),
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
      color: 0,
      exercises: snapEx.map(normalizeLoggedExForList),
    };
  }

  type OngoingTimerBackup = {
    exerciseId: string;
    setIndex: number;
    countdownSeconds: number;
    countdownRunning: boolean;
    timerStartTimestamp: number | null;
  };

  type ActiveSessionBackup = {
    date: string;
    templateId: string | null;
    templateName?: string;
    trackedReps: Record<string, number>;
    completedTimers: Record<string, { result: string; met: boolean }>;
    workoutStartedAt: number;
    ongoingTimer?: OngoingTimerBackup | null;
  };

  function ongoingTimerBackupFromState(): OngoingTimerBackup | null {
    if (activeTimerExerciseId == null || activeTimerSetIndex == null) return null;
    return {
      exerciseId: activeTimerExerciseId,
      setIndex: activeTimerSetIndex,
      countdownSeconds,
      countdownRunning,
      timerStartTimestamp: countdownRunning ? timerStartTimestamp : null,
    };
  }

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
      ongoingTimer: ongoingTimerBackupFromState(),
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
    if (backup.ongoingTimer) {
      restoreOngoingExerciseTimer(backup.ongoingTimer, template);
    }
    return true;
  }

  function tryRestoreOngoingTimerFromBackup(backup: ActiveSessionBackup | null) {
    if (!backup?.ongoingTimer) return;
    const key = `${backup.ongoingTimer.exerciseId}-${backup.ongoingTimer.setIndex}`;
    if (completedTimers[key]) return;
    restoreOngoingExerciseTimer(
      backup.ongoingTimer,
      activeWorkoutTemplate ?? activeTemplate,
    );
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
        } else {
          tryRestoreOngoingTimerFromBackup(backup);
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

  function applyWorkoutLogLocally(log: WorkoutHistory | null, dateKey: string) {
    weekLogs = { ...weekLogs, [dateKey]: log };
    if (dateKey === selectedDateStr) viewedLog = log;
    if (dateKey === REAL_TODAY_STR) todayLog = log;
  }

  function saveExerciseBaselineOptimistic(exerciseId: string, rawValue: number) {
    const { value } = clampBaseKgFieldInput(String(rawValue));
    patchExerciseWeights([{ id: exerciseId, current_weight: value }]);
    void db.saveExerciseBaseline(exerciseId, value).catch((err) => {
      console.error('baseline save failed', err);
      void loadData({ preserveSession: true });
    });
  }

  function patchExerciseWeights(
    updates: Array<{ id: string; current_weight: number | null }>,
  ) {
    if (!updates.length) return;
    const byId = new Map(updates.map((row) => [row.id, row.current_weight]));
    exerciseLibrary = exerciseLibrary.map((ex) =>
      byId.has(ex.id) ? { ...ex, current_weight: byId.get(ex.id) ?? ex.current_weight } : ex,
    );
    templates = templates.map((tpl) => ({
      ...tpl,
      exercises: tpl.exercises.map((ex) =>
        byId.has(ex.id) ? { ...ex, current_weight: byId.get(ex.id) ?? ex.current_weight } : ex,
      ),
    }));
    if (activeTemplate) {
      activeTemplate = {
        ...activeTemplate,
        exercises: activeTemplate.exercises.map((ex) =>
          byId.has(ex.id) ? { ...ex, current_weight: byId.get(ex.id) ?? ex.current_weight } : ex,
        ),
      };
    }
    if (activeWorkoutTemplate) {
      activeWorkoutTemplate = {
        ...activeWorkoutTemplate,
        exercises: activeWorkoutTemplate.exercises.map((ex) =>
          byId.has(ex.id) ? { ...ex, current_weight: byId.get(ex.id) ?? ex.current_weight } : ex,
        ),
      };
    }
  }

  function scheduleWorkoutProgressSave() {
    if (workoutState !== 'active' || !isViewingToday) return;
    writeActiveSessionBackup();
    void persistWorkoutProgressNow();
  }

  async function persistWorkoutProgressNow() {
    if (
      workoutState !== 'active' ||
      !isViewingToday ||
      finishSyncPending
    ) {
      return;
    }
    if (workoutProgressSaveInFlight) {
      workoutProgressSavePending = true;
      return;
    }

    const saveGen = workoutProgressSaveGen;
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
      const refreshed = await db.saveWorkoutProgress(template, perf, workoutDuration, startedAt);
      if (
        saveGen !== workoutProgressSaveGen ||
        workoutState !== 'active' ||
        finishSyncPending ||
        !refreshed
      ) {
        return;
      }
      applyWorkoutLogLocally(refreshed, REAL_TODAY_STR);
    } catch (err) {
      console.error('workout progress save failed', err);
    } finally {
      workoutProgressSaveInFlight = false;
      if (workoutProgressSavePending) {
        workoutProgressSavePending = false;
        void persistWorkoutProgressNow();
      }
    }
  }

  function flushWorkoutProgressSave() {
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
    editingAccountName = false;
    accountNameEditValue = '';
    stopSignOutHold();
    stopDeleteAccountHold();
    showSettingsPanel = true;
    void refreshSupabaseUsage();
  }

  function closeSettingsPanel() {
    if (accountBusy) return;
    resetSettingsPanelUi();
  }

  function statLogsFromSnapshots(rows: StatLogSnapshotRow[]): Record<string, Record<string, number>> {
    const map: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      if (!map[row.stat_id]) map[row.stat_id] = {};
      map[row.stat_id][row.log_date] = row.value;
    }
    return map;
  }

  function statSnapshotMeta(statId: string): { name: string; unit: string } {
    const active = trackedStats.find((s) => s.id === statId);
    if (active) return { name: active.name, unit: active.unit };
    const snap = statLogSnapshots.find((r) => r.stat_id === statId);
    return { name: snap?.name ?? 'STAT', unit: snap?.unit ?? '' };
  }

  function upsertLocalStatLogSnapshot(
    statId: string,
    logDate: string,
    value: number,
    name: string,
    unit: string,
  ) {
    const idx = statLogSnapshots.findIndex(
      (r) => r.stat_id === statId && r.log_date === logDate,
    );
    if (idx >= 0) {
      statLogSnapshots = statLogSnapshots.map((r, i) =>
        i === idx ? { ...r, value, name, unit } : r,
      );
    } else {
      statLogSnapshots = [
        ...statLogSnapshots,
        { stat_id: statId, log_date: logDate, value, name, unit },
      ];
    }
  }

  function removeLocalStatLogSnapshot(statId: string, logDate: string) {
    statLogSnapshots = statLogSnapshots.filter(
      (r) => !(r.stat_id === statId && r.log_date === logDate),
    );
  }

  let statHistoryGroups = $derived.by(() => {
    const activeById = new Map(trackedStats.map((s) => [s.id, s]));
    const groups = new Map<
      string,
      {
        statId: string;
        name: string;
        unit: string;
        isActive: boolean;
        entries: Array<{ date: string; value: number }>;
      }
    >();

    for (const row of statLogSnapshots) {
      if (row.log_date === REAL_TODAY_STR) continue;
      let group = groups.get(row.stat_id);
      if (!group) {
        const active = activeById.get(row.stat_id);
        group = {
          statId: row.stat_id,
          name: active?.name ?? row.name,
          unit: active?.unit ?? row.unit,
          isActive: !!active,
          entries: [],
        };
        groups.set(row.stat_id, group);
      }
      group.entries.push({ date: row.log_date, value: row.value });
    }

    return [...groups.values()]
      .map((g) => ({
        ...g,
        entries: g.entries.sort((a, b) => b.date.localeCompare(a.date)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  function enterStatsView() {
    if (!isViewingToday) return;
    currentView = 'stats';
  }

  function exitStatsView() {
    currentView = 'track';
  }

  function draftStatById(id: string) {
    return draftStats.find((s) => s.id === id) ?? null;
  }

  function openStatsEditor() {
    draftStats = trackedStats.map((s, i) => ({ ...toTrackedStat(s, i) }));
    selectedDraftStatId = draftStats.length > 0 ? draftStats[0].id : null;
    editingStatNameId = null;
    statSaveError = null;
    currentView = 'edit_stats';
  }

  function exitStatsEditor() {
    if (editorExitSaving) return;
    editorExitSaving = true;
    trackedStats = draftStats.map((s) => ({ ...s }));
    currentView = 'stats';
    statSaveError = null;
    void runDbActivityBatch(persistTrackedStatsNow).finally(() => {
      editorExitSaving = false;
    });
  }

  function selectDraftStat(id: string | null) {
    if (id !== editingStatNameId) editingStatNameId = null;
    selectedDraftStatId = id;
  }

  function beginStatNameEdit(id: string) {
    selectDraftStat(id);
    editingStatNameId = id;
  }

  function endStatNameEdit() {
    editingStatNameId = null;
    void persistTrackedStatsNow();
  }

  function patchDraftStat(id: string, patch: Partial<TrackedStat>) {
    draftStats = draftStats.map((s) => (s.id === id ? { ...s, ...patch } : s));
  }

  function addNewStat() {
    if (draftStats.length >= MAX_STATS) {
      statSaveError = `You can track at most ${MAX_STATS} stats.`;
      return;
    }
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    draftStats = [
      ...draftStats,
      {
        id: tempId,
        user_id: currentUser?.id ?? '',
        name: 'NEW STAT',
        unit: '',
        display_order: draftStats.length,
        start_value: 0,
        has_target: false,
        target_value: null,
      },
    ];
    selectDraftStat(tempId);
    void persistTrackedStatsNow();
  }

  function deleteSelectedStat() {
    if (!selectedDraftStatId) return;
    const id = selectedDraftStatId;
    draftStats = draftStats.filter((s) => s.id !== id);
    selectedDraftStatId = draftStats.length > 0 ? draftStats[draftStats.length - 1].id : null;
    editingStatNameId = null;
    void persistTrackedStatsNow();
  }

  async function persistTrackedStatsNow() {
    if (statDraftSaveInFlight) return;

    const snapStats = draftStats.map((s, i) => {
      const copy = { ...s };
      normalizeDraftStat(copy);
      copy.display_order = i;
      return copy;
    });
    const validationErr = validateDraftStats(snapStats);
    if (validationErr) {
      statSaveError = validationErr;
      return;
    }

    statDraftSaveInFlight = true;
    try {
      const saved = await db.saveTrackedStats(snapStats);
      const prevDraft = draftStats;
      const prevSelected = selectedDraftStatId;
      draftStats = saved.map((s) => ({ ...s }));
      trackedStats = draftStats.map((s) => ({ ...s }));
      const nextSelected = prevDraft.findIndex((s) => s.id === prevSelected);
      if (nextSelected >= 0 && saved[nextSelected]) {
        selectedDraftStatId = saved[nextSelected].id;
      } else if (prevSelected && saved.some((s) => s.id === prevSelected)) {
        selectedDraftStatId = prevSelected;
      } else {
        selectedDraftStatId = saved[0]?.id ?? null;
      }
      statSaveError = null;
    } catch (err) {
      console.error('stat save failed', err);
      statSaveError =
        err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
          ? err.message
          : 'Could not save stats. Try again.';
    } finally {
      statDraftSaveInFlight = false;
    }
  }

  function handleStatDragStart(e: DragEvent, index: number) {
    statDraggedIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index.toString());
    }
  }

  function handleStatDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  function handleStatDrop(e: DragEvent, targetIndex: number) {
    e.preventDefault();
    if (statDraggedIndex === null || statDraggedIndex === targetIndex) {
      statDraggedIndex = null;
      return;
    }
    const arr = [...draftStats];
    const [moved] = arr.splice(statDraggedIndex, 1);
    arr.splice(targetIndex, 0, moved);
    draftStats = arr;
    statDraggedIndex = null;
    void persistTrackedStatsNow();
  }

  function handleStatDragEnd() {
    const wasDragging = statDraggedIndex !== null;
    statDraggedIndex = null;
    if (wasDragging) {
      statRowDragged = true;
      setTimeout(() => {
        statRowDragged = false;
      }, 100);
    }
  }

  function getStatTodayInputValue(statId: string): number {
    return statLogs[statId]?.[REAL_TODAY_STR] ?? 0;
  }

  function setStatTodayInputDraft(statId: string, value: number) {
    const logDate = REAL_TODAY_STR;
    const prev = statLogs[statId] ?? {};
    if (value <= 0) {
      if (prev[logDate] === undefined) return;
      const next = { ...prev };
      delete next[logDate];
      statLogs = { ...statLogs, [statId]: next };
      return;
    }
    statLogs = {
      ...statLogs,
      [statId]: { ...prev, [logDate]: value },
    };
  }

  function persistStatLogEntry(statId: string, logDate: string, raw: number) {
    const value = sanitizeStatLogValue(raw);
    const prev = statLogs[statId] ?? {};
    const prevValue = prev[logDate];
    const prevSnap = statLogSnapshots.find(
      (r) => r.stat_id === statId && r.log_date === logDate,
    );
    const meta = statSnapshotMeta(statId);

    if (value == null) {
      if (prevValue === undefined) return;
      const next = { ...prev };
      delete next[logDate];
      statLogs = { ...statLogs, [statId]: next };
      removeLocalStatLogSnapshot(statId, logDate);
      void db.deleteStatLog(statId, logDate).catch((e) => {
        console.error(e);
        const rollback = { ...(statLogs[statId] ?? {}) };
        if (prevValue !== undefined) rollback[logDate] = prevValue;
        statLogs = { ...statLogs, [statId]: rollback };
        if (prevSnap) {
          upsertLocalStatLogSnapshot(
            statId,
            logDate,
            prevSnap.value,
            prevSnap.name,
            prevSnap.unit,
          );
        }
      });
      return;
    }

    statLogs = {
      ...statLogs,
      [statId]: { ...prev, [logDate]: value },
    };
    upsertLocalStatLogSnapshot(statId, logDate, value, meta.name, meta.unit);
    void db.saveStatLog(statId, logDate, value).catch((e) => {
      console.error(e);
      const rollback = { ...(statLogs[statId] ?? {}) };
      if (prevValue === undefined) delete rollback[logDate];
      else rollback[logDate] = prevValue;
      statLogs = { ...statLogs, [statId]: rollback };
      if (prevSnap) {
        upsertLocalStatLogSnapshot(
          statId,
          logDate,
          prevSnap.value,
          prevSnap.name,
          prevSnap.unit,
        );
      } else {
        removeLocalStatLogSnapshot(statId, logDate);
      }
    });
  }

  function persistStatTodayLog(statId: string) {
    persistStatLogEntry(statId, REAL_TODAY_STR, getStatTodayInputValue(statId));
  }

  function deleteStatLogEntry(statId: string, logDate: string) {
    persistStatLogEntry(statId, logDate, 0);
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
    // Only poll health aggressively after we have a user (avoids 401 spam while unauthenticated).
    // The initial preload still happens.
    supabaseHealthPollTimer = setInterval(() => {
      if (currentUser) void refreshSupabaseHealth();
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
			const [data, recentLogs, stats, snapshots] = await Promise.all([
				db.getAppData(),
				db.getRecentHistory(21).catch((e) => {
					console.error('Recent history fetch failed', e);
					return [] as WorkoutHistory[];
				}),
				db.getTrackedStats().catch(() => [] as TrackedStat[]),
				db.getStatLogSnapshots(90).catch(() => [] as StatLogSnapshotRow[]),
			]);
			schedule = data.schedule;
			templates = data.templates;
			exerciseLibrary = data.exerciseLibrary ?? [];
			deletedLibraryExerciseIds = new Set(); // server state is now authoritative
			todayLog = data.todayLog || null;
			trackedStats = stats;
			statLogSnapshots = snapshots;
			statLogs = statLogsFromSnapshots(snapshots);
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
          exerciseLibrary = [];
          deletedLibraryExerciseIds = new Set();
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
    void flushTemplateNamePersist();
    if (templateNamePersistTimer) {
      clearTimeout(templateNamePersistTimer);
      templateNamePersistTimer = null;
    }
    void persistTemplateExercisesNow();
    flushWorkoutProgressSave();
    if (dbIoFlashTimer) clearTimeout(dbIoFlashTimer);
    clearInterval(workoutTimer);
    clearInterval(countdownTimer);
    clearInterval(visualUpdateTimer);
    timerStartTimestamp = null;
    currentVisualDot = 0;
    visualMsPerDot = 0;
    visualRawStep = 0;
    visualRawStep = 0;
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
    clearInterval(visualUpdateTimer);
    activeTimerExerciseId = null;
    activeTimerSetIndex = null;
    countdownSeconds = 0;
    countdownRunning = false;
    timerStartTimestamp = null;
    currentVisualDot = 0;
    visualMsPerDot = 0;
    visualRawStep = 0;
    visualRawStep = 0;
    skipProgress = 0;
    cancelProgress = 0;
    deleteTemplateProgress = 0;
    eraseProgress = 0;
    justFinishedStatus = null;
    workoutTimer = setInterval(() => { workoutDuration++; }, 1000);
    beginHeaderTimerFadeIn();
    writeActiveSessionBackup();
    void persistWorkoutProgressNow();
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
    workoutProgressSavePending = false;
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
    clearInterval(visualUpdateTimer);
    countdownSeconds = 0;
    countdownRunning = false;
    activeTimerExerciseId = null;
    activeTimerSetIndex = null;
    timerStartTimestamp = null;
    currentVisualDot = 0;
    visualMsPerDot = 0;
    visualRawStep = 0;
    visualRawStep = 0;
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
    const rollbackBackup: ActiveSessionBackup = {
      date: REAL_TODAY_STR,
      templateId: template.id,
      templateName: template.name,
      trackedReps: snapshot.reps,
      completedTimers: snapshot.times,
      workoutStartedAt: workoutStartedAt ?? Date.now() - elapsed * 1000,
      ongoingTimer: ongoingTimerBackupFromState(),
    };

    justFinishedStatus = justFinished;
    workoutProgressSavePending = false;
    workoutProgressSaveGen++;
    finishSyncPending = true;
    clearActiveSessionBackup();
    activeWorkoutTemplate = null;
    workoutState = 'done';

    void syncWorkoutFinish(template, snapshot, duration, rollbackBackup);
  }

  async function syncWorkoutFinish(
    template: Template,
    snapshot: { reps: Record<string, number>; times: Record<string, { result: string; met: boolean }> },
    duration: number,
    rollbackBackup: ActiveSessionBackup,
  ) {
    const opGen = workoutProgressSaveGen;
    let succeeded = false;
    try {
      const result = await db.submitWorkoutSession(template, snapshot, duration);
      if (opGen !== workoutProgressSaveGen) {
        await db.deleteWorkoutLog().catch((err) => console.error('finish undo after erase failed', err));
        return;
      }
      applyWorkoutLogLocally(result.workout, REAL_TODAY_STR);
      patchExerciseWeights(result.updatedExercises);
      if (opGen !== workoutProgressSaveGen) return;
      succeeded = true;
    } catch (err) {
      if (opGen !== workoutProgressSaveGen) return;
      console.error('finish workout failed', err);
      workoutActionError = formatDbError(err);
      if (applyActiveSessionBackup(rollbackBackup)) {
        writeActiveSessionBackup();
      } else {
        workoutState = 'active';
        activeWorkoutTemplate = template;
        trackedReps = { ...snapshot.reps };
        completedTimers = { ...snapshot.times };
        restoreWorkoutTimerFromLog({
          performance_snapshot: {
            started_at: rollbackBackup.workoutStartedAt,
            duration_seconds: 0,
          },
        });
        headerTimerInDom = true;
        headerTimerOpaque = true;
        if (rollbackBackup.ongoingTimer) {
          restoreOngoingExerciseTimer(rollbackBackup.ongoingTimer, template);
        }
        writeActiveSessionBackup();
      }
    } finally {
      if (opGen !== workoutProgressSaveGen) {
        finishSyncPending = false;
        justFinishedStatus = null;
        return;
      }
      finishSyncPending = false;
      justFinishedStatus = null;
      if (succeeded) {
        const fromLog = durationSecondsFromLog(todayLog);
        if (fromLog > 0) workoutDuration = fromLog;
        finishedHeaderDuration = 0;
        clearActiveSessionBackup();
      }
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

  function startExerciseCountdownInterval() {
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      countdownSeconds++;
    }, 1000);
  }

  function startExerciseVisualInterval() {
    clearInterval(visualUpdateTimer);
    visualUpdateTimer = setInterval(() => {
      if (timerStartTimestamp !== null && countdownRunning && visualMsPerDot > 0) {
        const elapsed = Date.now() - timerStartTimestamp;
        const newStep = Math.floor(elapsed / visualMsPerDot);
        if (newStep !== visualRawStep) {
          visualRawStep = newStep;
        }
      }
    }, 30);
  }

  function configureExerciseVisualTimer(exerciseId: string) {
    const template = activeWorkoutTemplate ?? activeTemplate;
    const ex = template?.exercises?.find((e) => e.id === exerciseId);
    const target = ex ? (ex.target_minutes || 0) * 60 + (ex.target_seconds || 0) : 0;
    visualMsPerDot = target > 0 ? (target * 1000) / visualDotCount : 0;
  }

  function restoreOngoingExerciseTimer(
    timer: OngoingTimerBackup,
    template: Template | null,
  ) {
    const ex = template?.exercises?.find((e) => e.id === timer.exerciseId);
    if (!ex || ex.exercise_type !== 'time') return;

    clearInterval(countdownTimer);
    clearInterval(visualUpdateTimer);

    activeTimerExerciseId = timer.exerciseId;
    activeTimerSetIndex = timer.setIndex;
    countdownRunning = timer.countdownRunning;
    configureExerciseVisualTimer(timer.exerciseId);

    if (timer.countdownRunning && timer.timerStartTimestamp != null) {
      timerStartTimestamp = timer.timerStartTimestamp;
      const elapsedMs = Date.now() - timerStartTimestamp;
      countdownSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
      visualRawStep =
        visualMsPerDot > 0 ? Math.floor(elapsedMs / visualMsPerDot) : 0;
      currentVisualDot = visualRawStep;
      startExerciseCountdownInterval();
      startExerciseVisualInterval();
    } else {
      timerStartTimestamp = null;
      countdownSeconds = timer.countdownSeconds;
      visualRawStep =
        visualMsPerDot > 0
          ? Math.floor((countdownSeconds * 1000) / visualMsPerDot)
          : 0;
      currentVisualDot = visualRawStep;
    }
  }

  function startTimedSet(exerciseId: string, setIndex: number) {
    clearInterval(countdownTimer);
    clearInterval(visualUpdateTimer);
    activeTimerExerciseId = exerciseId;
    activeTimerSetIndex = setIndex;
    countdownSeconds = 0;
    countdownRunning = true;
    timerStartTimestamp = Date.now();
    configureExerciseVisualTimer(exerciseId);
    visualRawStep = 0;
    currentVisualDot = 0;
    startExerciseCountdownInterval();
    startExerciseVisualInterval();
    writeActiveSessionBackup();
  }

  function toggleExerciseTimer() {
    if (countdownRunning) {
      clearInterval(countdownTimer);
      clearInterval(visualUpdateTimer);
      countdownRunning = false;
    } else {
      countdownRunning = true;
      timerStartTimestamp = Date.now() - countdownSeconds * 1000;
      startExerciseCountdownInterval();
      startExerciseVisualInterval();
    }
    writeActiveSessionBackup();
  }

  function stopAndSaveTimedSet(exerciseId: string, setIndex: number, targetSeconds: number) {
    clearInterval(countdownTimer);
    clearInterval(visualUpdateTimer);
    countdownRunning = false;
    const key = `${exerciseId}-${setIndex}`;
    completedTimers = {
      ...completedTimers,
      [key]: {
        result: formatTime(countdownSeconds),
        met: countdownSeconds >= targetSeconds,
      },
    };
    activeTimerExerciseId = null;
    activeTimerSetIndex = null;
    countdownSeconds = 0;
    timerStartTimestamp = null;
    currentVisualDot = 0;
    visualMsPerDot = 0;
    visualRawStep = 0;
    visualRawStep = 0;
    visualRawStep = 0;
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
    clearInterval(visualUpdateTimer);
    countdownRunning = false;
    activeTimerExerciseId = null;
    activeTimerSetIndex = null;
    countdownSeconds = 0;
    timerStartTimestamp = null;
    currentVisualDot = 0;
    visualMsPerDot = 0;
    visualRawStep = 0;
    visualRawStep = 0;
    writeActiveSessionBackup();
  }

  async function syncSkipWorkout() {
    const opGen = workoutProgressSaveGen;
    try {
      workoutActionError = null;
      const log = await db.skipWorkout(activeTemplate?.id || null, activeTemplate?.name || null);
      if (opGen !== workoutProgressSaveGen) {
        await db.deleteWorkoutLog().catch((err) => console.error('skip undo after erase failed', err));
        return;
      }
      applyWorkoutLogLocally(log, REAL_TODAY_STR);
      if (opGen !== workoutProgressSaveGen) return;
      if (logIsSkipped(todayLog)) {
        workoutState = 'skipped';
      }
    } catch (err) {
      if (opGen !== workoutProgressSaveGen) return;
      console.error('skip workout failed', err);
      workoutActionError = formatDbError(err);
      workoutState = 'idle';
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
    workoutProgressSavePending = false;
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
    const dateKey = selectedDateStr;
    const rollback = {
      log: weekLogs[dateKey] ?? null,
      workoutState,
      activeWorkoutTemplate,
      trackedReps,
      completedTimers,
    };
    applyEraseLocalReset();
    workoutState = 'idle';
    void eraseWorkoutLog({ localAlreadyApplied: true, rollback });
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
        deleteTemplateHoldTimer = null;
        deleteTemplateProgress = 0;
        const returnView = templateEditorReturnView;
        templateEditorReturnView = 'track';
        void flushTemplateNamePersist();
        editingTemplateId = '';
        draftExercises = [];
        draftTemplateName = '';
        currentView = returnView;
        if (!templateId.startsWith('temp-')) {
          const deletedId = templateId;
          templates = templates.filter((t) => t.id !== deletedId);
          void clearTemplateFromAllDays(deletedId);
          void db.deleteTemplate(deletedId).catch((err) => {
            console.error('Delete template failed', err);
            templateSaveError = formatDbError(err);
            void loadData({ preserveSession: true });
          });
        }
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

  async function eraseWorkoutLog(
    options: {
      localAlreadyApplied?: boolean;
      rollback?: {
        log: WorkoutHistory | null;
        workoutState: typeof workoutState;
        activeWorkoutTemplate: Template | null;
        trackedReps: Record<string, number>;
        completedTimers: Record<string, { result: string; met: boolean }>;
      };
    } = {},
  ) {
    const dateKey = selectedDateStr;
    const opGen = workoutProgressSaveGen;
    stopEraseHold();
    stopSkipHold();
    const rollback = options.rollback ?? {
      log: weekLogs[dateKey] ?? null,
      workoutState,
      activeWorkoutTemplate,
      trackedReps,
      completedTimers,
    };
    if (!options.localAlreadyApplied) {
      applyEraseLocalReset();
      if (isViewingToday) {
        workoutState = 'idle';
      }
    }
    try {
      workoutActionError = null;
      await db.deleteWorkoutLog(isViewingToday ? undefined : dateKey);
      if (opGen !== workoutProgressSaveGen) return;
    } catch (err) {
      if (opGen !== workoutProgressSaveGen) return;
      console.error('erase workout failed', err);
      workoutActionError = 'Could not erase workout log.';
      applyWorkoutLogLocally(rollback.log, dateKey);
      if (isViewingToday) {
        workoutState = rollback.workoutState;
        activeWorkoutTemplate = rollback.activeWorkoutTemplate;
        trackedReps = rollback.trackedReps;
        completedTimers = rollback.completedTimers;
      }
    }
  }

  async function clearTemplateFromAllDays(templateId: string) {
    const affected = schedule.filter((s) => s.template_id === templateId);
    if (!affected.length) return;
    const patches = affected.map((s) => ({ dayOfWeek: s.day_of_week, templateId: null as string | null }));
    for (const row of affected) {
      applyLocalScheduleAssignment(row.day_of_week, null);
    }
    const nextAssignments = { ...builderAssignments };
    for (let i = 0; i < 7; i++) {
      if (nextAssignments[i] === templateId) nextAssignments[i] = null;
    }
    builderAssignments = nextAssignments;
    try {
      await db.assignTemplatesToDays(patches);
    } catch (e) {
      console.error('clear template from schedule failed', e);
      void loadData({ preserveSession: true });
    }
  }

  function applyLocalScheduleAssignment(dayOfWeek: number, templateId: string | null) {
    const uid = currentUser?.id;
    if (!uid) return;
    templateId = effectiveAssignmentTemplateId(templateId);
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

  async function saveRoutineEditorDraft() {
    if (editingRoutineTemplateNameId) {
      const pending = templates.find((t) => t.id === editingRoutineTemplateNameId);
      if (pending) {
        const trimmed = sanitizeTemplateName((pending.name ?? '').trim()) || 'NEW TEMPLATE';
        pending.name = trimmed;
        await persistTemplateNameById(pending.id, trimmed);
      }
      editingRoutineTemplateNameId = null;
      routineTemplateNameEditOriginal = null;
    }
    await flushTemplateNamePersist();
  }

  function exitRoutineEditor() {
    if (editorExitSaving) return;
    editorExitSaving = true;
    currentView = 'track';
    builderAssignments = {};
    builderEditingDay = 0;
    editingRoutineTemplateNameId = null;
    routineTemplateNameEditOriginal = null;
    if (templateErrorClearTimer) {
      clearTimeout(templateErrorClearTimer);
      templateErrorClearTimer = null;
    }
    templateErrorFading = false;
    templateError = null;
    void runDbActivityBatch(saveRoutineEditorDraft).finally(() => {
      editorExitSaving = false;
    });
  }

  async function persistBuilderDayAssignment(templateId: string | null) {
    const dayOfWeek = builderEditingDay;
    let resolvedId = templateId;
    if (templateId?.startsWith('temp-')) {
      const pending = routineEditorPendingCreates.get(dayOfWeek);
      if (pending) {
        try {
          resolvedId = await pending;
        } catch {
          return;
        }
      } else {
        return;
      }
    }
    const effectiveId = effectiveAssignmentTemplateId(resolvedId);
    const priorRow = schedule.find((s) => s.day_of_week === dayOfWeek);
    const priorEffective = effectiveAssignmentTemplateId(priorRow?.template_id ?? null);
    if (effectiveId === priorEffective) return;

    applyLocalScheduleAssignment(dayOfWeek, effectiveId);
    void db.assignTemplatesToDays([{ dayOfWeek, templateId: effectiveId }]).catch((e) => {
      console.error('Day assignment save failed', e);
      templateError = formatDbError(e);
      templateErrorFading = false;
      applyLocalScheduleAssignment(dayOfWeek, priorEffective);
    });
  }

  async function handleCreateTemplate(defaultName?: string, openAfterCreate = true) {
    let name = sanitizeTemplateName((defaultName ?? newTemplateName).trim());
    if (!name) {
      name = 'NEW TEMPLATE';
    }

    const wd =
      (currentView === 'swap_template' ? builderEditingDay : selectedWeekday) ?? 0;

    if (currentView === 'swap_template') {
      if (!currentUser) {
        templateError = 'Not signed in';
        templateErrorFading = false;
        return;
      }
      const uid = currentUser.id;
      templateError = null;
      templateErrorFading = false;

      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const nextOrder = templates.length;
      const optimistic: Template = { id: tempId, user_id: uid, name, color: 0, display_order: nextOrder, exercises: [] };
      templates = [...templates, optimistic];
      newTemplateName = '';
      if (openAfterCreate) {
        openTemplateEditor(tempId);
      }

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
          templates = templates.map((t) => (t.id === tempId ? template : t));

          // Update any builder assignments that were pointing to the old temp ID
          // so selection/assignment "sticks" immediately after optimistic creation
          let assignmentsUpdated = false;
          const newAssignments = { ...builderAssignments };
          for (const [dayStr, tid] of Object.entries(builderAssignments)) {
            if (tid === tempId) {
              newAssignments[Number(dayStr)] = template.id;
              assignmentsUpdated = true;
            }
          }
          if (assignmentsUpdated) {
            builderAssignments = newAssignments;
          }

          if (openAfterCreate && editingTemplateId === tempId) {
            editingTemplateId = template.id;
            if (draftExercises.length > 0) {
              void persistTemplateExercisesNow();
            }
          }
          return template.id;
        } catch (e) {
          console.error('Create template failed', e);
          templates = templates.filter((t) => t.id !== tempId);

          // clean up assignments pointing to the failed temp
          const cleaned = { ...builderAssignments };
          let changed = false;
          for (const day in cleaned) {
            if (cleaned[day] === tempId) {
              cleaned[Number(day)] = null;
              changed = true;
            }
          }
          if (changed) builderAssignments = cleaned;

          if (openAfterCreate && editingTemplateId === tempId) {
            currentView = 'swap_template';
            editingTemplateId = '';
            draftExercises = [];
          }
          templateError = formatDbError(e);
          templateErrorFading = false;
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
      templateErrorFading = false;
      return;
    }
    currentUser = user;

    templateError = null;
    templateErrorFading = false;
    isCreatingTemplate = true;
    try {
      const template = await db.createTemplate(name);
      if (!template) {
        templateError = 'Could not create template.';
        templateErrorFading = false;
        return;
      }

      templates = [...templates, template];

      newTemplateName = '';

      const rep = new Date(REAL_TODAY);
      rep.setDate(rep.getDate() - rep.getDay() + wd);
      selectedDate = rep;
      if (openAfterCreate) {
        openTemplateEditor(template.id);
      }
    } catch (e) {
      console.error('Create template failed', e);
      templateError = formatDbError(e);
      templateErrorFading = false;
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

  function finishChangePasswordFeedbackExit() {
    if (changePasswordFeedbackExitTimer) {
      clearTimeout(changePasswordFeedbackExitTimer);
      changePasswordFeedbackExitTimer = null;
    }
    changePasswordError = null;
    changePasswordSuccess = null;
    changePasswordFeedbackExiting = false;
    changePasswordFeedbackEntering = false;
  }

  async function setChangePasswordError(message: string | null) {
    finishChangePasswordFeedbackExit();
    changePasswordError = message;
    if (message) {
      changePasswordSuccess = null;
      changePasswordFeedbackEntering = true;
      await tick();
      changePasswordFeedbackEntering = false;
    }
  }

  async function setChangePasswordSuccess(message: string | null) {
    finishChangePasswordFeedbackExit();
    changePasswordSuccess = message;
    if (message) {
      changePasswordError = null;
      changePasswordFeedbackEntering = true;
      await tick();
      changePasswordFeedbackEntering = false;
    }
  }

  async function clearChangePasswordFeedback() {
    if (!changePasswordError && !changePasswordSuccess) return;
    if (changePasswordFeedbackExiting) return;
    changePasswordFeedbackExiting = true;
    await tick();
    changePasswordFeedbackExitTimer = setTimeout(
      finishChangePasswordFeedbackExit,
      AUTH_FEEDBACK_CROSSFADE_MS + 20,
    );
  }

  function onChangePasswordCrossfadeTransitionEnd(e: TransitionEvent) {
    if (e.propertyName !== 'opacity' || !changePasswordFeedbackExiting) return;
    finishChangePasswordFeedbackExit();
  }

  function resetChangePasswordForm() {
    showChangePasswordForm = false;
    changePasswordNew = '';
    changePasswordConfirm = '';
    finishChangePasswordFeedbackExit();
  }

  function toggleChangePasswordForm() {
    if (accountBusy) return;
    if (showChangePasswordForm) {
      resetChangePasswordForm();
      return;
    }
    finishChangePasswordFeedbackExit();
    showChangePasswordForm = true;
  }

  /** Closes panel and resets hold UI; safe to call during sign-out / auth changes. */
  function resetSettingsPanelUi() {
    showSettingsPanel = false;
    editingAccountName = false;
    accountNameEditValue = '';
    stopSignOutHold();
    stopDeleteAccountHold();
    holdCautionDisplayKind = null;
    holdCautionMorphFade = true;
    resetChangePasswordForm();
    accountError = null;
  }

  // --- Self-update flow (matches account menu UX: centered dialog + blur backdrop) ---

  function closeUpdatePrompt() {
    if (updateInstalling) return; // unclosable while downloading/installing
    if (updateInfo) {
      dismissUpdateThisLaunch(updateInfo.version);
    }
    showUpdatePrompt = false;
    // keep info around briefly in case of quick re-trigger; cleared on next check
  }

  function resetUpdateUi() {
    showUpdatePrompt = false;
    updateInfo = null;
    updateDownloadProgress = 0;
    updateInstalling = false;
    updateError = null;
    downloadedApkPath = null;
  }

  async function startUpdateInstall() {
    if (!updateInfo) return;
    // Block only while a non-error "in progress" (e.g. actively downloading).
    // If we have a permission error (updateError set) we *want* to allow re-tapping INSTALL
    // to retry just the installApk step (after user returns from settings).
    if (updateInstalling && !updateError) return;

    updateError = null;
    updateInstalling = true;
    if (!downloadedApkPath) {
      updateDownloadProgress = 0;
    }

    if (!isNativeApp()) {
      // Website / browser demo path: trigger a real file download using
      // a temporary <a> element. This avoids CORS problems with fetch()
      // on GitHub asset URLs. The browser will handle the download.
      try {
        const link = document.createElement('a');
        link.href = updateInfo.downloadUrl;
        link.download = `lift-tracker-v${updateInfo.version}.apk`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // fake cool delay to start the "download" a bit late
        await new Promise(r => setTimeout(r, 750));

        updateDownloadProgress = 0;

        // play the progress
        for (let p = 0; p <= 100; p += 5) {
          updateDownloadProgress = p;
          await new Promise(r => setTimeout(r, 70));
        }

        // stop instantly at 100%
        updateDownloadProgress = 100;

        setTimeout(() => {
          updateInstalling = false;
          downloadedApkPath = null;
        }, 150);  // tiny pause so UI shows 100% briefly before hiding
      } catch (e: any) {
        updateError = 'Could not start download. Please visit the releases page manually.';
        updateInstalling = false;
        downloadedApkPath = null;
      }
      return;
    }

    // === Pre-flight permission check (the key improvement) ===
    // We check *before* downloading so the user never wastes bandwidth on an APK
    // they can't install yet. If the permission is missing we send them to settings
    // immediately and keep the dialog in the "installing" (unclosable) state with
    // guidance. When they return and tap INSTALL again we re-check and only then
    // start the real download.
    try {
      // The method may not exist if running against an old native plugin build.
      // Guard + try/catch so we degrade gracefully (the final installApk still enforces).
      const canInstallFn = (UpdaterNative as any).canInstallFromUnknownSources;
      let canInstall = true;
      if (typeof canInstallFn === 'function') {
        const res = await canInstallFn();
        canInstall = !!res?.canInstall;
      }
      if (!canInstall) {
        updateError = 'Lift Tracker needs permission to install updates from unknown sources.';
        updateInstalling = true;
        updateDownloadProgress = 0;
        downloadedApkPath = null;
        try {
          await openInstallPermissionSettings();
        } catch {}
        return;
      }
    } catch (permErr) {
      // If the check call itself fails (very old plugin, etc.) we fall through.
      // The final installApk still enforces the permission as a safety net.
      console.warn('[updater] permission pre-check failed, will let installApk enforce it', permErr);
    }

    // Permission OK at this moment.

    // If we already successfully downloaded on a previous attempt in this prompt
    // (edge case), just re-try the *install* handoff.
    if (downloadedApkPath) {
      try {
        await promptInstallApk(downloadedApkPath);
        // On success the OS package installer activity should appear and cover us.
        // Leave the dialog in the installing state (unclosable) briefly.
      } catch (e: any) {
        const msg = String(e?.message || e || 'Install failed');
        if (msg.includes('permission_required')) {
          // Should be rare now that we pre-check, but handle gracefully.
          updateError = 'Please allow "Install unknown apps" for Lift Tracker in the settings screen, then return here and tap INSTALL.';
          try {
            await openInstallPermissionSettings();
          } catch {}
        } else {
          updateError = msg;
          updateInstalling = false;
          downloadedApkPath = null;
        }
      }
      return;
    }

    // fake cool delay to start the download a bit late (for nice UX)
    await new Promise(r => setTimeout(r, 750));

    // Native Android path (real sideloaded APK flow) - full download + install.
    try {
      // Listen for progress from the native plugin (emitted during downloadUpdate)
      const progressListener = (data: { progress?: number }) => {
        if (data.progress != null) {
          updateDownloadProgress = Math.min(100, Math.max(0, data.progress));
        }
      };
      UpdaterNative.addListener('downloadProgress', progressListener);

      const result = await UpdaterNative.downloadUpdate({
        url: updateInfo.downloadUrl,  // use the direct browser download URL for the binary
        expectedSize: updateInfo.size || 0,
      });

      // Remember the path so that a later (very unexpected) permission error can be recovered.
      downloadedApkPath = result.path;

      // Remove listener (use removeAllListeners for safety if reference issue)
      try {
        UpdaterNative.removeListener('downloadProgress', progressListener);
      } catch {
        UpdaterNative.removeAllListeners('downloadProgress');
      }

      // Download done — stop instantly at 100%
      updateDownloadProgress = 100;

      // now really hand off to native installer.
      // The modal stays visible (unclosable) until the activity switch.
      await promptInstallApk(result.path);

      // If we reach here without exception, the intent was launched.
      // We leave the sheet up briefly; the OS installer will cover the screen.
      // On next fresh launch of the *new* version the post-update changelog will appear.
    } catch (e: any) {
      const msg = String(e?.message || e || 'Update failed');
      if (msg.includes('permission_required')) {
        // This can still happen in rare races (permission revoked between check and install).
        updateError = 'Please allow "Install unknown apps" for Lift Tracker in the settings screen, then return here and tap INSTALL.';
        // Proactively surface the OS settings.
        try {
          await openInstallPermissionSettings();
        } catch {}
        // Keep installing=true + downloadedApkPath (we may have partially downloaded) so user can retry.
      } else if (msg.toLowerCase().includes('parsing') || msg.toLowerCase().includes('corrupted') || msg.toLowerCase().includes('size mismatch')) {
        updateError = msg + ' Tap "Download manually from GitHub" below as a fallback.';
        updateInstalling = false;
        downloadedApkPath = null;
      } else {
        updateError = msg;
        // Allow the user to dismiss on error so they aren't stuck.
        updateInstalling = false;
        downloadedApkPath = null;
      }
    }
  }

  // One-time resume listener for a smoother permission flow:
  // After the user grants "Install unknown apps" in settings and returns to the app,
  // we automatically re-invoke startUpdateInstall(). Because we now do the permission
  // pre-check *before* downloading, this will start the download (and later the real
  // package installer) without the user having to tap the button a second time.
  if (isNativeApp()) {
    // Guard so we don't attach multiple listeners across HMR / re-renders.
    const w = (typeof window !== 'undefined' ? (window as any) : {}) as any;
    if (!w.__LIFT_UPDATER_RESUME_LISTENER) {
      w.__LIFT_UPDATER_RESUME_LISTENER = true;
      App.addListener('resume', () => {
        // Only auto-advance if we are visibly waiting for the unknown-sources permission
        // for the current update prompt (no download has started yet).
        if (
          showUpdatePrompt &&
          updateInstalling &&
          updateError &&
          /unknown|permission|Install unknown apps/i.test(updateError) &&
          !downloadedApkPath
        ) {
          // Small delay lets the activity / view settle after returning from settings.
          setTimeout(() => {
            if (showUpdatePrompt && updateInstalling && !downloadedApkPath) {
              void startUpdateInstall();
            }
          }, 220);
        }
      }).catch(() => {
        /* non-fatal */
      });
    }
  }

  function closePostUpdate() {
    showPostUpdate = false;
    // lastSeenVersion was already recorded by the check helper.
  }

  function openGitHubReleases() {
    const url = updateInfo?.tag
      ? `https://github.com/Kono-o/lift-tracker/releases/tag/${updateInfo.tag}`
      : 'https://github.com/Kono-o/lift-tracker/releases';
    if (typeof window !== 'undefined') {
      window.open(url, '_blank');
    }
  }

  /** Manually open the update menu (Ctrl+click the left side of the website footer for testing/demo).
   *  On native the real auto-check will handle it at the right time.
   *  On website, this attempts the real GitHub fetch so you see actual release data (or the failure reason).
   */
  async function manuallyOpenUpdateMenu() {
    try {
      const release = await fetchLatestRelease();
      const info = release ? releaseToUpdateInfo(release) : null;

      if (info) {
        // Use the real direct asset URL from GitHub. The web Install path
        // will use a <a download> click which works without CORS fetch.
        updateInfo = info;
      } else {
        updateInfo = {
          version: '1.0.2',
          notes: 'Demo of the update menu (triggered from the website footer).\n\nIn the real Android app this appears automatically after sign-in + data load when a newer GitHub release is detected.',
          downloadUrl: 'https://github.com/Kono-o/lift-tracker/releases/download/v1.0.2/lift-tracker-v1.0.2.apk',
          apiAssetUrl: 'https://github.com/Kono-o/lift-tracker/releases/download/v1.0.2/lift-tracker-v1.0.2.apk',
          size: 3620000,
          tag: 'v1.0.2'
        } as any;
      }
      updateDownloadProgress = 0;
      updateInstalling = false;
      updateError = null;
      downloadedApkPath = null;
      showUpdatePrompt = true;
    } catch (e) {
      console.error('[updater] manual open failed to fetch:', e);
      updateInfo = {
        version: '1.0.2',
        notes: 'Demo of the update menu (triggered from the website footer). Fetch failed — see console for details.',
        downloadUrl: 'https://github.com/Kono-o/lift-tracker/releases/download/v1.0.2/lift-tracker-v1.0.2.apk',
        apiAssetUrl: 'https://github.com/Kono-o/lift-tracker/releases/download/v1.0.2/lift-tracker-v1.0.2.apk',
        size: 3620000,
        tag: 'v1.0.2'
      } as any;
      updateDownloadProgress = 0;
      updateInstalling = false;
      updateError = null;
      downloadedApkPath = null;
      showUpdatePrompt = true;
    }
  }

  /** Manually open the post-update "what's new" menu (Ctrl+click the right side of the website footer for testing/demo).
   *  On native the real post-update check will handle it on first launch after an update.
   */
  function manuallyOpenPostUpdateMenu() {
    postUpdateVersion = APP_VERSION;
    postUpdateNotes = '- Full auto-update support for the sideloaded Android APK\n- Update check only after sign-in + data load + main menu visible\n- Centered blur update prompt (matches account/settings style)\n- "Install" is unclosable during download + shows real-time progress\n- Permission check for unknown sources happens *before* downloading\n- Reliable native download (HttpURLConnection + verification)\n- Post-update "what\'s new" changelog popup on first launch\n- Stable signing key across releases';
    showPostUpdate = true;
  }

  function beginAccountNameEdit() {
    if (!isUsernameAccount(currentUser) || accountBusy || editingAccountName) return;
    accountError = null;
    accountNameEditValue = getAuthDisplayName(currentUser);
    editingAccountName = true;
  }

  function cancelAccountNameEdit() {
    editingAccountName = false;
    accountNameEditValue = '';
  }

  async function commitAccountNameEdit() {
    if (!editingAccountName) return;
    const next = sanitizeUsernameInput(accountNameEditValue);
    const current = sanitizeUsernameInput(getAuthDisplayName(currentUser));
    if (!next || next === current) {
      cancelAccountNameEdit();
      return;
    }

    const validationErr = validateUsername(next);
    if (validationErr) {
      accountError = validationErr;
      cancelAccountNameEdit();
      return;
    }

    accountBusy = true;
    accountError = null;
    try {
      const user = await db.renameUsername(next);
      currentUser = user;
      cancelAccountNameEdit();
    } catch (e) {
      console.error('Rename username failed', e);
      accountError = formatAccountError(e);
      cancelAccountNameEdit();
    } finally {
      accountBusy = false;
    }
  }

  async function handleChangePassword() {
    if (
      accountBusy ||
      !accountCanChangePassword ||
      changePasswordFeedbackLit ||
      !changePasswordSubmitReady
    ) {
      return;
    }

    const passwordErr = validatePassword(changePasswordNew);
    if (passwordErr) {
      setChangePasswordError(passwordErr);
      return;
    }
    if (changePasswordNew !== changePasswordConfirm) {
      setChangePasswordError('Passwords do not match.');
      return;
    }

    accountBusy = true;
    finishChangePasswordFeedbackExit();
    await tick();
    try {
      await db.changePassword(changePasswordNew);
      changePasswordNew = '';
      changePasswordConfirm = '';
      setChangePasswordSuccess('Password updated.');
    } catch (e) {
      console.error('Change password failed', e);
      setChangePasswordError(formatAuthError(e));
    } finally {
      accountBusy = false;
    }
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
      exerciseLibrary = [];
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



  function undoRestLog(dateStr: string) {
    const prev = weekLogs[dateStr] ?? null;
    weekLogs = { ...weekLogs, [dateStr]: null };
    if (selectedDateStr === dateStr) {
      viewedLog = null;
    }
    void db.deleteLogForDate(dateStr).catch((err) => {
      console.error('undo rest log failed', err);
      weekLogs = { ...weekLogs, [dateStr]: prev };
      if (selectedDateStr === dateStr) {
        viewedLog = prev;
      }
    });
  }

  function createTemplateFromRoutineBuilder() {
    void handleCreateTemplate('New Template', false);
  }

  function assignTemplateToBuilderDay(templateId: string | null) {
    const priorEffective = effectiveAssignmentTemplateId(
      builderAssignments[builderEditingDay] ?? null,
    );
    const targetIsEmpty = templateId !== null && !isTemplateAssignable(templates.find((t) => t.id === templateId));
    if (targetIsEmpty) {
      const msg = 'Add exercises to template before assigning.';
      if (templateErrorClearTimer) clearTimeout(templateErrorClearTimer);
      templateError = msg;
      templateErrorFading = false;
      templateErrorClearTimer = window.setTimeout(() => {
        templateErrorFading = true;
        setTimeout(() => {
          if (templateError === msg) {
            templateError = null;
            templateErrorFading = false;
          }
          templateErrorClearTimer = null;
        }, 200);
      }, 2000);
    } else {
      if (templateErrorClearTimer) {
        clearTimeout(templateErrorClearTimer);
        templateErrorClearTimer = null;
      }
      templateErrorFading = false;
    }
    if (editingRoutineTemplateNameId && editingRoutineTemplateNameId !== templateId) {
      const prev = templates.find((t) => t.id === editingRoutineTemplateNameId);
      if (prev) void commitRoutineTemplateNameEdit(prev);
    }
    if (!targetIsEmpty) {
      templateError = null;
    }
    builderAssignments = { ...builderAssignments, [builderEditingDay]: templateId };

    const shouldPersist =
      templateId === null ||
      isTemplateAssignable(templates.find((t) => t.id === templateId));
    if (!shouldPersist) return;

    const newEffective = effectiveAssignmentTemplateId(templateId);
    if (newEffective !== priorEffective) {
      void persistBuilderDayAssignment(newEffective);
    }
  }

  function beginRoutineTemplateNameEdit(templateId: string) {
    // Focus/select this row in the list (for edit/delete buttons) even if empty
    builderAssignments = { ...builderAssignments, [builderEditingDay]: templateId };
    const tpl = templates.find((t) => t.id === templateId);
    if (isTemplateAssignable(tpl)) assignTemplateToBuilderDay(templateId);
    editingRoutineTemplateNameId = templateId;
    routineTemplateNameEditOriginal = tpl
      ? sanitizeTemplateName((tpl.name ?? '').trim())
      : null;
  }

  async function persistTemplateNameById(templateId: string, rawName: string) {
    if (templateId.startsWith('temp-')) return;

    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) return;

    const savedName = sanitizeTemplateName(rawName.trim()) || 'NEW TEMPLATE';
    if (savedName === tpl.name) return;

    tpl.name = savedName;
    if (editingTemplateId === templateId) draftTemplateName = savedName;
    patchTemplateInCache(templateId, savedName, tpl.exercises, tpl.color);

    try {
      await db.updateTemplateName(templateId, savedName);
      templateSaveError = null;
      templateError = null;
    } catch (e) {
      console.error('Template name save failed', e);
      const msg = 'Could not save template name.';
      if (currentView === 'edit_template') {
        templateSaveError = msg;
      } else {
        templateError = msg;
        templateErrorFading = false;
      }
      void loadData({ preserveSession: true });
    }
  }

  function scheduleTemplateNamePersist(templateId: string, rawName: string) {
    if (templateId.startsWith('temp-')) return;
    templateNamePersistId = templateId;
    if (templateNamePersistTimer) clearTimeout(templateNamePersistTimer);
    templateNamePersistTimer = setTimeout(() => {
      templateNamePersistTimer = null;
      const id = templateNamePersistId;
      templateNamePersistId = null;
      if (!id) return;
      void persistTemplateNameById(id, rawName);
    }, 200);
  }

  async function flushTemplateNamePersist() {
    if (templateNamePersistTimer) {
      clearTimeout(templateNamePersistTimer);
      templateNamePersistTimer = null;
    }
    const id = templateNamePersistId;
    templateNamePersistId = null;
    if (!id) return;
    const tpl = templates.find((t) => t.id === id);
    const rawName = id === editingTemplateId ? draftTemplateName : (tpl?.name ?? '');
    await persistTemplateNameById(id, rawName);
  }

  function commitRoutineTemplateNameEdit(template: Template) {
    const trimmed = sanitizeTemplateName((template.name ?? '').trim());
    template.name = trimmed || 'NEW TEMPLATE';
    void flushTemplateNamePersist();
    editingRoutineTemplateNameId = null;
    routineTemplateNameEditOriginal = null;
  }

  function templateIdAfterDeletedTemplate(deletedId: string): string | null {
    const idx = templates.findIndex((t) => t.id === deletedId);
    if (idx < 0) return null;
    if (idx > 0) return templates[idx - 1].id;
    if (idx < templates.length - 1) return templates[idx + 1].id;
    return null;
  }

  function applyBuilderTemplateRemoval(deletedId: string, replacementId: string | null) {
    const replacementTpl = replacementId
      ? templates.find((t) => t.id === replacementId)
      : null;
    const safeReplacement = isTemplateAssignable(replacementTpl) ? replacementId : null;
    templates = templates.filter((t) => t.id !== deletedId);
    const nextAssignments = { ...builderAssignments };
    for (let i = 0; i < 7; i++) {
      if (nextAssignments[i] === deletedId) {
        nextAssignments[i] = replacementId; // set raw so the previous template row becomes "selected" in the list (for highlight + edit/delete buttons), even if it is empty
        applyLocalScheduleAssignment(i, safeReplacement);
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

    const schedulePatches = affectedDays.map((day) => ({
      dayOfWeek: day,
      templateId: schedule.find((s) => s.day_of_week === day)?.template_id ?? null,
    }));

    void (async () => {
      try {
        if (schedulePatches.length > 0) {
          await db.assignTemplatesToDays(schedulePatches);
        }
        await db.deleteTemplate(deletedId);
      } catch (e) {
        console.error(e);
        templateError = formatDbError(e);
        templateErrorFading = false;
        void loadData({ preserveSession: true });
      }
    })();
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
    exerciseTypeFieldStash = {};
    draftExercises = tpl.exercises.map((e) => {
      const copy = { ...e };
      normalizeDraftExercise(copy);
      return copy;
    });
    draftTemplateName = sanitizeTemplateName(tpl.name);
    draftTemplateColor = (tpl as any).color ?? 0;
    selectedExerciseId = draftExercises.length > 0 ? draftExercises[0].id : null;
    editingExerciseNameId = null;
    templateSaveError = null;
    resetNewExerciseForm();
    // Library picker is closed by default. User can open it explicitly with the LIBRARY button.
    showExerciseLibraryPicker = false;
    // Remember where we came from so we can return there on close (supports nesting: routine editor → template editor)
    templateEditorReturnView = currentView === 'swap_template' ? 'swap_template' : 'track';
    currentView = 'edit_template';
  }

  function patchTemplateInCache(
    templateId: string,
    name: string,
    exercises: Exercise[],
    color?: number,
  ) {
    const trimmed = name.trim();
    templates = templates.map((t) =>
      t.id === templateId
        ? { ...t, name: trimmed || t.name, exercises, color: typeof color === 'number' ? color : t.color ?? 0 }
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
        user_id: copy.user_id ?? uid,
        name: copy.name,
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

  function draftExercisesForSave(): any[] {
    return draftExercises.map((e) => {
      const copy = { ...e };
      normalizeDraftExercise(copy);
      return copy;
    });
  }

  function mergeSavedExercisesIntoLibrary(saved: Exercise[]) {
    const byId = new Map(exerciseLibrary.map((ex) => [ex.id, ex]));
    for (const ex of saved) {
      byId.set(ex.id, ex);
    }
    exerciseLibrary = [...byId.values()];
  }

  function applySavedTemplateExercises(templateId: string, saved: Exercise[]) {
    const tpl = templates.find((t) => t.id === templateId);
    const prevSelected = selectedExerciseId;
    const selectedIndex = draftExercises.findIndex((e) => e.id === prevSelected);
    const prevDraft = draftExercises;

    patchTemplateInCache(templateId, tpl?.name ?? draftTemplateName, saved, draftTemplateColor);
    mergeSavedExercisesIntoLibrary(saved);
    draftExercises = saved.map((ex) => ({ ...ex }));

    const nextStash = { ...exerciseTypeFieldStash };
    saved.forEach((savedEx, i) => {
      const prevId = prevDraft[i]?.id;
      if (prevId && prevId !== savedEx.id && nextStash[prevId]) {
        nextStash[savedEx.id] = mergeExerciseTypeStash(
          nextStash[savedEx.id],
          nextStash[prevId],
        );
        delete nextStash[prevId];
      }
    });
    exerciseTypeFieldStash = nextStash;

    if (selectedIndex >= 0 && saved[selectedIndex]) {
      selectedExerciseId = saved[selectedIndex].id;
    } else if (prevSelected && saved.some((ex) => ex.id === prevSelected)) {
      selectedExerciseId = prevSelected;
    }
  }

  async function persistTemplateExercisesNow() {
    const templateId = editingTemplateId;
    if (!templateId || templateId.startsWith('temp-')) return;

    if (templateDraftSaveInFlight) {
      templateDraftSavePending = true;
      return;
    }

    const snapExercises = draftExercisesForSave();
    const validationErr = validateDraftExercises(snapExercises);
    if (validationErr) {
      templateSaveError = validationErr;
      return;
    }

    templateDraftSaveInFlight = true;
    try {
      const saved = await db.saveTemplateExercises(templateId, snapExercises);
      applySavedTemplateExercises(templateId, saved);
      templateSaveError = null;

      if (!isTemplateAssignable({ exercises: saved })) {
        await clearTemplateFromAllDays(templateId);
      }
    } catch (err) {
      console.error('template exercise save failed', err);
      templateSaveError =
        err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
          ? err.message
          : 'Could not save template changes. Try again.';
    } finally {
      templateDraftSaveInFlight = false;
      if (templateDraftSavePending) {
        templateDraftSavePending = false;
        void persistTemplateExercisesNow();
      }
    }
  }

  function persistTemplateNameNow() {
    const templateId = editingTemplateId;
    if (!templateId) return;
    scheduleTemplateNamePersist(templateId, draftTemplateName);
    void flushTemplateNamePersist();
  }

  async function persistTemplateColorNow() {
    const templateId = editingTemplateId;
    if (!templateId || templateId.startsWith('temp-')) return;

    const tpl = templates.find((t) => t.id === templateId);
    const prevColor = tpl?.color ?? 0;
    if (draftTemplateColor === prevColor) return;

    patchTemplateInCache(
      templateId,
      tpl?.name ?? draftTemplateName,
      tpl?.exercises ?? [],
      draftTemplateColor,
    );

    try {
      await db.updateTemplateColor(templateId, draftTemplateColor);
      templateSaveError = null;
    } catch (err) {
      console.error('template color save failed', err);
      templateSaveError = 'Could not save template color.';
      void loadData({ preserveSession: true }).catch(() => {});
    }
  }

  async function saveTemplateEditorDraft() {
    const templateId = editingTemplateId;
    editingExerciseNameId = null;
    await flushTemplateNamePersist();
    if (templateId && !templateId.startsWith('temp-')) {
      await persistTemplateNameById(templateId, draftTemplateName);
      await persistTemplateColorNow();
      await persistTemplateExercisesNow();
    }
  }

  function exitEditTemplate() {
    if (editorExitSaving) return;
    editorExitSaving = true;
    const returnView = templateEditorReturnView;
    templateEditorReturnView = 'track';
    currentView = returnView;
    void runDbActivityBatch(saveTemplateEditorDraft)
      .finally(() => {
        draftExercises = [];
        exerciseTypeFieldStash = {};
        draftTemplateName = '';
        draftTemplateColor = 0;
        selectedExerciseId = null;
        editingExerciseNameId = null;
        editingTemplateId = '';
        deletedLibraryExerciseIds = new Set();
        templateSaveError = null;
        editorExitSaving = false;
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
      const { [id]: _removed, ...restStash } = exerciseTypeFieldStash;
      exerciseTypeFieldStash = restStash;
      draftExercises = draftExercises.filter((e: any) => e.id !== id);
      if (editingTemplateId) {
        const tpl = templates.find((t) => t.id === editingTemplateId);
        if (tpl) {
          patchTemplateInCache(
            editingTemplateId,
            tpl.name,
            tpl.exercises.filter((ex) => ex.id !== id),
            tpl.color,
          );
        }
      }
      if (selectedExerciseId === id) {
        selectedExerciseId = draftExercises.length > 0 ? draftExercises[draftExercises.length - 1].id : null;
        if (!selectedExerciseId) {
          resetNewExerciseForm();
        }
      }
      void persistTemplateExercisesNow();
      return;
    }
    void db.deleteExercise(id).then(() => loadData({ preserveSession: true }));
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
    void persistTemplateExercisesNow();
  }

  function focusExerciseNameInput(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function markDraftTouched() {
    draftExercises = [...draftExercises];
  }

  function switchDraftExerciseType(
    ex: {
      id?: string;
      exercise_type: 'reps' | 'time';
      target_reps?: number;
      current_weight?: number | null;
      increment?: number;
      target_minutes?: number;
      target_seconds?: number;
    },
    type: 'reps' | 'time',
  ) {
    const exId = ex.id;
    if (exId) {
      const captured = captureExerciseTypeFields(ex);
      exerciseTypeFieldStash = {
        ...exerciseTypeFieldStash,
        [exId]: mergeExerciseTypeStash(exerciseTypeFieldStash[exId], captured),
      };
    }
    applyDraftExerciseType(
      ex,
      type,
      exId ? exerciseTypeFieldStash[exId] : undefined,
    );
    draftExercises = [...draftExercises];
    void persistTemplateExercisesNow();
  }

  function addNewExercise() {
    if (!editingTemplateId) return;
    closeLibraryPicker();
    // Creates a brand new exercise row on save (temp- id → INSERT in saveTemplateExercises).
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const newEx: any = {
      id: tempId,
      name: 'NEW EXERCISE',
      exercise_type: 'reps',
      target_sets: 3,
      target_reps: DEFAULT_TARGET_REPS,
      target_minutes: DEFAULT_TARGET_MINUTES,
      target_seconds: DEFAULT_TARGET_SECONDS,
      increment: DEFAULT_INCREMENT_KG,
      current_weight: DEFAULT_BASE_KG,
      display_order: draftExercises.length,
      user_id: currentUser?.id ?? '',
    };
    draftExercises = [...draftExercises, newEx];
    selectExercise(tempId);
    void persistTemplateExercisesNow();
  }

  function toggleExerciseLibraryPicker() {
    if (showExerciseLibraryPicker) {
      closeLibraryPicker();
    } else {
      libraryPickerClosing = false;
      showExerciseLibraryPicker = true;
    }
  }

  function deleteSelectedExercise() {
    if (!selectedExerciseId) return;
    const id = selectedExerciseId;
    draftExercises = draftExercises.filter((e: any) => e.id !== id);
    if (editingTemplateId) {
      const tpl = templates.find((t) => t.id === editingTemplateId);
      if (tpl) {
        patchTemplateInCache(
          editingTemplateId,
          tpl.name,
          tpl.exercises.filter((ex) => ex.id !== id),
          tpl.color,
        );
      }
    }
    if (draftExercises.length > 0) {
      selectExercise(draftExercises[draftExercises.length - 1].id);
    } else {
      selectedExerciseId = null;
      resetNewExerciseForm();
    }
    void persistTemplateExercisesNow();
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
    draggedIndex = null;
    void persistTemplateExercisesNow();
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

  // Drag and drop reorder for the templates list in the routine builder
  let templateDraggedIndex = $state<number | null>(null);
  let templateRowDragged = $state(false);

  function handleTemplateDragStart(e: DragEvent, index: number) {
    templateDraggedIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index.toString());
    }
  }

  function handleTemplateDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  }

  function handleTemplateDrop(e: DragEvent, targetIndex: number) {
    e.preventDefault();
    if (templateDraggedIndex === null || templateDraggedIndex === targetIndex) {
      templateDraggedIndex = null;
      return;
    }
    const arr = [...templates];
    const [moved] = arr.splice(templateDraggedIndex, 1);
    arr.splice(targetIndex, 0, moved);
    // Re-assign sequential display orders
    arr.forEach((t, i) => {
      (t as any).display_order = i;
    });
    templates = arr;
    // Persist
    const orders = arr
      .map((t, i) => ({ id: t.id, display_order: i }))
      .filter((o) => !o.id.startsWith('temp-'));
    if (orders.length === 0) {
      templateDraggedIndex = null;
      return;
    }
    void db.updateTemplateDisplayOrders(orders).catch((err) => {
      console.error('Failed to persist template reorder', err);
      // refresh to restore server order
      loadData({ preserveSession: true });
    });
    templateDraggedIndex = null;
  }

  function handleTemplateDragEnd() {
    const wasDragging = templateDraggedIndex !== null;
    templateDraggedIndex = null;
    if (wasDragging) {
      templateRowDragged = true;
      setTimeout(() => {
        templateRowDragged = false;
      }, 100);
    }
  }
</script>

<div class="app w-full h-dvh max-h-dvh overflow-hidden select-none text-white bg-black flex flex-col font-sans">

  {#snippet ctaEmptySlot()}
    <div class="{workoutSideBtnClass} {workoutCtaEmptyClass}" aria-hidden="true">
      <X class="workout-cta-empty-icon size-3.5 shrink-0" strokeWidth={2.25} />
    </div>
  {/snippet}

  {#snippet ctaBar(editorDisabled = false)}
    <div class={editorDisabled ? 'opacity-40 pointer-events-none' : ''}>
      {#if workoutActionError}
        <p class="text-[10px] text-red-300 leading-snug mb-2">{workoutActionError}</p>
      {/if}
      {#if workoutState === 'idle' || workoutState === 'active' || workoutState === 'done' || workoutState === 'skipped'}
        <div class="app-cta-grid">
          {#if useNoWorkoutCtaLayout}
            {#if statsCtaEnabled}
              <button
                type="button"
                class="{workoutSideBtnClass} border bg-[#0d0d0d] border-[#1e1e1e] text-white hover:border-white/40"
                onclick={enterStatsView}
              >
                <span class="workout-cta-side-content">
                  <BarChart3 class="workout-cta-side-icon" strokeWidth={2.25} aria-hidden="true" />
                  <span class={workoutSideLabelClass} style={ctaChStyle('STATS', SIDE_CTA_MAX_CH)}>STATS</span>
                </span>
              </button>
            {:else}
              {@render ctaEmptySlot()}
            {/if}

            {#if isViewingToday && isRestDayView}
              <button
                type="button"
                class="{workoutCenterBtnClass} cursor-default border-[#1e1e1e] bg-[#141414] text-zinc-500"
                disabled
                tabindex={-1}
              >
                <span
                  class={workoutCenterLabelClass}
                  style={ctaChStyle(REST_CTA_SOURCE, CENTER_CTA_MAX_CH)}
                >{REST_CTA_SOURCE}</span>
              </button>
            {:else if !isViewingToday}
              <button
                type="button"
                class="{workoutCenterBtnClass} go-to-today-btn border-transparent bg-white text-black"
                onclick={goToToday}
              >
                <span class="{workoutCenterLabelClass}">GO TO TODAY</span>
              </button>
            {/if}

            {@render ctaEmptySlot()}
          {:else}
          {#if !isViewingToday}
              {@render ctaEmptySlot()}
              <button
                type="button"
                class="{workoutCenterBtnClass} go-to-today-btn border-transparent bg-white text-black"
                onclick={goToToday}
              >
                <span class="{workoutCenterLabelClass}">GO TO TODAY</span>
              </button>
              {@render ctaEmptySlot()}
          {:else}
          <!-- STATS (left, narrow) — opens stats menu -->
          <button
            type="button"
            class="{workoutSideBtnClass} border bg-[#0d0d0d] border-[#1e1e1e] text-white hover:border-white/40"
            onclick={enterStatsView}
          >
            <span class="workout-cta-side-content">
              <BarChart3 class="workout-cta-side-icon" strokeWidth={2.25} aria-hidden="true" />
              <span class={workoutSideLabelClass} style={ctaChStyle('STATS', SIDE_CTA_MAX_CH)}>STATS</span>
            </span>
          </button>

          {#if workoutState === 'idle'}
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
              <button
                type="button"
                class="{workoutSideBtnClass} group border bg-[#0d0d0d] transition-all duration-150 {skipTapPulseActive ? 'hold-skip-tap-pulse' : skipProgress > 0 ? 'border-amber-500 text-[#fbbf24]' : 'border-[#1e1e1e] text-white hover:border-white/40'}"
                onmousedown={startSkipHold}
                onmouseup={stopSkipHold}
                onmouseleave={stopSkipHold}
                ontouchstart={startSkipHold}
                ontouchend={stopSkipHold}
                onanimationend={onSkipTapPulseEnd}
              >
                <div class="absolute inset-0 z-0 bg-amber-900/40 transition-all duration-[20ms]" style="width: {skipProgress}%;"></div>
                <span class="workout-cta-side-content">
                  <SkipForward class="workout-cta-side-icon" strokeWidth={2.25} aria-hidden="true" />
                  <span
                    class={workoutSideLabelClass}
                    style={ctaChStyle(SKIP_CTA_SOURCE, SIDE_CTA_MAX_CH)}
                  >
                    {SKIP_CTA_SOURCE}
                  </span>
                </span>
              </button>
          {:else if workoutState === 'active'}
              <button
                type="button"
                class="{workoutCenterBtnClass} {isPerfectDay ? 'w-cta-complete-green' : 'w-cta-finish'}"
                onclick={handleFinishWorkoutTap}
              >
                <span
                  class={workoutCenterLabelClass}
                  style={ctaChStyle(START_CTA_TARGET, CENTER_CTA_MAX_CH)}
                >{START_CTA_TARGET}</span>
              </button>
              <button
                class="{workoutSideBtnClass} group border bg-[#0d0d0d] transition-all duration-150 {cancelTapPulseActive ? 'hold-cancel-tap-pulse' : cancelProgress > 0 ? 'border-red-500 text-[#f87171]' : 'border-[#1e1e1e] text-zinc-500'}"
                onmousedown={startCancelHold}
                onmouseup={stopCancelHold}
                onmouseleave={stopCancelHold}
                ontouchstart={startCancelHold}
                ontouchend={stopCancelHold}
                onanimationend={onCancelTapPulseEnd}
              >
                <div class="absolute inset-0 z-0 bg-red-900/40 transition-all duration-[20ms]" style="width: {cancelProgress}%;"></div>
                <span class="workout-cta-side-content">
                  <X class="workout-cta-side-icon" strokeWidth={2.25} aria-hidden="true" />
                  <span class={workoutSideLabelClass} style={ctaChStyle(SKIP_CTA_TARGET, SIDE_CTA_MAX_CH)}>{SKIP_CTA_TARGET}</span>
                </span>
              </button>
          {:else if workoutState === 'done'}
            {@const effectiveStatus = justFinishedStatus ?? todayCompletionStatus}
            {@const isUntouchedComplete = effectiveStatus === 'untouched'}
            {@const isYellowComplete = !isUntouchedComplete && (effectiveStatus === 'yellow' || effectiveStatus === 'neutral')}
              <button
                class="{workoutCenterBtnClass} cursor-default {isUntouchedComplete ? 'w-cta-skipped' : isYellowComplete ? 'w-cta-complete-yellow' : 'w-cta-complete-green'}"
              >
                <span
                  class={workoutCenterLabelClass}
                  style={ctaChStyle(COMPLETE_CTA_SOURCE, CENTER_CTA_MAX_CH)}
                >{COMPLETE_CTA_SOURCE}</span>
              </button>
              <button
                type="button"
                class="{workoutSideBtnClass} group border bg-[#0d0d0d] transition-all duration-150 {eraseTapPulseActive ? 'hold-cancel-tap-pulse' : eraseProgress > 0 ? 'border-red-500 text-[#f87171]' : 'border-[#1e1e1e] text-zinc-500'}"
                onmousedown={startEraseHold}
                onmouseup={stopEraseHold}
                onmouseleave={stopEraseHold}
                ontouchstart={startEraseHold}
                ontouchend={stopEraseHold}
                onanimationend={onEraseTapPulseEnd}
              >
                <div class="absolute inset-0 z-0 bg-red-900/40 transition-all duration-[20ms]" style="width: {eraseProgress}%;"></div>
                <span class="workout-cta-side-content">
                  <Trash2 class="workout-cta-side-icon" strokeWidth={2.25} aria-hidden="true" />
                  <span class={workoutSideLabelClass} style={ctaChStyle(ERASE_CTA_SOURCE, SIDE_CTA_MAX_CH)}>{ERASE_CTA_SOURCE}</span>
                </span>
              </button>
          {:else if workoutState === 'skipped'}
              <button
                class="{workoutCenterBtnClass} w-cta-skipped cursor-default"
              >
                <span
                  class={workoutCenterLabelClass}
                  style={ctaChStyle(SKIPPED_CTA_SOURCE, CENTER_CTA_MAX_CH)}
                >{SKIPPED_CTA_SOURCE}</span>
              </button>
              <button
                type="button"
                class="{workoutSideBtnClass} group border bg-[#0d0d0d] transition-all duration-150 {eraseTapPulseActive ? 'hold-cancel-tap-pulse' : eraseProgress > 0 ? 'border-red-500 text-[#f87171]' : 'border-[#1e1e1e] text-zinc-500'}"
                onmousedown={startEraseHold}
                onmouseup={stopEraseHold}
                onmouseleave={stopEraseHold}
                ontouchstart={startEraseHold}
                ontouchend={stopEraseHold}
                onanimationend={onEraseTapPulseEnd}
              >
                <div class="absolute inset-0 z-0 bg-red-900/40 transition-all duration-[20ms]" style="width: {eraseProgress}%;"></div>
                <span class="workout-cta-side-content">
                  <Trash2 class="workout-cta-side-icon" strokeWidth={2.25} aria-hidden="true" />
                  <span class={workoutSideLabelClass} style={ctaChStyle(ERASE_CTA_SOURCE, SIDE_CTA_MAX_CH)}>{ERASE_CTA_SOURCE}</span>
                </span>
              </button>
          {/if}
          {/if}
          {/if}
        </div>
      {/if}
    </div>
  {/snippet}

  {#if showSettingsPanel}
    <div
      class="settings-panel-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Account and backend"
      tabindex="-1"
      onclick={(e) => { if (e.target === e.currentTarget) closeSettingsPanel(); }}
    >
      <div class="settings-panel-dialog rounded-xl border border-[#1e1e1e] bg-[#141414] shadow-xl overflow-hidden text-left">
        <div class="settings-panel-header">
          <div class="settings-panel-header__title">
            <div class="settings-panel-brand" aria-hidden="true">
              <span class="settings-panel-brand__lift">LIFT</span>
              <span class="settings-panel-brand__dash">—</span>
              <span class="settings-panel-brand__tracker">TRACKER</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
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
        </div>
        <div class="settings-panel-body text-[10px] leading-snug">
          {#if currentUser}
            <div class="flex justify-center py-1">
              <GeneratedAvatar userId={currentUser.id} size={80} />
            </div>
          {/if}
          <div class="settings-panel-stats">
            {#if supabasePanelLoading && !supabasePanel}
              <p class="settings-panel-loading">Loading backend…</p>
            {:else if supabasePanel}
              {@const panel = supabasePanel}
              {#if currentUser}
                <div class="settings-panel-header__identity">
                  {#if editingAccountName && isUsernameAccount(currentUser)}
                    <input
                      type="text"
                      autocomplete="username"
                      spellcheck="false"
                      maxlength={MAX_USERNAME_LEN}
                      class="settings-panel-header__name-input"
                      use:focusExerciseNameInput
                      bind:value={accountNameEditValue}
                      oninput={(e) => {
                        accountNameEditValue = sanitizeUsernameInput((e.currentTarget as HTMLInputElement).value);
                      }}
                      onblur={() => void commitAccountNameEdit()}
                      onkeydown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          (e.currentTarget as HTMLInputElement).blur();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelAccountNameEdit();
                        }
                      }}
                      disabled={accountBusy}
                    />
                  {:else if isUsernameAccount(currentUser)}
                    <button
                      type="button"
                      class="settings-panel-header__name settings-panel-header__name--editable"
                      title="Click to rename username"
                      disabled={accountBusy}
                      onclick={beginAccountNameEdit}
                    >
                      {accountDisplayName}
                    </button>
                  {:else}
                    <span class="settings-panel-header__name">{accountDisplayName}</span>
                  {/if}
                  <span class="text-[10px] text-zinc-500">joined {accountMemberSince}</span>
                  <span class="text-[10px] text-zinc-500">Session: {formatSessionExpiry(panel.expiresAt)}</span>
                  <span class="settings-panel-header__user-id" title={currentUser.id}>{currentUser.id}</span>
                </div>
              {:else}
                <span class="settings-panel-header__name text-zinc-400">Backend</span>
              {/if}
              {#if panel.usage}
                <div class="mt-1 mb-2">
                  <div class="text-[8px] uppercase tracking-[1px] text-zinc-500 text-center mb-1">Data usage</div>
                  <div class="grid grid-cols-3 gap-1 text-[9px] text-zinc-400">
                    <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center">
                      <List class="size-3 shrink-0" aria-hidden="true" />
                      <span class="leading-none">{panel.usage.templates} tpl</span>
                    </span>
                    <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center">
                      <Dumbbell class="size-3 shrink-0" aria-hidden="true" />
                      <span class="leading-none">{panel.usage.exercises} ex</span>
                    </span>
                    <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center">
                      <History class="size-3 shrink-0" aria-hidden="true" />
                      <span class="leading-none">{panel.usage.workout_history} wrk logs</span>
                    </span>
                    <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center">
                      <BarChart3 class="size-3 shrink-0" aria-hidden="true" />
                      <span class="leading-none">{panel.usage.tracked_stats ?? 0} sts</span>
                    </span>
                    <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center">
                      <HardDrive class="size-3 shrink-0" aria-hidden="true" />
                      <span class="leading-none">{panel.usage.exact ? '' : '~'}{formatBytes(panel.usage.estimated_bytes)}</span>
                    </span>
                    <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center">
                      <Pencil class="size-3 shrink-0" aria-hidden="true" />
                      <span class="leading-none">{panel.usage.stat_logs ?? 0} sts logs</span>
                    </span>
                  </div>
                </div>
              {/if}

              {#if panel.health.error || panel.sessionError}
                <p class="settings-panel-alert">
                  {panel.sessionError ?? panel.health.error}
                </p>
              {/if}
            {/if}
          </div>

          {#if currentUser}
            <div class="settings-panel-account">
            {#if accountError && !showChangePasswordForm}
              <p class="settings-panel-alert">
                {accountError}
              </p>
            {/if}

            {#if accountCanChangePassword}
              <div class="settings-panel-password"
                class:settings-panel-password--open={showChangePasswordForm}>
                {#if showChangePasswordForm}
                  <button
                    type="button"
                    class="settings-panel-action-btn settings-panel-action-btn--full settings-panel-action-btn--password-cancel"
                    disabled={accountBusy}
                    onclick={toggleChangePasswordForm}
                  >
                    <span class="settings-panel-action-btn__label">
                      <X class="size-3 shrink-0 pointer-events-none" aria-hidden="true" />
                      CANCEL
                    </span>
                  </button>
                {:else}
                  <button
                    type="button"
                    class="settings-panel-action-btn settings-panel-action-btn--full
                      {holdCautionDisplayKind === 'delete'
                        ? 'settings-panel-action-btn--hold-caution-delete'
                        : holdCautionDisplayKind === 'signout'
                          ? 'settings-panel-action-btn--hold-caution-signout'
                          : 'settings-panel-action-btn--change-password'}
                      {holdCautionMorphFade && !holdCautionDisplayKind
                        ? 'settings-panel-action-btn--morph'
                        : ''}"
                    disabled={accountBusy || holdCautionKind !== null}
                    aria-live={holdCautionDisplayKind ? 'polite' : undefined}
                    onclick={toggleChangePasswordForm}
                  >
                    {#if holdCautionDisplayKind}
                      <span class="settings-panel-action-btn__caution-msg">{holdCautionMessage}</span>
                    {:else}
                      <span class="settings-panel-action-btn__label">
                        <LockKeyhole class="size-3 shrink-0 pointer-events-none" aria-hidden="true" />
                        CHANGE PASSWORD
                      </span>
                    {/if}
                  </button>
                {/if}

                <div
                  class="auth-confirm-reveal"
                  class:auth-confirm-reveal--open={showChangePasswordForm}
                  aria-hidden={!showChangePasswordForm}
                >
                  <div class="auth-confirm-reveal__inner">
                    <form
                      class="settings-panel-password-form"
                      onsubmit={(e) => {
                        e.preventDefault();
                        if (
                          accountBusy ||
                          changePasswordFeedbackLit ||
                          !changePasswordSubmitReady
                        ) {
                          return;
                        }
                        void handleChangePassword();
                      }}
                    >
                      <div class="relative">
                        <Lock class="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-zinc-500 pointer-events-none" />
                        <input
                          type="password"
                          autocomplete="new-password"
                          maxlength={MAX_PASSWORD_LEN}
                          bind:value={changePasswordNew}
                          disabled={accountBusy}
                          placeholder="••••••••"
                          aria-label="New password"
                          class="settings-panel-password-input"
                          oninput={(e) => {
                            clearChangePasswordFeedback();
                            changePasswordNew = sanitizePasswordInput((e.currentTarget as HTMLInputElement).value);
                          }}
                        />
                      </div>
                      <div class="relative">
                        <LockKeyhole class="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-zinc-500 pointer-events-none z-10" />
                        <input
                          type="password"
                          autocomplete="new-password"
                          maxlength={MAX_PASSWORD_LEN}
                          bind:value={changePasswordConfirm}
                          disabled={accountBusy}
                          placeholder=""
                          aria-label="Confirm password"
                          class="settings-panel-password-input"
                          oninput={(e) => {
                            clearChangePasswordFeedback();
                            changePasswordConfirm = sanitizePasswordInput((e.currentTarget as HTMLInputElement).value);
                          }}
                        />
                        {#if !changePasswordConfirm}
                          <span
                            class="absolute left-9 top-1/2 -translate-y-1/2 text-[0.6875rem] text-zinc-600 pointer-events-none select-none"
                            aria-hidden="true"
                          >••••••••</span>
                        {/if}
                      </div>
                      <div class="auth-submit-crossfade settings-panel-password-save-crossfade">
                        <button
                          type="submit"
                          class="auth-submit-crossfade__layer auth-submit-btn settings-panel-password-save-btn settings-panel-password-save-btn--ready font-black flex items-center justify-center text-center leading-snug
                            {changePasswordSubmitBtnLit ? 'auth-submit-crossfade__layer--lit auth-submit-crossfade__layer--interactive' : ''}
                            {changePasswordFeedbackExiting ? 'auth-submit-crossfade__layer--top' : ''}"
                          disabled={accountBusy || changePasswordFeedbackLit || (!changePasswordSubmitReady && !changePasswordFeedbackExiting)}
                          aria-hidden={!changePasswordSubmitBtnLit}
                          aria-busy={accountBusy}
                          aria-label={accountBusy ? 'Saving password' : 'Save password'}
                          tabindex={changePasswordSubmitBtnLit ? 0 : -1}
                        >
                          {#if accountBusy}
                            <RefreshCw class="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                          {:else}
                            SAVE PASSWORD
                          {/if}
                        </button>
                        {#if changePasswordCrossfadeShowFeedback}
                          <div
                            role="status"
                            aria-live="polite"
                            class="auth-submit-crossfade__layer auth-submit-btn auth-submit-btn--feedback settings-panel-password-save-btn font-black flex items-center justify-center text-center leading-snug
                              {changePasswordError ? 'auth-submit-btn--error' : 'auth-submit-btn--success'}
                              {changePasswordFeedbackLit ? 'auth-submit-crossfade__layer--lit auth-submit-crossfade__layer--top' : ''}
                              {changePasswordError && changePasswordFeedbackLit ? 'auth-submit-btn--error-nudge' : ''}"
                            title={changePasswordError ?? changePasswordSuccess ?? undefined}
                            ontransitionend={onChangePasswordCrossfadeTransitionEnd}
                          >
                            <span class="auth-submit-btn__feedback flex items-center gap-1.5 min-w-0 max-w-full">
                              {#if changePasswordError}
                                <CircleAlert class="auth-submit-btn__icon size-3.5 shrink-0" aria-hidden="true" />
                              {:else}
                                <CircleCheck class="auth-submit-btn__icon size-3.5 shrink-0" aria-hidden="true" />
                              {/if}
                              <span class="line-clamp-2 min-w-0">{changePasswordError ?? changePasswordSuccess}</span>
                            </span>
                          </div>
                        {/if}
                      </div>
                    </form>
                  </div>
                </div>
              </div>
            {/if}

            <div
              class="settings-panel-actions-reveal"
              class:settings-panel-actions-reveal--open={!showChangePasswordForm}
              aria-hidden={showChangePasswordForm}
            >
              <div class="settings-panel-actions-reveal__inner">
                <div class="settings-panel-actions">
                  <button
                    type="button"
                    title="Hold 2s to sign out"
                    class="settings-panel-action-btn {signOutTapPulseActive ? 'hold-skip-tap-pulse' : signOutProgress > 0 ? 'settings-panel-action-btn--signout-active' : 'settings-panel-action-btn--signout'}"
                    disabled={accountBusy || showChangePasswordForm}
                    tabindex={showChangePasswordForm ? -1 : 0}
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
                    disabled={accountBusy || showChangePasswordForm}
                    tabindex={showChangePasswordForm ? -1 : 0}
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
              </div>
            </div>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <!-- Update available prompt (Android sideload self-update).
       Only rendered after logged in + data loaded + main menu visible.
       On website: Ctrl+click the left footer text to manually trigger the demo.
  -->
  {#if showUpdatePrompt && updateInfo && !bootOverlayVisible && (currentUser || !isNativeApp())}
    <div
      class="settings-panel-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Update available"
      tabindex="-1"
      onclick={(e) => { if (e.target === e.currentTarget && !updateInstalling) closeUpdatePrompt(); }}
    >
      <div class="settings-panel-dialog rounded-xl border border-[#1e1e1e] bg-[#141414] shadow-xl overflow-hidden text-left">
        <div class="settings-panel-header">
          <div class="settings-panel-header__title">
            <div class="settings-panel-brand" aria-hidden="true">
              <span class="settings-panel-brand__lift">LIFT</span>
              <span class="settings-panel-brand__dash">—</span>
              <span class="settings-panel-brand__tracker">TRACKER</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              aria-label="Close"
              class="settings-panel-header__close"
              disabled={updateInstalling}
              onclick={closeUpdatePrompt}
            >
              <X class="size-3.5" />
            </button>
          </div>
        </div>

        <div class="settings-panel-body text-[10px] leading-snug">
          <!-- Version comparison -->
          <div class="flex flex-col items-center text-center">
            <div class="inline-flex items-center gap-1.5 rounded-full bg-emerald-950/60 px-3 py-0.5 text-emerald-400 text-[10px] font-medium tracking-[1.5px]">
              UPDATE AVAILABLE
              {#if updateInfo.size}
                · {(updateInfo.size / 1024 / 1024).toFixed(1)} MB
              {/if}
            </div>

            <div class="mt-2 flex items-center gap-3">
              <!-- Current version -->
              <div class="flex flex-col items-center">
                <div class="font-mono text-base text-zinc-400 tabular-nums">v{APP_VERSION}</div>
              </div>

              <div class="text-emerald-500 text-2xl leading-none">→</div>

              <!-- New version -->
              <div class="flex flex-col items-center">
                <div class="font-mono text-base font-semibold text-emerald-400 tabular-nums">v{updateInfo.version}</div>
              </div>
            </div>
          </div>

          {#if updateInfo.notes}
            <div class="mt-3">
              <div class="mb-1 text-[9px] font-medium tracking-[1px] text-zinc-500">WHAT'S NEW</div>
              <div class="max-h-40 overflow-auto rounded border border-[#1e1e1e] bg-[#0d0d0d] p-2.5 text-[10px] leading-snug text-zinc-300 whitespace-pre-wrap no-scrollbar">
                {updateInfo.notes}
              </div>
            </div>
          {:else}
            <p class="mt-3 text-center text-zinc-400">A new version of Lift Tracker is ready.</p>
          {/if}

          {#if updateError && !updateInstalling}
            <p class="settings-panel-alert mt-2">{updateError}</p>
          {/if}

          <div class="mt-3 min-h-[1.75rem] flex items-center">
            {#if !updateInstalling}
              <span class="block text-center text-[10px] text-zinc-400">Install to receive the latest features and fixes.</span>
            {:else if updateInstalling}
              {#if !isWaitingForUpdatePermission}
                <div class="flex items-center gap-2 w-full">
                  <div class="flex-1 h-1.5 rounded bg-[#1e1e1e] overflow-hidden">
                    <div
                      class="h-1.5 bg-emerald-500 transition-[width] duration-75"
                      style="width: {updateDownloadProgress}%"
                    ></div>
                  </div>
                  <span class="text-[10px] text-zinc-400 tabular-nums w-8 text-right">{updateDownloadProgress}%</span>
                </div>
              {/if}
              {#if updateError}
                <p class="mt-1.5 text-[10px] text-amber-400">{updateError}</p>
              {/if}
            {/if}
          </div>

          <div class="mt-3 grid grid-cols-1 gap-2">
            <button
              type="button"
              class={updateInstalling && !updateError 
                ? "settings-panel-action-btn settings-panel-action-btn--full pointer-events-none opacity-70 border-[#1e1e1e] text-zinc-400"
                : "settings-panel-action-btn settings-panel-action-btn--full settings-panel-action-btn--update-primary"}
              disabled={updateInstalling && !updateError}
              onclick={startUpdateInstall}
            >
              <span class="settings-panel-action-btn__label font-bold tracking-[0.5px]">
                {!updateInstalling ? "INSTALL UPDATE" : (updateError ? "INSTALL" : "Installing…")}
              </span>
            </button>
            {#if updateInstalling && updateError}
              <button
                type="button"
                class="settings-panel-action-btn settings-panel-action-btn--full"
                onclick={openGitHubReleases}
              >
                <span class="settings-panel-action-btn__label">Download manually from GitHub</span>
              </button>
            {/if}
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Post-update "what's new" / changelog. Shown once on first launch after installing a new version.
       Only rendered after logged in + data loaded + main menu visible.
       On website: Ctrl+click the right footer text to manually trigger the demo.
  -->
  {#if showPostUpdate && !bootOverlayVisible && (currentUser || !isNativeApp())}
    <div
      class="settings-panel-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="App updated"
      tabindex="-1"
      onclick={(e) => { if (e.target === e.currentTarget) closePostUpdate(); }}
    >
      <div class="settings-panel-dialog rounded-xl border border-[#1e1e1e] bg-[#141414] shadow-xl overflow-hidden text-left">
        <div class="settings-panel-header">
          <div class="settings-panel-header__title">
            <div class="settings-panel-brand" aria-hidden="true">
              <span class="settings-panel-brand__lift">LIFT</span>
              <span class="settings-panel-brand__dash">—</span>
              <span class="settings-panel-brand__tracker">TRACKER</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              aria-label="Close"
              class="settings-panel-header__close"
              onclick={closePostUpdate}
            >
              <X class="size-3.5" />
            </button>
          </div>
        </div>

        <div class="settings-panel-body text-[10px] leading-snug">
          <!-- Version / heading -->
          <div class="flex flex-col items-center text-center">
            <div class="inline-flex items-center gap-1.5 rounded-full bg-emerald-950/60 px-3 py-0.5 text-emerald-400 text-[10px] font-medium tracking-[1.5px]">
              UPDATED
              <Check class="size-3.5" />
            </div>

            <div class="mt-2 flex items-center gap-3">
              <!-- Updated version -->
              <div class="flex flex-col items-center">
                <div class="font-mono text-base font-semibold text-emerald-400 tabular-nums">v{postUpdateVersion}</div>
              </div>
            </div>
          </div>

          {#if postUpdateNotes}
            <div class="mt-3">
              <div class="mb-1 text-[9px] font-medium tracking-[1px] text-zinc-500">WHAT'S NEW</div>
              <div class="max-h-44 overflow-auto rounded border border-[#1e1e1e] bg-[#0d0d0d] p-2 text-[10px] leading-snug text-zinc-300 whitespace-pre-wrap no-scrollbar">
                {postUpdateNotes}
              </div>
              <span class="mt-2 block text-center text-[10px] text-zinc-400">Thanks for staying up to date!</span>
            </div>
          {:else}
            <p class="mt-3 text-center text-zinc-400">You’re now running the latest version.</p>
          {/if}

          <div class="mt-3 grid grid-cols-1 gap-2">
            <button
              type="button"
              class="settings-panel-action-btn settings-panel-action-btn--full settings-panel-action-btn--update-primary"
              onclick={closePostUpdate}
            >
              <span class="settings-panel-action-btn__label font-bold tracking-[0.5px]">GOT IT</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#snippet bootScreen()}
    {@const panel = supabasePanel}
    <div
      class="settings-panel-dialog boot-panel-dialog rounded-xl border border-[#1e1e1e] bg-[#141414] shadow-xl overflow-hidden text-left"
      class:boot-panel-reveal--active={bootAccountReveal}
      role="status"
      aria-live="polite"
      aria-busy={!bootAccountReveal}
      aria-label={bootAccountReveal ? 'Account ready' : bootMessage}
    >
      <div class="settings-panel-header">
        <div class="settings-panel-header__title">
          <div class="settings-panel-brand" aria-hidden="true">
            <span class="settings-panel-brand__lift">LIFT</span>
            <span class="settings-panel-brand__dash">—</span>
            <span class="settings-panel-brand__tracker">TRACKER</span>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <div class="settings-panel-header__supabase" aria-hidden="true">
            <span class="settings-panel-header__supabase-label">Supabase</span>
            <span class="settings-panel-header__dot-wrap">
              <span
                class="db-io-dot settings-panel-header__dot"
                class:db-io-dot--active={bootAccountReveal && !!panel && panel.health.ok && panel.sessionOk}
                class:boot-panel-dot-pulse={!bootAccountReveal}
              ></span>
            </span>
            <span
              class="settings-panel-header__latency"
              class:boot-panel-reveal-item={bootAccountReveal}
              class:boot-panel-reveal-item--header={bootAccountReveal}
            >
              {#if bootAccountReveal && panel?.health.latencyMs != null}
                {formatSupabaseLatencyMs(panel.health.latencyMs)}
              {:else if bootAccountReveal}
                —
              {:else}
                …
              {/if}
            </span>
          </div>
          <button
            type="button"
            class="settings-panel-header__close"
            disabled
            aria-hidden="true"
            tabindex="-1"
          >
            <X class="size-3.5" />
          </button>
        </div>
      </div>

      <div class="settings-panel-body text-[10px] leading-snug">
        {#if bootAccountReveal && currentUser && panel}
          <div class="flex justify-center py-1 boot-panel-reveal-item boot-panel-reveal-item--avatar">
            <GeneratedAvatar userId={currentUser.id} size={80} />
          </div>

          <div class="settings-panel-stats">
            <div class="settings-panel-header__identity boot-panel-reveal-item boot-panel-reveal-item--identity">
              <span class="settings-panel-header__name">{accountDisplayName}</span>
              <span class="text-[10px] text-zinc-500">joined {accountMemberSince}</span>
              <span class="text-[10px] text-zinc-500">Session: {formatSessionExpiry(panel.expiresAt)}</span>
              <span class="settings-panel-header__user-id" title={currentUser.id}>{currentUser.id}</span>
            </div>

            {#if panel.usage}
              <div class="mt-1 mb-2 boot-panel-reveal-item boot-panel-reveal-item--chips">
                <div class="text-[8px] uppercase tracking-[1px] text-zinc-500 text-center mb-1">Data usage</div>
                <div class="grid grid-cols-3 gap-1 text-[9px] text-zinc-400">
                  <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center">
                    <List class="size-3 shrink-0" aria-hidden="true" />
                    <span class="leading-none">{panel.usage.templates} tpl</span>
                  </span>
                  <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center">
                    <Dumbbell class="size-3 shrink-0" aria-hidden="true" />
                    <span class="leading-none">{panel.usage.exercises} ex</span>
                  </span>
                  <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center">
                    <History class="size-3 shrink-0" aria-hidden="true" />
                    <span class="leading-none">{panel.usage.workout_history} wrk logs</span>
                  </span>
                  <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center">
                    <BarChart3 class="size-3 shrink-0" aria-hidden="true" />
                    <span class="leading-none">{panel.usage.tracked_stats ?? 0} sts</span>
                  </span>
                  <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center">
                    <HardDrive class="size-3 shrink-0" aria-hidden="true" />
                    <span class="leading-none">{panel.usage.exact ? '' : '~'}{formatBytes(panel.usage.estimated_bytes)}</span>
                  </span>
                  <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center">
                    <Pencil class="size-3 shrink-0" aria-hidden="true" />
                    <span class="leading-none">{panel.usage.stat_logs ?? 0} sts logs</span>
                  </span>
                </div>
              </div>
            {/if}

            {#if panel.health.error || panel.sessionError}
              <p class="settings-panel-alert boot-panel-reveal-item boot-panel-reveal-item--chips">
                {panel.sessionError ?? panel.health.error}
              </p>
            {/if}
          </div>

          <div class="settings-panel-account boot-panel-reveal-item boot-panel-reveal-item--actions">
            {#if accountCanChangePassword}
              <div class="settings-panel-password">
                <div class="settings-panel-action-btn settings-panel-action-btn--full settings-panel-action-btn--change-password">
                  <span class="settings-panel-action-btn__label">
                    <LockKeyhole class="size-3 shrink-0 pointer-events-none" aria-hidden="true" />
                    CHANGE PASSWORD
                  </span>
                </div>
              </div>
            {/if}

            <div class="settings-panel-actions-reveal settings-panel-actions-reveal--open">
              <div class="settings-panel-actions-reveal__inner">
                <div class="settings-panel-actions">
                  <div class="settings-panel-action-btn settings-panel-action-btn--signout">
                    <span class="settings-panel-action-btn__label">
                      <LogOut class="size-3 shrink-0 pointer-events-none" aria-hidden="true" />
                      SIGN OUT
                    </span>
                  </div>
                  <div class="settings-panel-action-btn settings-panel-action-btn--delete">
                    <span class="settings-panel-action-btn__label">
                      <Trash2 class="size-3 shrink-0 pointer-events-none" aria-hidden="true" />
                      DELETE
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        {:else}
          <div class="flex justify-center py-1">
            <div class="boot-panel-avatar-spinner" aria-hidden="true"></div>
          </div>

          <div class="settings-panel-stats">
            <div class="settings-panel-header__identity boot-panel-placeholder" aria-hidden="true">
              <span class="settings-panel-header__name boot-panel-placeholder__ghost">account name</span>
              <span class="text-[10px] boot-panel-placeholder__ghost">joined Jan 2026</span>
              <span class="text-[10px] boot-panel-placeholder__ghost">Session: 1h 00m</span>
              <span class="settings-panel-header__user-id boot-panel-placeholder__ghost">00000000-0000-0000-0000-000000000000</span>
            </div>

            <div class="mt-1 mb-2 boot-panel-reveal-item boot-panel-reveal-item--chips" aria-hidden="true">
              <div class="text-[8px] uppercase tracking-[1px] text-zinc-500 text-center mb-1 boot-panel-placeholder__ghost">Data usage</div>
              <div class="grid grid-cols-3 gap-1 text-[9px] text-zinc-400">
                <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center boot-panel-placeholder">
                  <List class="size-3 shrink-0 boot-panel-placeholder__ghost" aria-hidden="true" />
                  <span class="leading-none boot-panel-placeholder__ghost">0 tpl</span>
                </span>
                <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center boot-panel-placeholder">
                  <Dumbbell class="size-3 shrink-0 boot-panel-placeholder__ghost" aria-hidden="true" />
                  <span class="leading-none boot-panel-placeholder__ghost">0 ex</span>
                </span>
                <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center boot-panel-placeholder">
                  <History class="size-3 shrink-0 boot-panel-placeholder__ghost" aria-hidden="true" />
                  <span class="leading-none boot-panel-placeholder__ghost">0 wrk logs</span>
                </span>
                <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center boot-panel-placeholder">
                  <BarChart3 class="size-3 shrink-0 boot-panel-placeholder__ghost" aria-hidden="true" />
                  <span class="leading-none boot-panel-placeholder__ghost">0 sts</span>
                </span>
                <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center boot-panel-placeholder">
                  <HardDrive class="size-3 shrink-0 boot-panel-placeholder__ghost" aria-hidden="true" />
                  <span class="leading-none boot-panel-placeholder__ghost">~0 B</span>
                </span>
                <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#1e1e1e] rounded border border-[#2a2a2a] justify-center boot-panel-placeholder">
                  <Pencil class="size-3 shrink-0 boot-panel-placeholder__ghost" aria-hidden="true" />
                  <span class="leading-none boot-panel-placeholder__ghost">0 sts logs</span>
                </span>
              </div>
            </div>
          </div>

          <div class="settings-panel-account" aria-hidden="true">
            <div class="settings-panel-password">
              <div
                class="settings-panel-action-btn settings-panel-action-btn--full settings-panel-action-btn--change-password boot-panel-placeholder"
              >
                <span class="settings-panel-action-btn__label boot-panel-placeholder__ghost">
                  <LockKeyhole class="size-3 shrink-0 pointer-events-none" aria-hidden="true" />
                  CHANGE PASSWORD
                </span>
              </div>
            </div>

            <div class="settings-panel-actions-reveal settings-panel-actions-reveal--open">
              <div class="settings-panel-actions-reveal__inner">
                <div class="settings-panel-actions">
                  <div class="settings-panel-action-btn settings-panel-action-btn--signout boot-panel-placeholder">
                    <span class="settings-panel-action-btn__label boot-panel-placeholder__ghost">
                      <LogOut class="size-3 shrink-0 pointer-events-none" aria-hidden="true" />
                      SIGN OUT
                    </span>
                  </div>
                  <div class="settings-panel-action-btn settings-panel-action-btn--delete boot-panel-placeholder">
                    <span class="settings-panel-action-btn__label boot-panel-placeholder__ghost">
                      <Trash2 class="size-3 shrink-0 pointer-events-none" aria-hidden="true" />
                      DELETE
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <p class="sr-only">{bootAccountReveal ? 'Account ready' : bootMessage}</p>
    </div>
  {/snippet}

  <div class="app-stage flex-1 flex flex-col min-h-0 w-full relative overflow-hidden">
  <div class="app-stage-scroll flex-1 min-h-0 flex flex-col overflow-hidden">
  <div
    class="app-stage-reveal app-stack-gap flex flex-col flex-1 min-h-0 w-full overflow-hidden"
    class:app-stage-reveal--active={stageRevealActive}
  >
  {#if currentUser}
  <div class="app-stage-sticky app-stack-gap shrink-0 flex flex-col">
  <!-- Week box: collapsible header + compact day strip -->
  <div
    class="week-calendar-swipe rounded-xl border border-[#1e1e1e] bg-[#141414] overflow-hidden"
    use:horizontalSwipe={{
      onSwipeLeft: goNextDay,
      onSwipeRight: goPrevDay,
      disabled: () => weekCalendarLocked,
    }}
  >
    <div class="flex items-center gap-2 min-h-8 px-2 py-1.5 border-b border-[#1e1e1e] bg-[#111] text-[10px] tracking-[1px]">
      <button
        type="button"
        title="Account and backend"
        aria-label="Account and backend"
        class="w-7 h-7 shrink-0 rounded bg-emerald-950/40 flex items-center justify-center hover:bg-emerald-900/40 transition"
        onclick={(e) => { e.stopPropagation(); openSettingsPanel(); }}
      >
        <GeneratedAvatar userId={currentUser.id} size={26} rounded={2} className="rounded" />
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
          <HeaderClock />
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
            {#each weekDayData as data (data.dayInfo.key)}
              {@const d = data.dayInfo}
              <button 
                class="day-btn aspect-square w-full flex flex-col items-center justify-center gap-0 rounded-md text-[10px] font-bold tracking-wide border-none bg-transparent text-zinc-600 hover:text-white relative origin-center {data.dynamicClasses}"
                onclick={() => selectDate(d.date)}
                disabled={workoutState === 'active'}
                title={DAY_NAMES[d.weekday] + ' ' + d.key}
              >
                <div class="flex flex-col items-center justify-center leading-none">
                  <span class="text-[8px] font-bold tracking-[1px] {data.isSelected ? 'opacity-100' : 'opacity-60'}">{d.letter}</span>
                  <span class="text-[11px] font-black tabular-nums leading-none">{d.num}</span>
                </div>
                {#if data.isSelected}
                  <span class="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-px bg-current rounded-full"></span>
                {/if}
                {#if data.dayHasWorkoutLog && !data.isSelected && !data.isRealToday}
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

  {#if ctaBarVisible}
    <div class="app-stage-cta shrink-0">
      {@render ctaBar(ctaBarEditorDisabled)}
    </div>
  {/if}
  </div>

  <div class="app-stage-body flex-1 min-h-0 flex flex-col overflow-hidden min-w-0">
  {#if currentView === 'track'}
    {@const isPast = selectedDateStr < REAL_TODAY_STR && !isViewingToday}
    {@const hasLog = !!viewedLog}
    {@const isRestLog = hasLog && viewedLog.workout_snapshot?.is_rest}

    <div class="track-view flex flex-col flex-1 min-h-0 overflow-hidden min-w-0">
    {#if isSelectedDayLogLoading}
      <div class="flex flex-col items-center justify-center py-16 px-2 text-center text-zinc-500">
        <RefreshCw class="size-5 animate-spin mb-3 opacity-70" aria-hidden="true" />
        <div class="text-[10px] uppercase tracking-[2px]">Loading day…</div>
      </div>
    {:else if isPastUnloggedWorkoutDay}
      <!-- UNLOGGED: past day with no saved log (incl. every day before account existed) -->
      <div class="flex flex-col items-center justify-center py-10 px-2 gap-6">
        <!-- Hero icon -->
        <div class="w-20 h-20 rounded-2xl bg-[#141414] border border-[#1e1e1e] flex items-center justify-center transition-all duration-200 hover:border-[#2a2a2a]">
          <FileX class="size-10 text-zinc-400" />
        </div>

        <div class="text-center">
          <div class="text-3xl font-semibold tracking-[-0.02em] text-white">UNLOGGED</div>
          <div class="text-[10px] uppercase tracking-[2px] text-zinc-500 mt-1">{unloggedHeroLine}</div>
        </div>

        <div class="app-hero-copy text-center text-sm text-zinc-400 leading-snug hover:text-zinc-300 transition-colors duration-200">
          Progress unlogged is progress lost.
        </div>

        <!-- Week overview — tap to open routine editor -->
        <button
          type="button"
          class="app-hero-panel rounded-xl border border-transparent p-1 -m-1 transition-all duration-150 hover:border-[#2a2a2a] hover:bg-[#141414]/50 cursor-pointer"
          onclick={() => enterRoutineBuilder({ fromWeeklyPlan: true })}
          title="Open routine editor"
        >
          <div class="text-[9px] uppercase tracking-[1.5px] text-zinc-500 mb-2 text-center pointer-events-none">WEEKLY PLAN</div>
          <div class="grid grid-cols-7 gap-1 pointer-events-none">
            {#each weekPlan as d, i}
              <div class="flex flex-col items-center gap-0.5 transition-all duration-150">
                <div class="text-[10px] font-medium {i === TODAY_WEEKDAY ? 'text-white' : 'text-zinc-400'}">{d.day}</div>
                <div
                  class="w-full aspect-square rounded-lg flex items-center justify-center transition-all duration-150 {d.color ? 'border' : 'bg-[#1e1e1e] border border-[#2a2a2a]'}"
                  style={d.color ? `background-color: color-mix(in srgb, ${d.color} 12%, #141414); border-color: ${d.color};` : ''}
                >
                  {#if d.hasTemplate}
                    <Dumbbell class="size-3" style={d.color ? `color: ${d.color}` : ''} />
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
      </div>
    {:else if templates.length === 0}
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

        {#if templateError}
          <p class="text-[10px] text-red-300 leading-snug">{templateError}</p>
        {/if}
        <button 
          type="button"
          class="app-hero-panel app-primary-cta rounded-xl font-sans font-black text-[11px] tracking-[0.15em] bg-white text-black border-2 border-transparent transition-all duration-150 hover:brightness-110 disabled:opacity-50 flex items-center justify-center"
          disabled={!currentUser}
          onclick={() => {
            if (workoutState === 'active') return;
            currentView = 'swap_template';
            templateError = null;
            templateErrorFading = false;
            editingRoutineTemplateNameId = null;
            routineTemplateNameEditOriginal = null;
            builderAssignments = {};
            builderEditingDay = selectedWeekday;
          }}>
          CREATE ROUTINE
        </button>
      </div>
    {:else if (isRestLog || isScheduledRestDay) && !hasViewedWorkoutLog}
      <!-- REST DAY: scheduled rest or logged rest — never when a real workout log exists -->
      <div class="flex flex-col items-center justify-center py-10 px-2 gap-6">
        <!-- Hero icon -->
        <div class="w-20 h-20 rounded-2xl bg-[#141414] border border-[#1e1e1e] flex items-center justify-center transition-all duration-200 hover:border-[#2a2a2a] {isFuture && !isRestLog ? 'opacity-80' : ''}">
          <Bed class="size-10 text-zinc-500" />
        </div>

        <div class="text-center {isFuture && !isRestLog ? 'opacity-80' : ''}">
          <div class="text-3xl font-semibold tracking-[-0.02em] text-white">REST DAY</div>
          <div class="text-[10px] uppercase tracking-[2px] text-zinc-500 mt-1">
            {isRestLog ? `LOGGED FOR ${selectedDayLabel}` : `NO TEMPLATE ASSIGNED FOR ${selectedDayLabel}`}
          </div>
        </div>

        <div class="app-hero-copy text-center text-sm text-zinc-400 leading-snug hover:text-zinc-300 transition-colors duration-200 {isFuture && !isRestLog ? 'opacity-80' : ''}">
          Recovery is where the gains happen. 
        </div>

        <!-- Week overview — tap to open routine editor (shown on rest days too for schedule context) -->
        <button
          type="button"
          class="app-hero-panel rounded-xl border border-transparent p-1 -m-1 transition-all duration-150 hover:border-[#2a2a2a] hover:bg-[#141414]/50 cursor-pointer"
          onclick={() => enterRoutineBuilder({ fromWeeklyPlan: true })}
          title="Open routine editor"
        >
          <div class="text-[9px] uppercase tracking-[1.5px] text-zinc-500 mb-2 text-center pointer-events-none">WEEKLY PLAN</div>
          <div class="grid grid-cols-7 gap-1 pointer-events-none">
            {#each weekPlan as d, i}
              <div class="flex flex-col items-center gap-0.5 transition-all duration-150">
                <div class="text-[10px] font-medium {i === TODAY_WEEKDAY ? 'text-white' : 'text-zinc-400'}">{d.day}</div>
                <div
                  class="w-full aspect-square rounded-lg flex items-center justify-center transition-all duration-150 {d.color ? 'border' : 'bg-[#1e1e1e] border border-[#2a2a2a]'}"
                  style={d.color ? `background-color: color-mix(in srgb, ${d.color} 12%, #141414); border-color: ${d.color};` : ''}
                >
                  {#if d.hasTemplate}
                    <Dumbbell class="size-3" style={d.color ? `color: ${d.color}` : ''} />
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

        {#if isRestLog}
          <div class="text-[10px] text-center text-zinc-500">This day was logged as a rest day. <button class="text-red-400 hover:text-red-500 underline" onclick={() => undoRestLog(selectedDateStr)}>undo</button></div>
        {/if}
      </div>
    {:else}
      <!-- Template box on main screen (supports historical past logged workouts even if current schedule has no template for the day, for edge cases like deleted templates) -->
      {@const useHistorical = isPast && viewedLog && !viewedLog.workout_snapshot?.is_rest && !logIsSkipped(viewedLog)}
      {@const skippedDisplayLog = isSkippedWorkoutView() ? (isViewingToday ? todayLog : viewedLog) : null}
      {@const skippedDisplayTemplate = skippedDisplayLog?.template_id
        ? templates.find((t) => t.id === skippedDisplayLog.template_id)
        : null}
      {@const dispTemplate = useHistorical
        ? { id: viewedLog.template_id, name: viewedLog.template_name_snapshot || 'Past Workout', color: 0, exercises: viewedLog.workout_snapshot?.exercises || [] }
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
      <div class="track-workout-shell app-stack-gap flex flex-col flex-1 min-h-0 overflow-hidden">
      <div class="track-workout-header app-stack-gap shrink-0 flex flex-col">
      {#if templateSaveError}
        <p class="text-[10px] text-red-300 leading-snug px-2.5 py-2 rounded-lg border border-red-900/50 bg-red-950/30">{templateSaveError}</p>
      {/if}
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
      </div>

      <!-- Exercises in one shared box separated by horizontal dividers, with list numbers on left (like editor list) -->
      <div
        class="track-workout-exercises flex-1 min-h-0 overflow-y-auto no-scrollbar"
        use:scrollEdgeFade
      >
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
                  <div class="weight-num font-7segment text-2xl leading-none {exRed ? 'text-current' : 'text-white'}">{displayCurrentWeight}<span class="unit text-[10px] font-sans font-normal ml-1 tracking-[1px] {exRed ? 'w-fg-skipped-muted' : 'text-zinc-400'}">KG</span></div>
                {:else}
                  <!-- Narrow baseline input (fits ~3 digits) in the KG position, right-aligned -->
                  <div class="flex items-baseline justify-end">
                    <input type="text" inputmode="decimal" autocomplete="off" placeholder="80" class="prop-num-input font-7segment text-2xl leading-none text-white bg-transparent border-none outline-none w-12 text-right"
                      disabled={!workoutExercisesEditable}
                      use:clampedNumericProp={{
                        kind: 'baseKg',
                        getValue: () => exercise.current_weight ?? 0,
                        setValue: () => {},
                      }}
                      onchange={(e) => {
                        const input = e.currentTarget as HTMLInputElement;
                        const { value } = clampBaseKgFieldInput(input.value);
                        saveExerciseBaselineOptimistic(exercise.id, value);
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
                <div class="time-readout font-7segment text-2xl {hasActiveTimerThis && isOvertime ? 'w-fg-green' : exRed ? 'text-current' : 'text-white'}">
                  {#if hasActiveTimerThis && isOvertime}
                    <Plus class="time-readout-plus fill-current" strokeWidth={2.5} />
                  {/if}
                  <span class="ex-time-digit">{formatTime(displaySecs)}</span>
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
                  {@const timerCubeCount = 42}
                  {@const timerMet = timeTotal > 0 && countdownSeconds >= timeTotal}
                  {@const rawDot = visualRawStep}
                  {@const cycle = timerCubeCount * 2}
                  {@const displayDot = timerMet
                    ? (() => {
                        let p = rawDot % cycle;
                        if (p >= timerCubeCount) p = cycle - p;
                        return Math.min(timerCubeCount - 1, p);
                      })()
                    : Math.min(timerCubeCount - 1, rawDot)}
                  {@const inReverse = timerMet && (rawDot % cycle >= timerCubeCount)}
                  {@const direction = inReverse ? -1 : 1}
                  <div class="time-active-bar">
                    <span class="time-active-set">S{s + 1}</span>
                    <div class="time-active-progress">
                      <div
                        class="timer-progress-cubes"
                        class:timer-progress-cubes--running={countdownRunning}
                        class:timer-progress-cubes--met={timerMet}
                        class:timer-progress-cubes--yellow={status === 'yellow' && !timerMet}
                      >
                        {#each Array(timerCubeCount) as _, i}
                          {@const isCurrent = i === displayDot}
                          {@const isPast = !isCurrent && (
                            direction > 0
                              ? i < displayDot
                              : i > displayDot ||
                                (displayDot === timerCubeCount - 1 && i < displayDot)
                          )}
                          {@const isTrail = i === displayDot - direction}
                          {@const isFuture = !isCurrent && !isPast && !isTrail}
                          <div
                            class="timer-progress-cube"
                            class:timer-progress-cube--past={isPast && !isTrail}
                            class:timer-progress-cube--trail={isTrail}
                            class:timer-progress-cube--future={isFuture}
                            class:timer-progress-cube--lit={isCurrent && !timerMet}
                            class:timer-progress-cube--met={timerMet && isCurrent}
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
                            <span class="sv text-[11px] font-extrabold block text-current leading-none tabular-nums">{saved ? saved.result : '—'}</span>
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
      </div>
    {/if}
    </div>

  {:else if currentView === 'swap_template'}
    <!-- Routine editor: assign templates to full SMTWTFS week -->
    <div class="bg-[#141414] border border-[#1e1e1e] rounded-xl p-3 space-y-3 flex-1 min-h-0 overflow-y-auto no-scrollbar">
      <div class="flex items-center gap-2 border-b border-[#1e1e1e] pb-2 min-h-8">
        <button
          type="button"
          class="w-8 h-8 shrink-0 rounded-lg border border-[#1e1e1e] bg-transparent text-white flex items-center justify-center"
          title="Go back"
          onclick={() => void exitRoutineEditor()}
          disabled={editorExitSaving}
        >
          <ArrowLeft class="size-4" />
        </button>
        <span class="text-xs font-bold tracking-wider text-zinc-400 leading-none shrink-0">ROUTINE EDITOR</span>
        <div class="flex-1 min-w-0 flex items-center">
          <span
            class="w-full h-8 flex items-center justify-center px-2 rounded border border-[#2a2a2a] bg-black text-xs font-medium truncate leading-none text-center text-white"
          >{builderDayAssignmentLabel}</span>
        </div>
      </div>

      <div class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none text-center">CLICK DAY TO ASSIGN</div>
      <div class="grid grid-cols-7 gap-1">
        {#each DAYS as d, i}
          {@const hasTemplate = !!effectiveAssignmentTemplateId(builderAssignments[i] ?? null)}
          {@const dayAssignedId = effectiveAssignmentTemplateId(builderAssignments[i] ?? null)}
          {@const dayTpl = dayAssignedId ? templates.find((t) => t.id === dayAssignedId) : null}
          {@const dayColor = dayTpl ? getTemplateColor(dayTpl.color ?? 0) : null}
          {@const isDaySelected = builderEditingDay === i}
          {@const iconStyle = isDaySelected && dayColor ? `color: color-mix(in srgb, ${dayColor} 20%, black)` : 'color: black'}
          <button
            type="button"
            class="flex flex-col items-center gap-0.5 transition-all duration-150"
            onclick={() => { builderEditingDay = i; }}
          >
            <div class="text-[10px] font-medium leading-none {isDaySelected ? 'text-white' : 'text-zinc-400'}">{d}</div>
            <div
              class="w-full aspect-square rounded-lg flex items-center justify-center transition-all duration-150 {isDaySelected ? (dayColor ? '' : 'bg-white') : (dayColor ? '' : 'border border-[#2a2a2a] hover:border-[#3a3a3a]')} {isDaySelected ? '' : 'scale-90'}"
              style={dayColor ? `background-color: ${dayColor};` : isDaySelected ? 'background-color: white;' : ''}
            >
              {#if hasTemplate}
                <Dumbbell class={isDaySelected ? 'size-4' : 'size-3'} strokeWidth={2.5} style={iconStyle} />
              {:else}
                <Bed class={isDaySelected ? 'size-4 text-black' : 'size-3 text-zinc-500'} />
              {/if}
            </div>
          </button>
        {/each}
      </div>

      <div class="space-y-1.5">
        <div class="flex items-baseline gap-1 min-h-[10px]">
          <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">
            TEMPLATES{#if templateError}<span class="ml-2 text-red-400 normal-case tracking-normal transition-opacity duration-200 {templateErrorFading ? 'opacity-0' : 'opacity-100'}">{templateError}</span>{/if}
          </span>
        </div>
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
            {@const isEmpty = template.exercises.length === 0}
            {@const rawSelectedId = builderAssignments[builderEditingDay] ?? null}
            {@const isSelected = rawSelectedId === template.id}
            {@const isRealAssigned = builderAssignedTemplateId === template.id}
            {@const tColor = getTemplateColor(template.color ?? 0)}
            <div
              class="flex items-stretch gap-1 h-8"
              ondragover={handleTemplateDragOver}
              ondrop={(e) => handleTemplateDrop(e, index)}
            >
              <button
                type="button"
                draggable="true"
                class="w-6 h-8 shrink-0 flex items-center justify-center border rounded text-[10px] font-medium leading-none cursor-grab active:cursor-grabbing transition-colors {isSelected ? '' : 'bg-[#141414] border-[#1e1e1e] text-zinc-400 hover:border-[#2a2a2a] hover:text-zinc-200'}"
                style={isSelected ? `background-color: color-mix(in srgb, white 15%, #141414); border-color: white; color: white;` : ''}
                title="Drag to reorder — click to select"
                onclick={() => {
                  if (templateRowDragged) return;
                  assignTemplateToBuilderDay(template.id);
                }}
                ondragstart={(e) => handleTemplateDragStart(e, index)}
                ondragend={handleTemplateDragEnd}
              >
                {index + 1}
              </button>
              <div
                class="flex-1 h-8 min-w-0 px-1.5 border rounded text-xs flex items-center transition-colors cursor-pointer hover:bg-[#1a1a1a] {isSelected ? '' : 'bg-[#0d0d0d] border-[#1e1e1e] hover:bg-[#141414] hover:border-[#2a2a2a]'}"
                style={isSelected ? `background-color: color-mix(in srgb, white 10%, #0d0d0d); border-color: white; color: white;` : ''}
                role="button"
                tabindex="0"
                onclick={() => assignTemplateToBuilderDay(template.id)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); assignTemplateToBuilderDay(template.id); } }}
              >
                <div class="flex items-center gap-1 min-w-0 flex-1">
                  {#if editingRoutineTemplateNameId === template.id}
                    <span class="shrink-0" style={isSelected ? `color: white` : `color: #aaa`}>[</span>
                    <input
                      type="text"
                      autocomplete="off"
                      use:focusExerciseNameInput
                      use:clampedTemplateNameProp={{
                        getValue: () => template.name,
                        setValue: (v) => { template.name = v; },
                      }}
                      onclick={(e) => e.stopPropagation()}
                      oninput={() => scheduleTemplateNamePersist(template.id, template.name)}
                      onblur={() => commitRoutineTemplateNameEdit(template)}
                      onkeydown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter' || e.key === 'Escape') {
                          e.preventDefault();
                          (e.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      class="font-medium bg-transparent border-0 p-0 m-0 focus:outline-none focus:ring-0 text-xs uppercase flex-1 min-w-0 truncate leading-none"
                      style={isSelected ? `color: white` : `color: #aaa`}
                    />
                    <span class="shrink-0" style={isSelected ? `color: white` : `color: #aaa`}>]</span>
                  {:else}
                    <span
                      class="font-medium truncate leading-none flex-1 min-w-0 select-none"
                      style={isSelected ? `color: white` : `color: #aaa`}
                      ondblclick={(e) => {
                        e.stopPropagation();
                        beginRoutineTemplateNameEdit(template.id);
                      }}
                    >[ {template.name} ]</span>
                  {/if}
                  {#if !isEmpty}
                    {@const exCount = template.exercises.length}
                    <span class="text-[9px] shrink-0 px-1.5 py-0.5 rounded border leading-none" style={isSelected ? `background-color: color-mix(in srgb, white 20%, #1e1e1e); border-color: white; color: white;` : `background-color: #1e1e1e; border-color: #2a2a2a; color: #aaa;`}>{exCount} EXERCISE{exCount === 1 ? '' : 'S'}</span>
                  {/if}
                  {#if isRealAssigned}
                    <span class="text-[9px] shrink-0 px-1.5 py-0.5 rounded border leading-none" style={isSelected ? `background-color: color-mix(in srgb, white 20%, #1e1e1e); border-color: white; color: white;` : `background-color: #1e1e1e; border-color: #2a2a2a; color: #aaa;`}>ASSIGNED</span>
                  {:else if isEmpty}
                    <span class="text-[9px] shrink-0 px-1.5 py-0.5 rounded border leading-none" style={isSelected ? `background-color: color-mix(in srgb, white 20%, #1e1e1e); border-color: white; color: white;` : `background-color: #1e1e1e; border-color: #2a2a2a; color: #aaa;`}>EMPTY</span>
                  {/if}
                  {#if isSelected}
                    <button
                      type="button"
                      class="w-6 h-6 shrink-0 flex items-center justify-center rounded border transition-colors"
                      style={`background-color: color-mix(in srgb, white 20%, #1e1e1e); color: white; border-color: white;`}
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

  {:else if currentView === 'stats'}
    <div class="bg-[#141414] border border-[#1e1e1e] rounded-xl p-3 space-y-3 flex-1 min-h-0 overflow-y-auto no-scrollbar">
      <div class="flex items-center gap-2 border-b border-[#1e1e1e] pb-2 min-h-8">
        <button
          type="button"
          class="w-8 h-8 shrink-0 rounded-lg border border-[#1e1e1e] bg-transparent text-white flex items-center justify-center"
          title="Go back"
          onclick={exitStatsView}
        >
          <ArrowLeft class="size-4" />
        </button>
        <span class="flex-1 text-xs font-bold tracking-wider text-zinc-400 leading-none">STATS</span>
        <button
          type="button"
          class="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center border border-[#1e1e1e] bg-transparent text-zinc-400 hover:bg-[#1a1a1a] hover:text-white"
          onclick={openStatsEditor}
          title="Edit stats"
        >
          <Pencil class="size-4" />
        </button>
      </div>

      {#if trackedStats.length === 0 && statHistoryGroups.length === 0}
        <div class="text-center py-6 space-y-3">
          <div class="text-xs text-zinc-500">No stats defined yet.</div>
          <button
            type="button"
            class="h-8 px-3 bg-[#141414] border border-[#1e1e1e] text-xs font-bold rounded hover:border-[#2a2a2a]"
            onclick={openStatsEditor}
          >
            CREATE STATS
          </button>
        </div>
      {:else}
        {#if trackedStats.length > 0}
          <div class="flex flex-col gap-1 min-w-0">
            {#each trackedStats as stat (stat.id)}
              <div class="flex items-stretch gap-1 h-8 min-w-0">
                <div class="flex-1 min-w-0 h-8 px-1.5 border border-[#1e1e1e] rounded bg-[#0d0d0d] text-xs flex items-center">
                  <span class="font-medium truncate leading-none text-zinc-300">{stat.name}</span>
                </div>
                <input
                  type="text"
                  inputmode="decimal"
                  autocomplete="off"
                  placeholder={String(stat.start_value || 0)}
                  class="prop-num-input w-[4.5rem] shrink-0 h-8 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none"
                  use:clampedNumericProp={{
                    kind: 'statLog',
                    getValue: () => getStatTodayInputValue(stat.id),
                    setValue: (v) => { setStatTodayInputDraft(stat.id, v); },
                  }}
                  onblur={() => persistStatTodayLog(stat.id)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                  }}
                />
                {#if stat.unit}
                  <span class="shrink-0 h-8 flex items-center text-[10px] font-medium uppercase text-zinc-400">{stat.unit}</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        {#if statHistoryGroups.length > 0}
          <div class="space-y-2 {trackedStats.length > 0 ? 'pt-2 border-t border-[#1e1e1e]' : ''}">
            <div class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none text-center">History</div>
            {#each statHistoryGroups as group (group.statId)}
              <div class="space-y-1">
                <div class="flex items-center gap-1 min-w-0 px-0.5">
                  <span class="text-[10px] font-medium uppercase truncate text-zinc-400">{group.name}</span>
                  {#if group.unit}
                    <span class="text-[9px] uppercase text-zinc-600 shrink-0">{group.unit}</span>
                  {/if}
                  {#if !group.isActive}
                    <span class="text-[8px] uppercase tracking-[0.08em] text-zinc-600 shrink-0">archived</span>
                  {/if}
                </div>
                <div class="border border-[#1e1e1e] rounded overflow-hidden text-xs">
                  {#each group.entries as entry (entry.date)}
                    <div class="flex items-center border-b border-[#1e1e1e] last:border-b-0 bg-[#0d0d0d] hover:bg-[#141414]">
                      <div class="w-24 px-2 py-1 font-mono text-zinc-400 border-r border-[#1e1e1e] text-[10px]">{entry.date}</div>
                      <input
                        type="text"
                        inputmode="decimal"
                        autocomplete="off"
                        class="prop-num-input flex-1 bg-transparent px-2 py-1 text-right text-white outline-none text-xs"
                        use:clampedNumericProp={{
                          kind: 'statLog',
                          getValue: () => statLogs[group.statId]?.[entry.date] ?? 0,
                          setValue: (v) => {
                            const prev = statLogs[group.statId] ?? {};
                            statLogs = {
                              ...statLogs,
                              [group.statId]: { ...prev, [entry.date]: v },
                            };
                          },
                        }}
                        onblur={() =>
                          persistStatLogEntry(
                            group.statId,
                            entry.date,
                            statLogs[group.statId]?.[entry.date] ?? 0,
                          )}
                        onkeydown={(e) => {
                          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                        }}
                      />
                      {#if group.unit}
                        <span class="px-2 text-[9px] uppercase text-zinc-500 shrink-0">{group.unit}</span>
                      {/if}
                      <button
                        type="button"
                        class="px-2 py-1 text-red-400 hover:text-red-300 text-[10px] font-bold"
                        onclick={() => deleteStatLogEntry(group.statId, entry.date)}
                        title="Delete entry"
                      >×</button>
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>

  {:else if currentView === 'edit_stats'}
    <div class="bg-[#141414] border border-[#1e1e1e] rounded-xl p-3 space-y-3 flex-1 min-h-0 overflow-y-auto no-scrollbar">
      <div class="flex items-center gap-2 border-b border-[#1e1e1e] pb-2 min-h-8">
        <button
          type="button"
          class="w-8 h-8 shrink-0 rounded-lg border border-[#1e1e1e] bg-transparent text-white flex items-center justify-center"
          onclick={() => void exitStatsEditor()}
          disabled={editorExitSaving}
          title="Go back"
        >
          <ArrowLeft class="size-4" />
        </button>
      </div>
      {#if statSaveError}
        <p class="text-[10px] text-red-300 leading-snug">{statSaveError}</p>
      {/if}

      <div class="space-y-1.5">
        <div class="builder-editor-grid">
          <div class="col-start-1 row-start-1 h-5 flex items-center">
            <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">STATS</span>
          </div>
          <div class="col-start-2 row-start-1 h-5 flex items-center border-l border-[#1e1e1e] pl-2">
            <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">PROPERTIES</span>
          </div>

          <div class="col-start-1 row-start-2 flex flex-col min-h-0 min-w-0 self-stretch">
            <div class="flex flex-col gap-1 min-w-0 flex-1 min-h-0">
              {#if draftStats.length === 0}
                <div class="text-center py-3 border border-dashed border-[#1e1e1e] rounded text-[10px] text-zinc-500">
                  No stats yet.<br />
                  Tap NEW to create one.
                </div>
              {/if}
              {#each draftStats as stat, index (stat.id)}
                {@const isSelected = selectedDraftStatId === stat.id}
                <div
                  class="flex items-stretch gap-1 h-8"
                  ondragover={handleStatDragOver}
                  ondrop={(e) => handleStatDrop(e, index)}
                >
                  <button
                    type="button"
                    draggable="true"
                    class="w-6 h-8 shrink-0 flex items-center justify-center border rounded text-[10px] font-medium leading-none cursor-grab active:cursor-grabbing transition-colors {isSelected ? '' : 'bg-[#141414] border-[#1e1e1e] text-zinc-400 hover:border-[#2a2a2a] hover:text-zinc-200'}"
                    style={isSelected ? `background-color: color-mix(in srgb, white 15%, #141414); border-color: white; color: white` : ''}
                    title="Drag to reorder — click to select"
                    onclick={() => {
                      if (statRowDragged) return;
                      selectDraftStat(stat.id);
                    }}
                    ondragstart={(e) => handleStatDragStart(e, index)}
                    ondragend={handleStatDragEnd}
                  >
                    {index + 1}
                  </button>
                  <div
                    class="flex-1 h-8 min-w-0 px-1.5 border rounded text-xs flex items-center cursor-pointer transition-colors {isSelected ? '' : 'bg-[#0d0d0d] border-[#1e1e1e] hover:bg-[#141414] hover:border-[#2a2a2a]'}"
                    style={isSelected ? `background-color: color-mix(in srgb, white 8%, #0d0d0d); border-color: white; color: white` : ''}
                    onclick={() => selectDraftStat(stat.id)}
                  >
                    <div class="flex items-center gap-1 min-w-0 flex-1">
                      <BarChart3 class="size-3 shrink-0" style={isSelected ? 'color: white' : 'color: #aaa'} />
                      {#if editingStatNameId === stat.id}
                        <input
                          type="text"
                          autocomplete="off"
                          use:focusExerciseNameInput
                          use:clampedStatNameProp={{
                            getValue: () => stat.name,
                            setValue: (v) => { patchDraftStat(stat.id, { name: v }); },
                          }}
                          onclick={(e) => e.stopPropagation()}
                          onblur={endStatNameEdit}
                          onkeydown={(e) => {
                            if (e.key === 'Enter' || e.key === 'Escape') {
                              e.preventDefault();
                              (e.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          class="font-medium bg-transparent border-0 p-0 m-0 focus:outline-none focus:ring-0 text-xs uppercase flex-1 min-w-0 truncate leading-none {isSelected ? 'text-white' : 'text-zinc-400'}"
                          placeholder="NAME"
                        />
                      {:else}
                        <span
                          class="font-medium text-xs flex-1 min-w-0 truncate leading-none select-none {isSelected ? 'text-white' : 'text-zinc-400'}"
                          ondblclick={(e) => {
                            e.stopPropagation();
                            beginStatNameEdit(stat.id);
                          }}
                        >{stat.name || 'Name'}</span>
                      {/if}
                      {#if isSelected}
                        <button
                          type="button"
                          class="w-6 h-6 shrink-0 flex items-center justify-center rounded border border-red-900/80 bg-red-950/50 text-red-400 hover:text-red-300 hover:border-red-800 transition-colors"
                          title="Delete stat"
                          onclick={(e) => { e.stopPropagation(); deleteSelectedStat(); }}
                        >
                          <Trash2 class="size-3 pointer-events-none" />
                        </button>
                      {/if}
                    </div>
                  </div>
                </div>
              {/each}
            </div>

            <div class="library-actions mt-1.5">
              <button
                type="button"
                class="library-action-btn library-action-btn--new"
                disabled={draftStats.length >= MAX_STATS}
                onclick={addNewStat}
                title="Create a new stat"
                aria-label="Create new stat"
              >
                <Plus class="size-3.5" strokeWidth={3} />
                <span>NEW</span>
              </button>
            </div>
          </div>

          <div class="col-start-2 row-start-2 flex flex-col min-h-0 self-stretch border-l border-[#1e1e1e] pl-2">
            <div class="flex-1 flex flex-col min-h-0 h-full">
              {#if selectedDraftStatId}
                {#key selectedDraftStatId}
                  {@const statId = selectedDraftStatId}
                  {@const stat = draftStatById(statId)}
                  {#if stat}
                    {@const hasTarget = !!draftStatById(statId)?.has_target}
                    <div class="grid grid-cols-[minmax(0,1.55fr)_minmax(0,0.85fr)] gap-x-1 gap-y-2 text-[9px]">
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Start</span>
                        <input
                          type="text"
                          inputmode="decimal"
                          autocomplete="off"
                          placeholder="0"
                          class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none"
                          use:clampedNumericProp={{
                            kind: 'statValue',
                            getValue: () => draftStatById(statId)?.start_value ?? 0,
                            setValue: (v) => { patchDraftStat(statId, { start_value: v }); },
                          }}
                          onblur={() => void persistTrackedStatsNow()}
                        />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Unit</span>
                        <input
                          type="text"
                          autocomplete="off"
                          placeholder="KG"
                          class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none uppercase"
                          use:clampedStatUnitProp={{
                            getValue: () => draftStatById(statId)?.unit ?? '',
                            setValue: (v) => { patchDraftStat(statId, { unit: v }); },
                          }}
                          onblur={() => void persistTrackedStatsNow()}
                        />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Target</span>
                        <input
                          type="text"
                          inputmode="decimal"
                          autocomplete="off"
                          placeholder="—"
                          disabled={!hasTarget}
                          class="prop-num-input w-full h-7 border text-center text-xs rounded outline-none transition-colors {hasTarget ? 'bg-black border-[#1e1e1e] text-white' : 'bg-[#0a0a0a] border-[#1a1a1a] text-zinc-600 cursor-not-allowed opacity-70'}"
                          use:clampedNumericProp={{
                            kind: 'statValue',
                            getValue: () => draftStatById(statId)?.target_value ?? 0,
                            setValue: (v) => {
                              patchDraftStat(statId, { target_value: v > 0 ? v : 1 });
                            },
                          }}
                          onblur={() => void persistTrackedStatsNow()}
                        />
                      </div>
                      <div class="flex items-end">
                        <div
                          class="relative grid grid-cols-2 w-full rounded border border-[#1e1e1e] bg-[#0a0a0a] p-0.5"
                          role="group"
                          aria-label="Target enabled"
                        >
                          <div
                            class="pointer-events-none absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-4px)] rounded bg-white transition-transform duration-200 ease-out"
                            style="transform: translateX({hasTarget ? 'calc(100% + 4px)' : '0'})"
                          ></div>
                          <button
                            type="button"
                            class="relative z-10 h-7 flex items-center justify-center text-[8px] font-black tracking-[0.1em] transition-colors {!hasTarget ? 'text-black' : 'text-zinc-500 hover:text-zinc-300'}"
                            onclick={() => {
                              patchDraftStat(statId, { has_target: false, target_value: null });
                              void persistTrackedStatsNow();
                            }}
                          >OFF</button>
                          <button
                            type="button"
                            class="relative z-10 h-7 flex items-center justify-center text-[8px] font-black tracking-[0.1em] transition-colors {hasTarget ? 'text-black' : 'text-zinc-500 hover:text-zinc-300'}"
                            onclick={() => {
                              const current = draftStatById(statId);
                              const nextTarget =
                                (current?.target_value ?? 0) > 0
                                  ? current?.target_value
                                  : (current?.start_value ?? 0) > 0
                                    ? current?.start_value
                                    : 1;
                              patchDraftStat(statId, {
                                has_target: true,
                                target_value: nextTarget ?? 1,
                              });
                              void persistTrackedStatsNow();
                            }}
                          >ON</button>
                        </div>
                      </div>
                    </div>
                  {/if}
                {/key}
              {:else}
                <div class="flex-1 min-h-0 flex items-center justify-center text-center px-1 text-[9px] leading-snug text-zinc-500 border border-dashed border-[#1e1e1e] rounded">Select a stat to edit.</div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </div>

  {:else if currentView === 'edit_template'}
    {@const templateEditorColor = getTemplateColor(draftTemplateColor)}
    <div class="bg-[#141414] border border-[#1e1e1e] rounded-xl p-3 space-y-3 flex-1 min-h-0 overflow-y-auto no-scrollbar">
      <div class="flex items-center gap-2 border-b border-[#1e1e1e] pb-2 min-h-8">
        <button
          type="button"
          class="w-8 h-8 shrink-0 rounded-lg border border-[#1e1e1e] bg-transparent text-white flex items-center justify-center"
          onclick={() => void exitEditTemplate()}
          disabled={editorExitSaving}
          title="Go back"
        >
          <ArrowLeft class="size-4" />
        </button>
        <span class="text-xs font-bold tracking-wider text-zinc-400 leading-none shrink-0">TEMPLATE EDITOR</span>
        <div class="flex-1 min-w-0 flex items-center">
          <input
            autocomplete="off"
            class="w-full h-8 bg-black border text-xs font-medium uppercase text-center px-2 rounded outline-none placeholder:text-zinc-600"
            style={`border-color: ${templateEditorColor}; color: ${templateEditorColor}`}
            placeholder="Template name"
            disabled={!editingTemplate}
            use:clampedTemplateNameProp={{
              getValue: () => draftTemplateName,
              setValue: (v) => { draftTemplateName = v; },
            }}
            oninput={() => scheduleTemplateNamePersist(editingTemplateId, draftTemplateName)}
            onblur={() => persistTemplateNameNow()}
          />
        </div>
        <button
          type="button"
          class="w-8 h-8 rounded bg-black border flex items-center justify-center transition-all group"
          style="border-color: {templateEditorColor}"
          onclick={() => {
            draftTemplateColor = (draftTemplateColor + 1) % 5;
            void persistTemplateColorNow();
          }}
          title="Click to cycle template color"
        >
          <div class="w-5 h-5 rounded transition-all group-active:scale-95" style="background-color: {templateEditorColor}"></div>
        </button>
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
        <div class="builder-editor-grid">
          <div class="col-start-1 row-start-1 h-5 flex items-center">
            <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">EXERCISES</span>
          </div>
          <div class="col-start-2 row-start-1 h-5 flex items-center border-l border-[#1e1e1e] pl-2">
            <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">PROPERTIES</span>
          </div>

          <div class="col-start-1 row-start-2 flex flex-col min-h-0 min-w-0 self-stretch">
            <div class="flex flex-col gap-1 min-w-0 flex-1 min-h-0">
              {#if draftExercises.length === 0}
                <div class="text-center py-3 border border-dashed border-[#1e1e1e] rounded text-[10px] text-zinc-500">
                  No exercises yet.<br />
                  {#if libraryExercisesAvailable.length > 0}
                    Tap NEW to create one, or LIBRARY to pick from exercises you've already made.
                  {:else}
                    Tap NEW to create a new exercise.
                  {/if}
                </div>
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
                    class="w-6 h-8 shrink-0 flex items-center justify-center border rounded text-[10px] font-medium leading-none cursor-grab active:cursor-grabbing transition-colors {isSelected ? '' : 'bg-[#141414] border-[#1e1e1e] text-zinc-400 hover:border-[#2a2a2a] hover:text-zinc-200'}"
                    style={isSelected ? `background-color: color-mix(in srgb, white 15%, #141414); border-color: white; color: white` : ''}
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
                    class="flex-1 h-8 min-w-0 px-1.5 border rounded text-xs flex items-center cursor-pointer transition-colors {isSelected ? '' : 'bg-[#0d0d0d] border-[#1e1e1e] hover:bg-[#141414] hover:border-[#2a2a2a]'}"
                    style={isSelected ? `background-color: color-mix(in srgb, white 8%, #0d0d0d); border-color: white; color: white` : ''}
                    onclick={() => selectExercise(exercise.id)}
                  >
                    <div class="flex items-center gap-1 min-w-0 flex-1">
                      {#if exercise.exercise_type === 'reps'}
                        <Dumbbell class="size-3 shrink-0" style={isSelected ? 'color: white' : 'color: #aaa'} />
                      {:else}
                        <Timer class="size-3 shrink-0" style={isSelected ? 'color: white' : 'color: #aaa'} />
                      {/if}
                      {#if editingExerciseNameId === exercise.id}
                        <input
                          type="text"
                          autocomplete="off"
                          use:focusExerciseNameInput
                          use:clampedExerciseNameProp={{
                            getValue: () => exercise.name,
                            setValue: (v) => { exercise.name = v; markDraftTouched(); },
                          }}
                          onclick={(e) => e.stopPropagation()}
                          onblur={endExerciseNameEdit}
                          onkeydown={(e) => {
                            if (e.key === 'Enter' || e.key === 'Escape') {
                              e.preventDefault();
                              (e.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          class="font-medium bg-transparent border-0 p-0 m-0 focus:outline-none focus:ring-0 text-xs uppercase flex-1 min-w-0 truncate leading-none {isSelected ? 'text-white' : 'text-zinc-400'}"
                          placeholder="NAME"
                        />
                      {:else}
                        <span
                          class="font-medium text-xs flex-1 min-w-0 truncate leading-none select-none {isSelected ? 'text-white' : 'text-zinc-400'}"
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
                          title="Remove from template"
                          onclick={(e) => { e.stopPropagation(); deleteSelectedExercise(); }}
                        >
                          <Minus class="size-3 pointer-events-none" />
                        </button>
                      {/if}
                    </div>
                  </div>
                </div>
              {/each}
            </div>

            <div
              class="library-actions mt-1.5"
              class:library-actions--with-library={showLibraryButton}
            >
              <button
                type="button"
                class="library-action-btn library-action-btn--new"
                onclick={addNewExercise}
                title="Create a brand new exercise definition"
                aria-label="Create new exercise"
              >
                <Plus class="size-3.5" strokeWidth={3} />
                <span>NEW</span>
              </button>
              <div class="library-action-slot min-w-0 overflow-hidden">
                <button
                  type="button"
                  class="library-action-btn library-action-btn--library {showExerciseLibraryPicker ? 'library-action-btn--library-active' : ''}"
                  class:library-action-btn--library-visible={showLibraryButton}
                  onclick={toggleExerciseLibraryPicker}
                  title="Pick from exercises you have already created (reuses the same exercise row for progressive overload across templates)"
                  aria-label="Add from your exercises"
                  aria-expanded={showExerciseLibraryPicker}
                  aria-hidden={!showLibraryButton}
                  tabindex={showLibraryButton ? 0 : -1}
                >
                  <List class="size-3.5" strokeWidth={2.5} />
                  <span>LIBRARY</span>
                </button>
              </div>
            </div>

            <div
              class="library-picker-panel"
              class:library-picker-panel--open={showExerciseLibraryPicker && !libraryPickerClosing}
            >
              <div class="library-picker-panel__inner {(showExerciseLibraryPicker && !libraryPickerClosing) ? '' : 'pointer-events-none'}">
                <div class="mt-1.5 rounded border border-[#1e1e1e] bg-[#0d0d0d] p-1.5 space-y-1 max-h-48 overflow-y-auto no-scrollbar">
                  {#if availableLibraryForPicker.length === 0}
                    <p class="text-[10px] text-zinc-500 px-0.5 py-1 leading-snug">
                      {exerciseLibrary.length === 0
                        ? 'No saved exercises yet. Create one with NEW.'
                        : 'All your exercises are already in this template.'}
                    </p>
                  {:else}
                    {#each availableLibraryForPicker as libraryEx (libraryEx.id)}
                      {@const isReps = libraryEx.exercise_type === 'reps'}
                      {@const isSelectedLib = selectedLibraryExerciseId === libraryEx.id}
                      {@const summary = isReps
                        ? `${libraryEx.target_sets || 0}×${libraryEx.target_reps || 0}`
                        : `${libraryEx.target_sets || 0}× ${libraryEx.target_minutes || 0}m${String(libraryEx.target_seconds || 0).padStart(2, '0')}s`}
                      {@const weight = isReps && libraryEx.current_weight != null ? ` · ${libraryEx.current_weight}kg` : ''}
                      <div
                        class="w-full h-7 min-w-0 px-1.5 rounded border text-xs transition flex items-center gap-1.5 cursor-pointer {isSelectedLib 
                          ? 'bg-[#1e1e1e] border-[#2a2a2a] text-zinc-200' 
                          : 'bg-[#141414] border-[#1e1e1e] text-zinc-500 hover:bg-[#1a1a1a] hover:border-[#2a2a2a] hover:text-zinc-400'}"
                        onclick={() => selectLibraryExercise(libraryEx.id)}
                        title={isSelectedLib ? '' : 'Select to move or delete'}
                      >
                        <div class="flex items-center gap-1.5 flex-1 min-w-0">
                          {#if isReps}
                            <Dumbbell class="size-3 shrink-0 text-zinc-400" />
                          {:else}
                            <Timer class="size-3 shrink-0 text-zinc-400" />
                          {/if}
                          <span class="truncate leading-none text-left font-medium">{libraryEx.name}</span>
                          <span class="ml-auto text-[10px] text-zinc-500 tabular-nums shrink-0">{summary}{weight}</span>
                        </div>
                        {#if isSelectedLib}
                          <button
                            type="button"
                            class="w-5 h-5 shrink-0 flex items-center justify-center rounded border border-[#2a2a2a] bg-[#1e1e1e] text-zinc-400 hover:text-white hover:border-[#3a3a3a] transition-colors"
                            onclick={(e) => { e.stopPropagation(); moveLibraryExerciseToTemplate(libraryEx); }}
                            title="Move into this template"
                          >
                            <ChevronUp class="size-3 pointer-events-none" />
                          </button>
                          <button
                            type="button"
                            class="w-5 h-5 shrink-0 flex items-center justify-center rounded border border-red-900/70 bg-red-950/40 text-red-400 hover:text-red-300 hover:border-red-800 transition-colors"
                            onclick={(e) => { e.stopPropagation(); deleteLibraryExercise(libraryEx); }}
                            title="Delete from library (removes from all templates)"
                          >
                            <Trash2 class="size-3 pointer-events-none" />
                          </button>
                        {/if}
                      </div>
                    {/each}
                  {/if}
                </div>
              </div>
            </div>
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
                        <input type="text" inputmode="numeric" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'sets', getValue: () => ex.target_sets, setValue: (v) => { ex.target_sets = v; markDraftTouched(); } }} onblur={() => void persistTemplateExercisesNow()} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Reps</span>
                        <input type="text" inputmode="numeric" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'reps', getValue: () => ex.target_reps, setValue: (v) => { ex.target_reps = v; markDraftTouched(); } }} onblur={() => void persistTemplateExercisesNow()} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Base kg</span>
                        <input type="text" inputmode="decimal" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'baseKg', getValue: () => ex.current_weight ?? 0, setValue: (v) => { ex.current_weight = v; markDraftTouched(); } }} onblur={() => void persistTemplateExercisesNow()} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">+ kg</span>
                        <input type="text" inputmode="decimal" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'incKg', getValue: () => ex.increment, setValue: (v) => { ex.increment = v; markDraftTouched(); } }} onblur={() => void persistTemplateExercisesNow()} />
                      </div>
                    </div>
                  {:else}
                    <div class="grid grid-cols-2 gap-1 text-[9px]">
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Sets</span>
                        <input type="text" inputmode="numeric" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'sets', getValue: () => ex.target_sets, setValue: (v) => { ex.target_sets = v; markDraftTouched(); } }} onblur={() => void persistTemplateExercisesNow()} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Min</span>
                        <input type="text" inputmode="numeric" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'mins', getValue: () => ex.target_minutes, setValue: (v) => { ex.target_minutes = v; markDraftTouched(); } }} onblur={() => void persistTemplateExercisesNow()} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">Sec</span>
                        <input type="text" inputmode="numeric" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'secs', getValue: () => ex.target_seconds, setValue: (v) => { ex.target_seconds = v; markDraftTouched(); } }} onblur={() => void persistTemplateExercisesNow()} />
                      </div>
                      <div>
                        <span class="text-zinc-500 block mb-0.5 leading-none">+ s</span>
                        <input type="text" inputmode="numeric" autocomplete="off" class="prop-num-input w-full h-7 bg-black border border-[#1e1e1e] text-center text-xs rounded text-white outline-none" use:clampedNumericProp={{ kind: 'incSec', getValue: () => ex.increment, setValue: (v) => { ex.increment = v; markDraftTouched(); } }} onblur={() => void persistTemplateExercisesNow()} />
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
  </div>
  {:else if !bootOverlayVisible}
    <div class="flex flex-1 flex-col items-center justify-center pt-0 pb-10 px-2 gap-6 text-center min-h-0 -translate-y-6">
      <div class="w-20 h-20 rounded-2xl bg-[#141414] border border-[#1e1e1e] flex items-center justify-center transition-all duration-200 hover:border-[#2a2a2a]">
        <Dumbbell class="size-10 text-zinc-400" />
      </div>

      <div class="text-center">
        <div class="text-6xl font-black tracking-[8px] text-white">LIFT</div>
        <div class="text-2xl font-light tracking-[6px] text-zinc-300 -mt-3">TRACKER</div>
        <div class="text-[10px] tracking-[2px] text-emerald-400/70 mt-1">v{APP_VERSION}</div>
      </div>

      <div class="auth-panel-card rounded-xl border border-[#1e1e1e] bg-[#141414] overflow-hidden">
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

  <div class="app-footer flex items-baseline justify-center gap-x-1 text-center text-[9px] tracking-[0.5px] text-zinc-500 shrink-0 leading-none">
    <a
      href="https://github.com/Kono-o/lift-tracker"
      target="_blank"
      rel="noopener noreferrer"
      class="hover:text-zinc-300 active:text-white transition-colors"
      title="Click to visit the Lift Tracker GitHub repo. Ctrl+click (or Cmd+click) the left side for the update demo, right side for the post-update demo."
    >
      <span
        class="cursor-pointer hover:text-zinc-300 active:text-white transition-colors"
        onclick={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopPropagation(); manuallyOpenUpdateMenu(); } }}
      >
        LIFT-TRACKER v{APP_VERSION}
      </span>
      <span class="text-zinc-500 select-none">—</span>
      <span
        class="cursor-pointer hover:text-zinc-300 active:text-white transition-colors"
        onclick={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopPropagation(); manuallyOpenPostUpdateMenu(); } }}
      >
        All rights reserved by Arya.
      </span>
    </a>
  </div>

</div>
