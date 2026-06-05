<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { db, supabase, type Template, type Exercise } from '$lib/db';
  import {
    ArrowLeft,
    Bed,
    CalendarDays,
    ChevronLeft,
    ChevronRight,
    Dumbbell,
    FileX,
    GripVertical,
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
    Trash2
  } from '@lucide/svelte';

  // Constants
  const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function toDateStr(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const REAL_TODAY = new Date();
  REAL_TODAY.setHours(0, 0, 0, 0);
  const REAL_TODAY_STR = toDateStr(REAL_TODAY);
  const TODAY_WEEKDAY = REAL_TODAY.getDay();

  let nowStr = $state('');

  function updateClock() {
    const now = new Date();
    const day = now.getDate().toString().padStart(2, '0');
    const monthNames = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const month = monthNames[now.getMonth()];
    const year = now.getFullYear().toString().slice(-2);
    const h = now.getHours().toString().padStart(2, '0');
    const m = now.getMinutes().toString().padStart(2, '0');
    const s = now.getSeconds().toString().padStart(2, '0');
    // sci-fi HUD style with spaced date + <HH:MM:SS> time
    nowStr = `D ${day} ${month} Y ${year}  <${h}:${m}:${s}>`;
  }

  updateClock();

  // State
  let selectedDate = $state(new Date(REAL_TODAY));
  let viewedLog = $state<any>(null);
  let weekLogs = $state<Record<string, any | null>>({});
  let currentView = $state<'track' | 'swap_template' | 'edit_template'>('track');

  let weekInfo = $derived.by(() => {
    const d = selectedDate;
    const mons = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const mon = mons[d.getMonth()];
    const yr = d.getFullYear();
    const start = new Date(yr, 0, 1);
    const weekNum = Math.ceil( ((d.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7 );
    return `${mon} ${yr} • WEEK ${weekNum}`;
  });

  let selectedDateDisplay = $derived.by(() => {
    const ud = selectedDate;
    const umons = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const nice = `${ud.getDate()} ${umons[ud.getMonth()]} ${ud.getFullYear()}`;
    const sci = `D ${String(ud.getDate()).padStart(2,'0')} ${umons[ud.getMonth()]} Y ${String(ud.getFullYear()).slice(-2)}`;
    return { nice, sci };
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
  let isLoading = $state(true);

  function enterRoutineBuilder() {
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
  let workoutState = $state<'idle' | 'active' | 'done' | 'skipped'>('idle');
  let justFinishedStatus = $state<'green' | 'yellow' | null>(null);

  // Data arrays
  let schedule = $state<any[]>([]);
  let templates = $state<Template[]>([]);
  let todayLog = $state<any>(null);

  let setCounts = $derived.by(() => {
    if (!activeTemplate) return { total: 0, done: 0, green: 0 };
    let total = 0;
    let done = 0;
    let green = 0;
    for (const ex of activeTemplate.exercises) {
      total += ex.target_sets || 0;
      if (isViewingToday) {
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
      } else if (viewedLog?.workout_snapshot?.exercises) {
        const loggedEx = viewedLog.workout_snapshot.exercises.find((e: any) => e.id === ex.id);
        if (loggedEx) {
          const sets = ex.target_sets || 0;
          if (ex.exercise_type === 'reps' || loggedEx.performed_sets) {
            const target = ex.target_reps || 0;
            const performed: (number | null)[] = loggedEx.performed_sets || [];
            for (let s = 0; s < sets; s++) {
              const val = performed[s];
              if (val != null) {
                done++;
                if (val >= target) green++;
              }
            }
          } else if (loggedEx.performed_times) {
            const tMin = ex.target_minutes || 0;
            const tSec = ex.target_seconds || 0;
            const target = tMin * 60 + tSec;
            const performed: (string | null)[] = loggedEx.performed_times || [];
            for (let s = 0; s < sets; s++) {
              const res = performed[s];
              if (res) {
                done++;
                const m = res.match(/(\d+)m(\d+)s/);
                if (m) {
                  const secs = parseInt(m[1]) * 60 + parseInt(m[2]);
                  if (secs >= target) green++;
                }
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
    if (sessionStatus === 'green') return '#4ade80';
    if (sessionStatus === 'yellow') return '#e0990b';
    return '#ffffff';
  });

  let todayCompletionStatus = $derived.by(() => {
    if (!todayLog) return 'neutral';
    if (todayLog.is_skipped) return 'skipped';
    const snap = todayLog.workout_snapshot;
    if (!snap?.exercises?.length) return 'yellow';
    let totalSets = 0;
    let greenSets = 0;
    let doneSets = 0;
    for (const ex of snap.exercises) {
      const sets = ex.target_sets || 0;
      totalSets += sets;
      if (ex.exercise_type === 'reps' || ex.performed_sets) {
        const target = ex.target_reps || 0;
        const performed: (number | null)[] = ex.performed_sets || [];
        for (let s = 0; s < sets; s++) {
          const val = performed[s];
          if (val != null) {
            doneSets++;
            if (val >= target) greenSets++;
          }
        }
      } else if (ex.exercise_type === 'time' || ex.performed_times) {
        const tMin = ex.target_minutes || 0;
        const tSec = ex.target_seconds || 0;
        const target = tMin * 60 + tSec;
        const performed: (string | null)[] = ex.performed_times || [];
        for (let s = 0; s < sets; s++) {
          const res = performed[s];
          if (res) {
            doneSets++;
            const m = res.match(/(\d+)m(\d+)s/);
            if (m) {
              const secs = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
              if (secs >= target) greenSets++;
            }
          }
        }
      }
    }
    if (totalSets > 0 && greenSets === totalSets) return 'green';
    return 'yellow'; // any finished non-skipped (incl. 0 logged sets / black workouts) -> yellow for button/day
  });

  // Timers and Clocks
  let workoutDuration = $state(0);
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

  // Skip button hold progress
  let skipHoldTimer: any = null;
  let skipProgress = $state(0);

  // Hold-to-confirm for cancel and deletes (like skip)
  let cancelHoldTimer: any = null;
  let cancelProgress = $state(0);
  let deleteTemplateHoldTimer: any = null;
  let deleteTemplateProgress = $state(0);
  let eraseHoldTimer: any = null;
  let eraseProgress = $state(0);

  // Form fields for creation/editing
  let newTemplateName = $state('');

  // Draft state for template editing (local until commit on finish)
  let draftExercises = $state<any[]>([]);
  let draftTemplateName = $state('');
  let selectedExerciseId = $state<string | null>(null);

  // Svelte 5 Derived State
  let selectedDateStr = $derived(toDateStr(selectedDate));
  let selectedWeekday = $derived(selectedDate.getDay());
  let currentDaySchedule = $derived(schedule.find(s => s.day_of_week === selectedWeekday));
  let activeTemplate = $derived(templates.find(t => t.id === currentDaySchedule?.template_id) || null);
  let isViewingToday = $derived(selectedDateStr === REAL_TODAY_STR);
  let isFuture = $derived(selectedDateStr > REAL_TODAY_STR);
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
  let weekPlan = $derived(schedule.map((s, i) => ({
    day: DAYS[i],
    hasTemplate: !!s.template_id
  })));
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
    const mShort = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][selectedDate.getMonth()];
    return `${selectedDate.getDate()} ${mShort} — ${DAY_NAMES[selectedWeekday].toUpperCase()}'S`;
  });

  let viewedCompletionStatus = $derived.by(() => {
    const log = viewedLog;
    if (!log) return 'neutral';
    if (log.is_skipped) return 'skipped';
    const snap = log.workout_snapshot;
    if (!snap?.exercises?.length) return 'yellow';
    let totalSets = 0;
    let greenSets = 0;
    let doneSets = 0;
    for (const ex of snap.exercises) {
      const sets = ex.target_sets || 0;
      totalSets += sets;
      if (ex.exercise_type === 'reps' || ex.performed_sets) {
        const target = ex.target_reps || 0;
        const performed: (number | null)[] = ex.performed_sets || [];
        for (let s = 0; s < sets; s++) {
          const val = performed[s];
          if (val != null) {
            doneSets++;
            if (val >= target) greenSets++;
          }
        }
      } else if (ex.exercise_type === 'time' || ex.performed_times) {
        const tMin = ex.target_minutes || 0;
        const tSec = ex.target_seconds || 0;
        const target = tMin * 60 + tSec;
        const performed: (string | null)[] = ex.performed_times || [];
        for (let s = 0; s < sets; s++) {
          const res = performed[s];
          if (res) {
            doneSets++;
            const m = res.match(/(\d+)m(\d+)s/);
            if (m) {
              const secs = parseInt(m[1]) * 60 + parseInt(m[2]);
              if (secs >= target) greenSets++;
            }
          }
        }
      }
    }
    if (totalSets === 0) return 'yellow';
    if (greenSets === totalSets) return 'green';
    if (doneSets > 0) return 'yellow';
    return 'neutral';
  });

  // Load viewedLog whenever selected date changes (for past/future history)
  $effect(() => {
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

  // Initialize draft when entering template editor; clear otherwise
  $effect(() => {
    if (currentView === 'edit_template' && activeTemplate) {
      draftExercises = activeTemplate.exercises.map((e) => ({ ...e }));
      draftTemplateName = activeTemplate.name;
      selectedExerciseId = null;
      resetNewExerciseForm();
    } else if (currentView !== 'edit_template') {
      if (draftExercises.length > 0 || selectedExerciseId || draftTemplateName) {
        draftExercises = [];
        draftTemplateName = '';
        selectedExerciseId = null;
      }
    }
  });

  function formatTime(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  function getExerciseStatus(exercise: Exercise) {
    if (isViewingToday) {
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
      
      if (loggedSetsCount === exercise.target_sets && allRepsMetTarget) return 'green';
      if (loggedSetsCount > 0) return 'yellow';
      return 'neutral';
    } else if (viewedLog?.workout_snapshot?.exercises) {
      const logged = viewedLog.workout_snapshot.exercises.find((e: any) => e.id === exercise.id);
      if (!logged) return 'neutral';
      const sets = exercise.target_sets || 0;
      let exDone = 0;
      let exGreen = 0;
      if (exercise.exercise_type === 'reps') {
        const performed: (number | null)[] = logged.performed_sets || [];
        for (let s = 0; s < sets; s++) {
          const v = performed[s];
          if (v != null) {
            exDone++;
            if (v >= (exercise.target_reps || 0)) exGreen++;
          }
        }
      } else {
        const performed: (string | null)[] = logged.performed_times || [];
        const tgt = (exercise.target_minutes || 0) * 60 + (exercise.target_seconds || 0);
        for (let s = 0; s < sets; s++) {
          const r = performed[s];
          if (r) {
            exDone++;
            const m = r.match(/(\d+)m(\d+)s/);
            if (m && (parseInt(m[1]) * 60 + parseInt(m[2])) >= tgt) exGreen++;
          }
        }
      }
      if (exGreen === sets && sets > 0) return 'green';
      if (exDone > 0) return 'yellow';
      return 'neutral';
    }
    return 'neutral';
  }

  function getSetBubbleStatus(exerciseId: string, setIndex: number, targetReps?: number) {
    const key = `${exerciseId}-${setIndex}`;
    if (isViewingToday) {
      if (targetReps !== undefined) {
        // reps
        const reps = trackedReps[key];
        if (reps === undefined || reps === null) return 'empty';
        if (reps >= targetReps) return 'green';
        return 'yellow';
      } else {
        // time
        const t = completedTimers[key];
        if (!t) return 'empty';
        return t.met ? 'green' : 'yellow';
      }
    } else if (viewedLog?.workout_snapshot?.exercises) {
      const loggedEx = viewedLog.workout_snapshot.exercises.find((e: any) => e.id === exerciseId);
      if (!loggedEx) return 'empty';
      if (targetReps !== undefined) {
        const performed: (number | null)[] = loggedEx.performed_sets || [];
        const val = performed[setIndex];
        if (val == null) return 'empty';
        if (val >= (targetReps || 0)) return 'green';
        return 'yellow';
      } else {
        const performed: (string | null)[] = loggedEx.performed_times || [];
        const res = performed[setIndex];
        if (!res) return 'empty';
        return 'green';
      }
    }
    return 'empty';
  }

 async function loadData(options: { preserveSession?: boolean } = {}) {
		const isInitial = !hasInitialLoad;
		if (isInitial) {
			isLoading = true;
		} else {
			isSyncing = true;
		}
		try {
			const data = await db.getAppData();
			schedule = data.schedule;
			templates = data.templates;
			todayLog = data.todayLog || null;
			if (!options.preserveSession) {
				if (!todayLog) {
					workoutState = 'idle';
				} else if (todayLog.is_skipped) {
					workoutState = 'skipped';
				} else {
					workoutState = 'done';
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
    loadData(); 
    updateClock();
    const clockInterval = setInterval(updateClock, 50);
    return () => clearInterval(clockInterval);
  });
  onDestroy(() => { clearInterval(workoutTimer); clearInterval(countdownTimer); });

  function startWorkout() {
    if (!isViewingToday || workoutState === 'done' || workoutState === 'skipped') return;
    workoutState = 'active'; 
    trackedReps = {}; 
    completedTimers = {}; 
    workoutDuration = 0;
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
  }

  function cancelWorkout() {
    workoutState = 'idle'; 
    trackedReps = {}; 
    completedTimers = {};
    clearInterval(workoutTimer); 
    clearInterval(countdownTimer);
    workoutDuration = 0; 
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

async function finishWorkout() {
	console.log("finish clicked");

	if (!activeTemplate) {
		console.log("no template");
		return;
	}

	try {
		console.log("submitting");

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
		justFinishedStatus = null;

		const snapshot = {
			reps: { ...trackedReps },
			times: { ...completedTimers },
			workoutDuration
		};

		console.log({
			templateId: activeTemplate.id,
			exercises: activeTemplate.exercises,
			snapshot
		});

		await db.submitWorkoutSession(
	activeTemplate,
	snapshot,
	workoutDuration
);
		console.log("submitted");

		// Compute the just-finished status from the snapshot we submitted (using current template targets).
		// This lets us show the correct button color (green for perfect, yellow for black/partial/0-sets)
		// *immediately* on click, without waiting for loadData() + todayLog update.
		// Prevents the yellow flash on perfect days.
		let justFinished: 'green' | 'yellow' = 'yellow';
		if (activeTemplate) {
			let total = 0;
			let green = 0;
			let done = 0;
			for (const ex of activeTemplate.exercises) {
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
			if (total > 0 && green === total) {
				justFinished = 'green';
			} else if (done === 0) {
				justFinished = 'yellow'; // black workout (0 logged sets) -> yellow
			}
			// otherwise partial -> yellow
		}

		workoutState = 'done';
		justFinishedStatus = justFinished;

		await loadData();
		justFinishedStatus = null;
	}
	catch(err) {
		console.error(err);
	}
}

  function handleSetBubbleClick(exerciseId: string, setIndex: number, targetReps: number) {
    if (workoutState !== 'active') return;
    const key = `${exerciseId}-${setIndex}`;
    const currentReps = trackedReps[key];
    
    if (currentReps === undefined) {
      trackedReps[key] = targetReps;
    } else {
      editingSetKey = key;
      tick().then(() => {
        const inputEl = document.getElementById(`input-${key}`) as HTMLInputElement;
        if (inputEl) { inputEl.focus(); inputEl.select(); }
      });
    }
  }

  function saveManualRepEdit(exerciseId: string, setIndex: number) {
    const key = `${exerciseId}-${setIndex}`;
    const inputEl = document.getElementById(`input-${key}`) as HTMLInputElement;
    if (inputEl) {
      const value = parseInt(inputEl.value);
      if (!isNaN(value) && value >= 0) trackedReps[key] = value;
      else if (inputEl.value === '') delete trackedReps[key];
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
  }

  function cancelActiveTimer() {
    clearInterval(countdownTimer);
    countdownRunning = false;
    activeTimerExerciseId = null;
    activeTimerSetIndex = null;
    countdownSeconds = 0;
  }

  function startSkipHold(e: Event) {
    if (e.cancelable) e.preventDefault();
    if (workoutState !== 'idle' || !isViewingToday) return;
    let startTime = Date.now();
    
    skipHoldTimer = setInterval(async () => {
      skipProgress = Math.min(((Date.now() - startTime) / 1000) * 100, 100);
      if (skipProgress >= 100) {
        clearInterval(skipHoldTimer);
        workoutState = 'skipped';
        justFinishedStatus = null;
        await db.skipWorkout(activeTemplate?.id || null, activeTemplate?.name || null);
        await loadData();
      }
    }, 20);
  }

  function stopSkipHold() { clearInterval(skipHoldTimer); skipProgress = 0; }

  function startCancelHold(e: Event) {
    if (e.cancelable) e.preventDefault();
    if (workoutState !== 'active') return;
    let startTime = Date.now();
    cancelHoldTimer = setInterval(() => {
      cancelProgress = Math.min(((Date.now() - startTime) / 1000) * 100, 100);
      if (cancelProgress >= 100) {
        clearInterval(cancelHoldTimer);
        cancelProgress = 0;
        cancelWorkout();
      }
    }, 20);
  }
  function stopCancelHold() { clearInterval(cancelHoldTimer); cancelProgress = 0; }

  function startDeleteTemplateHold(e: Event) {
    if (e.cancelable) e.preventDefault();
    if (!activeTemplate) return;
    let startTime = Date.now();
    deleteTemplateHoldTimer = setInterval(() => {
      deleteTemplateProgress = Math.min(((Date.now() - startTime) / 1000) * 100, 100);
      if (deleteTemplateProgress >= 100) {
        clearInterval(deleteTemplateHoldTimer);
        deleteTemplateProgress = 0;
        // perform delete without confirm
        db.deleteTemplate(activeTemplate.id).then(() => {
          loadData();
          currentView = 'track';
        });
      }
    }, 20);
  }
  function stopDeleteTemplateHold() { clearInterval(deleteTemplateHoldTimer); deleteTemplateProgress = 0; }

  function startEraseHold(e: Event) {
    if (e.cancelable) e.preventDefault();
    if (!isViewingToday || (workoutState !== 'done' && workoutState !== 'skipped')) return;
    let startTime = Date.now();
    eraseHoldTimer = setInterval(() => {
      eraseProgress = Math.min(((Date.now() - startTime) / 1000) * 100, 100);
      if (eraseProgress >= 100) {
        clearInterval(eraseHoldTimer);
        eraseProgress = 0;
        eraseWorkoutLog();
      }
    }, 20);
  }
  function stopEraseHold() { clearInterval(eraseHoldTimer); eraseProgress = 0; }

  async function eraseWorkoutLog() {
    try {
      await db.deleteWorkoutLog();
      trackedReps = {};
      completedTimers = {};
      justFinishedStatus = null;
      await loadData();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleCreateTemplate() {
    if (!newTemplateName.trim()) return;
    const template = await db.createTemplate(newTemplateName);
    if (template) { 
      const wd = (currentView === 'swap_template' ? builderEditingDay : selectedWeekday) ?? 0;
      await db.assignTemplateToDay(wd, template.id); 
      newTemplateName = ''; 
      await loadData(); 
      // set selected to a day of this wd so edit shows the newly assigned/created
      const rep = new Date(REAL_TODAY);
      rep.setDate(rep.getDate() - rep.getDay() + wd);
      selectedDate = rep;
      currentView = 'edit_template'; 
    }
  }

  function resetNewExerciseForm() {
    // No-op: the exercise editor no longer uses a separate new* buffer (edits are direct on draft items).
    // Kept for any legacy call sites on view exit etc.
  }

  async function commitDraftExercises(overrideExercises?: any[], overrideName?: string) {
    if (!activeTemplate) return;
    const templateId = activeTemplate.id;
    // Snapshot draft at commit time (before any view/state clear)
    const currentDraftExercises = overrideExercises ?? [...draftExercises];
    const currentDraftTemplateName = overrideName ?? draftTemplateName;

    // Update name if changed (rename)
    if (currentDraftTemplateName && currentDraftTemplateName.trim() && currentDraftTemplateName.trim() !== activeTemplate.name) {
      try {
        await supabase.from('templates').update({ name: currentDraftTemplateName.trim() }).eq('id', templateId);
      } catch (err) {
        console.error('template name update err', err);
      }
    }

    // Full replace of exercises for this template: delete all, re-insert current draft list.
    // This is idiomatic + simple (no id tracking, handles create/edit/delete/reorder uniformly).
    // Safe because workout logs snapshot exercise data at finish time; exercise rows are just current defs.
    try {
      await supabase.from('exercises').delete().eq('template_id', templateId);
    } catch (err) {
      console.error('exercises replace delete', err);
    }

    // Parallel inserts for speed (was sequential loop before; helps back-arrow responsiveness)
    if (currentDraftExercises.length > 0) {
      const insertPromises = currentDraftExercises.map(async (d: any, i: number) => {
        const insertData = {
          template_id: templateId,
          name: d.name,
          exercise_type: d.exercise_type,
          target_sets: d.target_sets,
          target_reps: d.target_reps || 0,
          target_minutes: d.target_minutes || 0,
          target_seconds: d.target_seconds || 0,
          increment: d.increment || 0,
          current_weight: d.current_weight ?? null,
          display_order: i,
        };
        try {
          await supabase.from('exercises').insert(insertData);
        } catch (err) {
          console.error('exercises replace insert', err);
        }
      });
      await Promise.all(insertPromises);
    }

    await loadData();
  }

  async function exitEditTemplate() {
    // Snapshot so we can clear + switch the view *immediately* for responsiveness.
    // The actual DB work + loadData happens async; main view will refresh shortly (isSyncing may show).
    const snapExercises = [...draftExercises];
    const snapName = draftTemplateName;

    currentView = 'track';
    draftExercises = [];
    draftTemplateName = '';
    selectedExerciseId = null;

    // fire the (now faster, parallelized) commit without blocking the UI switch
    commitDraftExercises(snapExercises, snapName).catch((err) => {
      console.error('template commit on back failed', err);
      // best effort refresh
      loadData().catch(() => {});
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
    selectedExerciseId = id;
    if (!id) {
      resetNewExerciseForm();
    }
    // No population of new* buffer anymore — the properties form reads/mutates the exercise object directly.
    // This eliminates the burst of effect runs + re-renders on select.
  }

  function addNewExercise() {
    if (!activeTemplate) return;
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
      template_id: activeTemplate.id,
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

<div class="app max-w-md mx-auto min-h-screen select-none text-white bg-[#0a0a0a] p-4 flex flex-col gap-3 font-sans">
  
  <div class="flex items-center justify-between text-xs tracking-[2px] mb-0.5 font-bold px-1">
    <div>
      <span class="tracking-[3px]">LIFT</span><span class="font-semibold tracking-[1px] text-zinc-400">TRACKER</span><span class="ml-1 text-[9px] font-bold tracking-[1px] text-zinc-400">v0.0.1</span>
    </div>
    <div class="text-[10px] font-bold text-zinc-400 tabular-nums text-right tracking-[1px]">
      {nowStr}
    </div>
  </div>

  <!-- Week box: single rounded container, arrows easier, info header inside top -->
  <div class="rounded-xl border border-[#1e1e1e] bg-[#141414] overflow-hidden">
    <!-- top inside info: month + week num -->
    <div class="text-center text-[8px] tracking-[1.5px] text-zinc-500 py-0.5 border-b border-[#1e1e1e] bg-[#111]">
      {weekInfo}
    </div>
    <div class="flex items-center">
      <button 
        class="h-12 w-6 flex-shrink-0 flex items-center justify-center bg-[#141414] border-r border-[#1e1e1e] text-zinc-400 hover:text-white active:bg-[#1a1a1a] active:scale-95 transition disabled:opacity-40"
        onclick={goPrevWeek}
        title="Previous week"
        disabled={workoutState === 'active'}
      >
        <ChevronLeft class="size-4" />
      </button>
      <div class="day-strip grid grid-cols-7 gap-1 flex-1 bg-[#141414] p-1.5">
        {#each currentWeekDates as dayInfo}
          {@const isSelected = dayInfo.key === selectedDateStr}
          {@const isRealToday = dayInfo.isRealToday}
          {@const daySchedule = schedule[dayInfo.weekday]}
          {@const hasTemplate = !!daySchedule?.template_id}
          {@const isRest = !hasTemplate}
          {@const dayLog = isRealToday ? todayLog : (weekLogs[dayInfo.key] ?? null)}
          {@const dayHasLog = !!dayLog}
          {@const dayDone = isRealToday ? (workoutState === 'done') : false}
          {@const daySkipped = isRealToday ? (workoutState === 'skipped') : !!dayLog?.is_skipped}
          {@const effStatus = isRealToday ? (justFinishedStatus ?? todayCompletionStatus) : viewedCompletionStatus}
          <button 
            class="day-btn h-12 flex flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-bold tracking-wide transition-all duration-150 border-none bg-transparent text-zinc-600 hover:text-white active:scale-[0.98] relative
              {(dayDone || (isSelected && !isRealToday && viewedLog && viewedCompletionStatus !== 'neutral' && viewedCompletionStatus !== 'skipped')) ? (effStatus === 'green' ? '!bg-[#14532d] !text-[#4ade80]' : '!bg-[#3f2a00] !text-[#fbbf24]') : ''} 
              {daySkipped ? '!bg-[#451a03] !text-amber-500' : ''} 
              {(isSelected && !isRealToday && !dayDone && !daySkipped && !(viewedLog && viewedCompletionStatus !== 'neutral')) ? '!bg-[#1e1e1e] !text-white' : ''} 
              {isRealToday && !dayDone && !daySkipped ? '!bg-white !text-black hover:!text-black' : ''} 
              {isRest && !isSelected && !dayDone && !daySkipped ? 'text-zinc-500' : ''}"
            onclick={() => selectDate(dayInfo.date)}
            disabled={workoutState === 'active'}
            title={DAY_NAMES[dayInfo.weekday] + ' ' + dayInfo.key}
          >
            <div class="flex flex-col items-center justify-center leading-[0.9]">
              <span class="text-[9px] font-bold tracking-[1.5px] {isSelected ? 'opacity-100' : 'opacity-60'}">{dayInfo.letter}</span>
              <span class="text-[13px] font-black tabular-nums leading-none">{dayInfo.num}</span>
            </div>
            {#if isSelected}
              <span class="absolute -bottom-[1px] left-1/2 -translate-x-1/2 w-1.5 h-[1.5px] bg-current rounded-full transition-all duration-150"></span>
            {/if}
            {#if dayHasLog && !isSelected && !isRealToday}
              <span class="absolute -bottom-[1px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#fbbf24] opacity-60"></span>
            {/if}
          </button>
        {/each}
      </div>
      <button 
        class="h-12 w-6 flex-shrink-0 flex items-center justify-center bg-[#141414] border-l border-[#1e1e1e] text-zinc-400 hover:text-white active:bg-[#1a1a1a] active:scale-95 transition disabled:opacity-40"
        onclick={goNextWeek}
        title="Next week"
        disabled={workoutState === 'active'}
      >
        <ChevronRight class="size-4" />
      </button>
    </div>
  </div>

  {#snippet ctaBar(disabled = false)}
    <div class={(disabled && isViewingToday) ? 'opacity-40 pointer-events-none' : ''}>
      {#if workoutState === 'idle' || workoutState === 'active' || workoutState === 'done' || workoutState === 'skipped'}
        <div class="grid grid-cols-5 gap-3">
          <!-- WEIGHT dummy (left, narrow) -- grayed when not today -->
          <button class="col-span-1 h-[52px] rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-[#141414] !text-zinc-500 border border-[#1e1e1e] !cursor-default hover:brightness-125 {!isViewingToday ? 'opacity-40' : ''}">
            WEIGHT
          </button>

          {#if workoutState === 'idle'}
            <!-- Center: START WORKOUT (wider) or GO TO TODAY when on non-today -->
            {#if isViewingToday}
              <button class="col-span-3 h-[52px] border-none rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-white text-black transition-all duration-150 hover:brightness-110 active:scale-95 group" onclick={startWorkout}>
                <span class="transition-all group-hover:tracking-[0.2em]">START WORKOUT</span>
              </button>
            {:else}
              <button class="col-span-3 h-[52px] border-none rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-white text-black transition-all duration-150 hover:brightness-110 active:scale-95 group !opacity-100" onclick={goToToday}>
                <span class="transition-all group-hover:tracking-[0.2em]">GO TO TODAY</span>
              </button>
            {/if}
            <!-- Right: SKIP (hold, narrow) -- grayed when not today -->
            <button class="col-span-1 h-[52px] border {skipProgress > 0 ? 'border-amber-500' : 'border-[#1e1e1e]'} rounded-xl bg-[#0d0d0d] font-sans font-black text-[11px] tracking-[0.15em] {skipProgress > 0 ? 'text-[#fbbf24]' : 'text-zinc-500'} flex items-center justify-center relative overflow-hidden transition-all duration-150 hover:brightness-110 {!isViewingToday ? 'opacity-40 pointer-events-none' : ''}"
              onmousedown={startSkipHold} onmouseup={stopSkipHold} onmouseleave={stopSkipHold} ontouchstart={startSkipHold} ontouchend={stopSkipHold}>
              <div class="absolute inset-0 bg-amber-900/40 transition-all duration-[20ms]" style="width: {skipProgress}%;"></div>
              <span class="relative z-10">SKIP</span>
            </button>
          {:else if workoutState === 'active'}
            <!-- Center: FINISH (wider) -->
            {@const mins = Math.floor(workoutDuration / 60).toString().padStart(2, '0')}
            {@const secs = (workoutDuration % 60).toString().padStart(2, '0')}
            {@const isPerfectFinish = isPerfectDay}
            <button class="col-span-3 h-[52px] border-none rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center {isPerfectFinish ? 'bg-[#4ade80] text-black' : 'bg-[#fbbf24] text-black'} transition-all duration-150 hover:brightness-110 active:scale-[0.98] group {!isViewingToday ? 'opacity-40 pointer-events-none' : ''}" onclick={finishWorkout}>
              <div class="flex items-center justify-between w-full px-6 transition-transform duration-200">
                <div class="pl-2 text-[20px] font-black tracking-tighter group-hover:tracking-tighter group-hover:-translate-x-1 transition-all">
                  {mins}<span class="text-[10px]">m</span>
                </div>
                <div class="text-[12px] tracking-[0.15em] transition-all group-hover:tracking-[0.2em]">FINISH</div>
                <div class="pr-2 text-[20px] font-black tracking-tighter group-hover:tracking-tighter group-hover:translate-x-1 transition-all">
                  {secs}<span class="text-[10px]">s</span>
                </div>
              </div>
            </button>
            <!-- Right: CANCEL (hold, narrow) -->
            <button class="col-span-1 h-[52px] border {cancelProgress > 0 ? 'border-red-500' : 'border-[#1e1e1e]'} rounded-xl bg-[#0d0d0d] font-sans font-black text-[11px] tracking-[0.15em] {cancelProgress > 0 ? 'text-[#f87171]' : 'text-zinc-500'} flex items-center justify-center relative overflow-hidden transition-all duration-150 hover:brightness-110 {!isViewingToday ? 'opacity-40 pointer-events-none' : ''}"
              onmousedown={startCancelHold} onmouseup={stopCancelHold} onmouseleave={stopCancelHold} ontouchstart={startCancelHold} ontouchend={stopCancelHold}>
              <div class="absolute inset-0 bg-red-900/50 transition-all duration-[20ms]" style="width: {cancelProgress}%;"></div>
              <span class="relative z-10">CANCEL</span>
            </button>
          {:else if workoutState === 'done'}
            <!-- Center: WORKOUT COMPLETE (wider) -->
            {@const effectiveStatus = justFinishedStatus ?? todayCompletionStatus}
            {@const isYellowComplete = effectiveStatus === 'yellow' || effectiveStatus === 'neutral'}
            <button class="col-span-3 h-[52px] border {isYellowComplete ? 'border-[#fbbf24]' : 'border-[#4ade80]'} rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center {isYellowComplete ? 'bg-[#3f2a00] text-[#fbbf24]' : 'bg-[#14532d] text-[#4ade80]'} cursor-default transition-all duration-150 hover:brightness-110 group {!isViewingToday ? 'opacity-40 pointer-events-none' : ''}">
              <span class="transition-all group-hover:tracking-[0.2em]">WORKOUT COMPLETE</span>
            </button>
            <!-- Right: ERASE (hold to delete day's log) -->
            <button class="col-span-1 h-[52px] rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-[#141414] border {eraseProgress > 0 ? 'border-red-500' : 'border-[#1e1e1e]'} {eraseProgress > 0 ? 'text-[#f87171]' : '!text-zinc-500'} !cursor-default relative overflow-hidden transition-all duration-150 hover:brightness-110 {!isViewingToday ? 'opacity-40 pointer-events-none' : ''}"
              onmousedown={startEraseHold} onmouseup={stopEraseHold} onmouseleave={stopEraseHold} ontouchstart={startEraseHold} ontouchend={stopEraseHold}>
              <div class="absolute inset-0 bg-red-900/50 transition-all duration-[20ms]" style="width: {eraseProgress}%;"></div>
              <span class="relative z-10">ERASE</span>
            </button>
          {:else if workoutState === 'skipped'}
            <!-- Center: SESSION SKIPPED (wider) -->
            <button class="col-span-3 h-[52px] border border-amber-900/40 rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-[#451a03]/20 text-amber-500 cursor-default transition-all duration-150 hover:brightness-110 group {!isViewingToday ? 'opacity-40 pointer-events-none' : ''}">
              <span class="transition-all group-hover:tracking-[0.2em]">SESSION SKIPPED</span>
            </button>
            <!-- Right: ERASE (hold to delete day's log) -->
            <button class="col-span-1 h-[52px] rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-[#141414] border {eraseProgress > 0 ? 'border-red-500' : 'border-[#1e1e1e]'} {eraseProgress > 0 ? 'text-[#f87171]' : '!text-zinc-500'} !cursor-default relative overflow-hidden transition-all duration-150 hover:brightness-110 {!isViewingToday ? 'opacity-40 pointer-events-none' : ''}"
              onmousedown={startEraseHold} onmouseup={stopEraseHold} onmouseleave={stopEraseHold} ontouchstart={startEraseHold} ontouchend={stopEraseHold}>
              <div class="absolute inset-0 bg-red-900/50 transition-all duration-[20ms]" style="width: {eraseProgress}%;"></div>
              <span class="relative z-10">ERASE</span>
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/snippet}

  {#if !isLoading && (currentView === 'track' ? activeTemplate : true) && (currentView === 'track' || currentView === 'swap_template' || currentView === 'edit_template') && (isViewingToday || viewedLog || selectedDateStr > REAL_TODAY_STR || currentView !== 'track')}
    {@render ctaBar(currentView !== 'track' || !isViewingToday)}
  {/if}

  {#if isLoading}
    <div class="flex flex-col items-center justify-center py-10 text-zinc-500 text-xs tracking-widest gap-5">
      <div class="text-center border border-[#1e1e1e] px-8 py-3 rounded-xl bg-[#0a0a0a]">
        <div class="text-6xl font-black tracking-[8px] text-white">LIFT</div>
        <div class="text-2xl font-light tracking-[6px] text-zinc-300 -mt-3">TRACKER</div>
        <div class="text-[10px] tracking-[3px] text-emerald-400/70 mt-1">v0.0.1 • SVELTE 5</div>
      </div>

      <div class="flex items-center gap-2 text-emerald-400">
        <RefreshCw class="size-4 animate-spin" />
        <span class="tracking-[2px]">BOOTING CORE SYSTEMS</span>
      </div>

      <div class="w-full max-w-[280px] font-mono text-[10px] leading-[1.3] text-left opacity-75 border border-[#1e1e1e] bg-[#050505] p-4 rounded-lg space-y-[3px]">
        <div>&gt; svelte 5 runes • signals active</div>
        <div>&gt; @supabase/supabase-js connected</div>
        <div>&gt; schedule loaded (7 day slots)</div>
        <div>&gt; templates parsed (exercises: 12)</div>
        <div class="text-amber-400/60">&gt; setCounts • isPerfectDay • sessionStatus</div>
        <div>&gt; todayLog • justFinishedStatus</div>
        <div class="text-emerald-400/70 animate-pulse">&gt; ui hydrated • ready to lift</div>
      </div>

      <div class="text-[9px] tracking-[2px] text-zinc-500">LOCAL • PERSISTENT • MINIMAL</div>
    </div>
  
  {:else if currentView === 'track'}
    {#if !activeTemplate}
      <div class="flex flex-col items-center justify-center py-10 px-2 gap-6 {isFuture ? 'opacity-80' : ''}">
        <!-- Hero icon -->
        <div class="w-20 h-20 rounded-2xl bg-[#141414] border border-[#1e1e1e] flex items-center justify-center transition-all duration-200 hover:border-[#2a2a2a]">
          <Bed class="size-10 text-zinc-400" />
        </div>

        <div class="text-center">
          <div class="text-3xl font-semibold tracking-[-0.02em] text-white">REST DAY</div>
          <div class="text-[10px] uppercase tracking-[3px] text-zinc-500 mt-1">NO TEMPLATE ASSIGNED</div>
        </div>

        <div class="max-w-[240px] text-center text-sm text-zinc-400 leading-snug hover:text-zinc-300 transition-colors duration-200">
          Recovery is where the gains happen. 
        </div>

        {#if !isViewingToday}
          <button 
            class="h-[52px] border-none rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-white text-black transition-all duration-150 hover:brightness-110 active:scale-95 w-full max-w-xs !opacity-100"
            onclick={goToToday}>
            GO TO TODAY
          </button>
        {/if}

        <!-- Week overview -->
        <div class="w-full max-w-xs">
          <div class="text-[9px] uppercase tracking-[2px] text-zinc-500 mb-2 text-center">WEEKLY PLAN</div>
          <div class="grid grid-cols-7 gap-1">
            {#each weekPlan as d, i}
              <div class="flex flex-col items-center gap-0.5 transition-all duration-150">
                <div class="text-[10px] font-medium {i === TODAY_WEEKDAY ? 'text-white' : 'text-zinc-400'}">{d.day}</div>
                <div class="w-full h-6 rounded-md flex items-center justify-center border transition-all duration-150 {d.hasTemplate ? 'bg-emerald-950/30 border-emerald-900 hover:border-emerald-700' : 'bg-[#1e1e1e] border-[#2a2a2a] hover:border-[#3a3a3a]'}">
                  {#if d.hasTemplate}
                    <Dumbbell class="size-3 text-emerald-400" />
                  {:else}
                    <Bed class="size-3 text-zinc-500" />
                  {/if}
                </div>
              </div>
            {/each}
          </div>
          <div class="text-center text-[10px] text-zinc-500 mt-2 hover:text-white transition-colors duration-200">
            {weekPlan.filter(d => d.hasTemplate).length} training • {weekPlan.filter(d => !d.hasTemplate).length} rest
          </div>
        </div>

        <!-- Actions -->
        <div class="flex flex-col gap-2 w-full max-w-xs pt-1">
          <button 
            class="h-[52px] border-none rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-white text-black transition-all duration-150 hover:brightness-110 active:scale-95" 
            onclick={enterRoutineBuilder}>
            MOUNT OR CREATE TEMPLATE
          </button>
          <div class="text-[10px] text-center text-zinc-500">Rest days are part of the program.</div>
        </div>
      </div>
    {:else if !isViewingToday && !viewedLog && selectedDateStr < REAL_TODAY_STR}
      <div class="flex flex-col items-center justify-center py-10 px-2 gap-6">
        <!-- Hero icon -->
        <div class="w-20 h-20 rounded-2xl bg-[#141414] border border-[#1e1e1e] flex items-center justify-center transition-all duration-200 hover:border-[#2a2a2a]">
          <FileX class="size-10 text-zinc-400" />
        </div>

        <div class="text-center">
          <div class="text-3xl font-semibold tracking-[-0.02em] text-white">UNLOGGED</div>
          <div class="text-[10px] uppercase tracking-[3px] text-zinc-500 mt-1">NO WORKOUT LOGGED FOR {selectedDateDisplay.nice}</div>
        </div>

        <div class="max-w-[240px] text-center text-sm text-zinc-400 leading-snug hover:text-zinc-300 transition-colors duration-200">
          Progress unlogged is progress lost.
        </div>

        {#if !isViewingToday}
          <button 
            class="h-[52px] border-none rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-white text-black transition-all duration-150 hover:brightness-110 active:scale-95 w-full max-w-xs !opacity-100"
            onclick={goToToday}>
            GO TO TODAY
          </button>
        {/if}
      </div>
    {:else}
      <!-- Template box on main screen -->
      {@const exCount = activeTemplate.exercises.length}
      {@const setCount = activeTemplate.exercises.reduce((sum, ex) => sum + (ex.target_sets || 0), 0)}
      <div class="tpl-header bg-[#141414] border border-[#1e1e1e] rounded-xl p-3 flex flex-col gap-2 {sessionStatus === 'green' ? '!bg-[#052e16] !border-emerald-700' : ''} {sessionStatus === 'yellow' ? '!bg-[#3f2a00] !border-amber-700' : ''} {isFuture ? 'opacity-80' : ''}">
        <div class="text-center">
          <div class="text-[9px] uppercase tracking-[2px] text-zinc-500 mb-1 flex items-center justify-center gap-1">
            {workoutLabel}
            {#if isViewingToday && workoutState === 'done'}
              <Check class="size-3 text-emerald-400" />
            {/if}
          </div>
        </div>
        <div class="flex items-center h-8">
          {#if workoutState !== 'active'}
            <button class="w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center border {sessionStatus === 'green' ? 'border-emerald-700' : sessionStatus === 'yellow' ? 'border-amber-700' : 'border-[#1e1e1e]'} bg-transparent {sessionStatus === 'green' ? 'text-[#4ade80] hover:text-white' : sessionStatus === 'yellow' ? 'text-[#fbbf24] hover:text-white' : 'text-zinc-500 hover:text-white'} self-center transition-all duration-150 hover:bg-[#1a1a1a] {isFuture ? 'opacity-70 pointer-events-none' : ''}" onclick={enterRoutineBuilder} title="Routine Builder"><CalendarDays class="size-4" /></button>
          {:else}
            <div class="w-8 h-8 flex-shrink-0"></div>
          {/if}
          <div class="flex-1 text-center px-2 min-w-0 self-center">
            <span class="inline-flex items-center">
              <span class="tpl-name text-lg font-semibold tracking-tight text-white truncate leading-none">[ {activeTemplate.name} ]</span>
            </span>
          </div>
          {#if workoutState !== 'active'}
            <button class="w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center border {sessionStatus === 'green' ? 'border-emerald-700' : sessionStatus === 'yellow' ? 'border-amber-700' : 'border-[#1e1e1e]'} bg-transparent {sessionStatus === 'green' ? 'text-[#4ade80] hover:text-white' : sessionStatus === 'yellow' ? 'text-[#fbbf24] hover:text-white' : 'text-zinc-500 hover:text-white'} self-center transition-all duration-150 hover:bg-[#1a1a1a] {isFuture ? 'opacity-70 pointer-events-none' : ''}" onclick={() => currentView = 'edit_template'} title="Edit Exercises"><Pencil class="size-4" /></button>
          {:else}
            <div class="w-8 h-8 flex-shrink-0"></div>
          {/if}
        </div>
        <div class="text-center -mt-0.5 h-[14px] flex items-center justify-center">
          {#if isPerfectDay}
            <span class="text-[9px] font-extrabold tracking-wider text-[#fbbf24] bg-[#1c1200] border border-[#713f12] rounded px-1.5 py-0.5">PERFECT DAY</span>
          {:else}
            <div class="text-[9px] uppercase tracking-[1.5px] text-zinc-500">
              {exCount} EXERCISES • {setCount} SETS
            </div>
          {/if}
        </div>
        <div class="flex gap-[1px] h-2 w-full">
          {#each Array(setCounts.total) as _, i}
            <div 
              class="flex-1 rounded-[1px]"
              style="background-color: {i < setCounts.done ? progressBarColor : '#1a1a1a'}"
            ></div>
          {/each}
        </div>
      </div>

      <!-- Exercises in one shared box separated by horizontal dividers, with list numbers on left (like editor list) -->
      <div class="bg-[#141414] border border-[#1e1e1e] rounded-xl overflow-hidden {isFuture ? 'opacity-80' : ''}">
        {#each activeTemplate.exercises as exercise, index}
          {@const status = getExerciseStatus(exercise)}
          {@const isTargetMet = status === 'green'}
          {@const isTimeEx = exercise.exercise_type === 'time'}
          {@const hasActiveTimerThis = isViewingToday && isTimeEx && activeTimerExerciseId === exercise.id && activeTimerSetIndex !== null}
          {@const timeTotal = isTimeEx ? (exercise.target_minutes * 60 + exercise.target_seconds) : 0}
          {@const logSrc = isViewingToday ? todayLog : viewedLog}
          {@const isDoneViewed = !!logSrc?.workout_snapshot?.exercises && (isViewingToday ? (workoutState === 'done') : true)}
          {@const loggedEx = isDoneViewed ? logSrc.workout_snapshot.exercises.find((e: any) => e.id === exercise.id) : null}
          {@const displayCurrentWeight = loggedEx?.weight_before ?? exercise.current_weight}
          <div class="p-3 flex gap-1.5 hover:brightness-105 {index > 0 ? 'border-t border-[#1e1e1e]' : ''} {status === 'green' ? '!border-emerald-700 !bg-[#052e16]' : ''} {status === 'yellow' ? '!border-amber-700 !bg-[#3f2a00]' : ''}">
            <!-- list number on left: boxed, vertically centered in strip, slightly larger -->
            <div class="w-5 flex-shrink-0 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded text-[10px] font-medium text-zinc-400
              {status === 'green' ? '!bg-[#052e16] !border-emerald-700 !text-white' : ''} 
              {status === 'yellow' ? '!bg-[#3f2a00] !border-amber-700 !text-white' : ''}">
              {index + 1}
            </div>
            <div class="flex-1 flex flex-col gap-1.5">
              <div class="ex-top flex justify-between items-start">
              <div class="truncate pr-2">
                <div class="ex-name-row flex items-center gap-1.5 hover:brightness-125 transition-all">
                  {#if exercise.exercise_type === 'reps'}
                    <Dumbbell class="size-3.5 text-white shrink-0" />
                  {:else}
                    <Timer class="size-3.5 text-white shrink-0" />
                  {/if}
                  <div class="min-w-0">
                    <span class="ex-name text-sm font-extrabold tracking-wide text-white">{exercise.name}</span>
                    {#if isTargetMet && workoutState === 'active'}
                      <span class="pr-badge text-[9px] font-extrabold tracking-wider text-[#fbbf24] bg-[#1c1200] border border-[#713f12] rounded px-1.5 py-0.5 ml-1.5 align-middle">NEW PR</span>
                    {/if}
                  </div>
                </div>
                <div class="ex-meta text-xs text-zinc-400 mt-0.5 tracking-wide">
                  {#if exercise.exercise_type === 'reps'}
                    {exercise.target_sets}×{exercise.target_reps} @{displayCurrentWeight ?? 0}kg +{exercise.increment}kg
                  {:else}
                    {exercise.target_sets}× {exercise.target_minutes}m {exercise.target_seconds.toString().padStart(2, '0')}s +{exercise.increment}s
                  {/if}
                </div>
              </div>

              {#if !isTimeEx}
                {#if displayCurrentWeight !== null}
                  <div class="weight-num text-2xl font-extrabold tracking-tighter text-white">{displayCurrentWeight}<span class="unit text-[10px] text-zinc-400 font-normal ml-1 tracking-[1px]">KG</span></div>
                {:else}
                  <!-- Narrow baseline input (fits ~3 digits) in the KG position, right-aligned -->
                  <div class="flex items-baseline justify-end">
                    <input type="number" placeholder="80" class="text-2xl font-extrabold tracking-tighter text-white bg-transparent border-none outline-none w-12 text-right"
                      disabled={isFuture}
                      onchange={async (e) => {
                        const val = parseFloat((e.target as HTMLInputElement).value);
                        if (val >= 0) { await db.saveExerciseBaseline(exercise.id, val); await loadData({ preserveSession: true }); }
                      }} />
                    <span class="unit text-[10px] text-zinc-400 font-normal ml-1 tracking-[1px]">KG</span>
                  </div>
                {/if}
              {:else if isTimeEx}
                <div class="text-right leading-none">
                  {#if hasActiveTimerThis}
                    {@const elapsed = countdownSeconds}
                    {@const target = timeTotal}
                    {@const isOvertime = elapsed >= target}
                    {@const displaySecs = isOvertime ? elapsed - target : target - elapsed}
                    {@const m = Math.floor(displaySecs / 60).toString().padStart(2, '0')}
                    {@const s = (displaySecs % 60).toString().padStart(2, '0')}
                    <div class="text-2xl font-extrabold tracking-tighter transition-all duration-1000 {isOvertime ? 'text-[#4ade80]' : 'text-white'}">{isOvertime ? '+' : ''}{m}<span class="unit text-[10px] text-zinc-400 font-normal ml-1 tracking-[1px]">M</span> {s}<span class="unit text-[10px] text-zinc-400 font-normal ml-1 tracking-[1px]">S</span></div>
                  {:else}
                    <div class="text-2xl font-extrabold tracking-tighter text-white">{exercise.target_minutes.toString().padStart(2, '0')}<span class="unit text-[10px] text-zinc-400 font-normal ml-1 tracking-[1px]">M</span> {exercise.target_seconds.toString().padStart(2, '0')}<span class="unit text-[10px] text-zinc-400 font-normal ml-1 tracking-[1px]">S</span></div>
                  {/if}
                </div>
              {/if}
            </div>

            <!-- sets lane: placed right under name lane for "next to the name", packed to reduce empty gap -->
            {#if exercise.exercise_type === 'reps'}
              {#if exercise.current_weight !== null}
                <div class="set-row grid gap-1" style="grid-template-columns: repeat({exercise.target_sets}, minmax(0, 1fr));">
                  {#each Array(exercise.target_sets) as _, s}
                    {@const bubbleStatus = getSetBubbleStatus(exercise.id, s, exercise.target_reps)}
                    {@const repsValue = isViewingToday ? trackedReps[`${exercise.id}-${s}`] : (viewedLog?.workout_snapshot?.exercises?.find((e: any) => e.id === exercise.id)?.performed_sets?.[s] ?? undefined)}
                    {@const isEditingThisSet = editingSetKey === `${exercise.id}-${s}`}
                    <div class="relative h-7 rounded-md bg-[#0d0d0d] border border-[#1a1a1a] flex flex-col items-center justify-center overflow-hidden text-[10px]
                      {bubbleStatus === 'green' ? '!bg-emerald-800 !border-emerald-500 !text-white' : ''} 
                      {bubbleStatus === 'yellow' ? '!bg-amber-800 !border-amber-500 !text-white' : ''}">
                      
                      {#if isEditingThisSet}
                        <input type="number" id="input-{exercise.id}-{s}" value={repsValue !== undefined ? repsValue : ''} placeholder={exercise.target_reps.toString()}
                          class="absolute inset-0 w-full h-full bg-transparent border-none outline-none text-center font-sans text-[10px] font-extrabold text-white"
                          onblur={() => saveManualRepEdit(exercise.id, s)}
                          onkeydown={(e) => { if (e.key === 'Enter') saveManualRepEdit(exercise.id, s); }} />
                      {:else}
                        <button class="w-full h-full flex flex-col items-center justify-center bg-transparent border-none p-0 text-zinc-400 font-sans hover:brightness-125 active:scale-95"
                          onclick={() => handleSetBubbleClick(exercise.id, s, exercise.target_reps)}
                          disabled={!isViewingToday || workoutState !== 'active'}>
                          <span class="sl text-[8px] tracking-wider opacity-60 block leading-none">S{s + 1}</span>
                          <span class="sv text-[11px] font-extrabold block text-current leading-none">{repsValue !== undefined ? repsValue : '—'}</span>
                        </button>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            {:else}
              <!-- time: sets selection pills (replaced by progress bar when active, for fixed height strip; all white until stopped/completed then yellow/green on bubble) -->
              {#if hasActiveTimerThis && activeTimerSetIndex !== null}
                {@const s = activeTimerSetIndex}
                {@const prog = timeTotal > 0 ? Math.min((countdownSeconds / timeTotal) * 100, 100) : 0}
                <div class="h-7 flex items-center gap-2 text-sm leading-none text-white">
                  <div class="flex-1 h-1 bg-[#1a1a1a] rounded-full overflow-hidden">
                    <div class="h-1 rounded-full transition-all {hasActiveTimerThis && countdownRunning ? 'animate-[pulse_3s_ease-in-out_infinite]' : ''}" style="width:{prog}%; background:{countdownSeconds >= timeTotal ? '#4ade80' : 'white'}"></div>
                  </div>
                  <div class="flex gap-1 pl-1 border-l border-[#222] text-white">
                    <button class="hover:text-zinc-300 active:scale-95 transition p-0.5" onclick={toggleExerciseTimer}>
                      {#if countdownRunning}<Pause class="size-5 fill-current" />{:else}<Play class="size-5 fill-current" />{/if}
                    </button>
                    <button class="text-white hover:text-zinc-300 active:scale-95 transition p-0.5" onclick={() => stopAndSaveTimedSet(exercise.id, s, timeTotal)}>
                      <Square class="size-5 fill-current" />
                    </button>
                  </div>
                </div>
              {:else}
                <div class="set-row grid gap-1" style="grid-template-columns: repeat({exercise.target_sets}, minmax(0, 1fr));">
                  {#each Array(exercise.target_sets) as _, s}
                    {@const bubbleStatus = getSetBubbleStatus(exercise.id, s)}
                    {@const saved = isViewingToday ? completedTimers[`${exercise.id}-${s}`] : (viewedLog?.workout_snapshot?.exercises?.find((e: any) => e.id === exercise.id)?.performed_times?.[s] ? { result: viewedLog?.workout_snapshot?.exercises?.find((e: any) => e.id === exercise.id)?.performed_times?.[s], met: true } : undefined)}
                    <div class="relative h-7 rounded-md bg-[#0d0d0d] border border-[#1a1a1a] flex flex-col items-center justify-center overflow-hidden text-[10px]
                      {bubbleStatus === 'green' ? '!bg-emerald-800 !border-emerald-500 !text-white' : ''} 
                      {bubbleStatus === 'yellow' ? '!bg-amber-800 !border-amber-500 !text-white' : ''}">
                      <button class="w-full h-full flex flex-col items-center justify-center bg-transparent border-none p-0 text-white font-sans hover:brightness-125 active:scale-95"
                        onclick={() => activateOrSwitchTimeSet(exercise.id, s)}
                        disabled={!isViewingToday || workoutState !== 'active'}>
                        <span class="sl text-[8px] tracking-wider opacity-60 block leading-none">S{s + 1}</span>
                        <span class="sv text-[11px] font-extrabold block text-current leading-none">{saved ? saved.result : '—'}</span>
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}

  {:else if currentView === 'swap_template'}
    <!-- Routine Builder: assign templates to full SMTWTFS week -->
    <div class="bg-[#141414] border border-[#1e1e1e] rounded-xl p-4 space-y-3">
      <div class="flex items-center gap-2 border-b border-zinc-800 pb-2">
        <button class="w-8 h-8 rounded-lg border border-zinc-800 bg-transparent text-white flex items-center justify-center text-xs" onclick={async () => {
          // commit any changes across the week
          const promises: Promise<any>[] = [];
          for (let wd = 0; wd < 7; wd++) {
            const newTid = builderAssignments[wd];
            const oldTid = schedule.find((s: any) => s.day_of_week === wd)?.template_id ?? null;
            if (newTid !== oldTid) {
              promises.push(db.assignTemplateToDay(wd, newTid));
            }
          }
          if (promises.length) {
            await Promise.all(promises);
            await loadData();
          }
          currentView = 'track';
          builderAssignments = {};
          builderEditingDay = 0;
        }}><ArrowLeft class="size-4" /></button>
        <span class="text-xs font-bold tracking-wider text-zinc-400">ROUTINE BUILDER</span>
      </div>

      <!-- Weekday slots selector -->
      <div class="text-[9px] text-zinc-500 tracking-widest">CLICK DAY TO ASSIGN</div>
      <div class="grid grid-cols-7 gap-1">
        {#each DAYS as d, i}
          {@const tid = builderAssignments[i]}
          {@const tname = tid ? templates.find((t: any) => t.id === tid)?.name ?? 'T' : 'REST'}
          <button 
            class="text-[9px] py-1 px-0.5 rounded border transition-all leading-none {builderEditingDay === i ? 'border-white bg-[#1e1e1e] text-white' : 'border-[#1e1e1e] text-zinc-400 hover:border-zinc-700'}"
            onclick={() => { builderEditingDay = i; }}
          >
            <div class="font-bold">{d}</div>
            <div class="text-[6px] truncate opacity-60 mt-px">{tname}</div>
          </button>
        {/each}
      </div>

      <div class="space-y-2">
        <span class="text-[10px] text-zinc-500 block">ASSIGN TO {DAYS[builderEditingDay]}:</span>
        <div class="flex flex-col gap-1">
          <button class="w-full text-left px-3 py-2 rounded-lg border border-dashed border-zinc-800 bg-transparent text-xs text-red-400 flex justify-between items-center"
            onclick={() => { builderAssignments[builderEditingDay] = null; }}>
            <span>[ REST DAY ]</span>
            {#if builderAssignments[builderEditingDay] === null}<span class="text-[9px] bg-red-950/40 px-1 rounded border border-red-900">ASSIGNED</span>{/if}
          </button>
          
          {#each templates as template}
            <button class="w-full text-left px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900 text-xs flex justify-between items-center transition-all hover:border-zinc-700
              {builderAssignments[builderEditingDay] === template.id ? 'border-emerald-500 text-emerald-400 bg-emerald-950/10' : 'text-zinc-400'}"
              onclick={() => { builderAssignments[builderEditingDay] = template.id; }}>
              <span>[ {template.name} ]</span>
              {#if builderAssignments[builderEditingDay] === template.id}<span class="text-[9px] bg-emerald-950 px-1 rounded border border-emerald-800">ASSIGNED</span>{/if}
            </button>
          {/each}
        </div>
      </div>

      <div class="border-t border-zinc-800 pt-3 space-y-2">
        <span class="text-[10px] text-zinc-500 block">OR CREATE A NEW TEMPLATE:</span>
        <input placeholder="Template Name (e.g., Push, Pull)" class="w-full bg-black border border-zinc-800 text-xs text-white p-2 rounded-lg outline-none focus:border-zinc-700" bind:value={newTemplateName} />
        <button class="w-full bg-white text-black text-xs font-bold py-2 rounded-lg" onclick={handleCreateTemplate}>Create & Add Exercises</button>
      </div>
    </div>

  {:else if currentView === 'edit_template'}
    <div class="bg-[#141414] border border-[#1e1e1e] rounded-xl p-3 space-y-3">
      <!-- Minimal header -->
      <div class="flex items-center gap-2 border-b border-zinc-800 pb-2">
        <button 
          class="w-8 h-8 rounded-lg border border-zinc-800 bg-transparent text-white flex items-center justify-center flex-shrink-0" 
          onclick={exitEditTemplate}
        >
          <ArrowLeft class="size-4" />
        </button>
        <input 
          bind:value={draftTemplateName} 
          class="flex-1 bg-black border border-zinc-800 text-sm text-white px-3 py-1 rounded-lg outline-none focus:border-zinc-700 text-center"
          placeholder="Template name"
        />
        <button 
          class="w-8 h-8 px-1.5 py-1.5 bg-red-950/40 border border-red-900 text-red-400 rounded-lg flex items-center justify-center relative overflow-hidden flex-shrink-0"
          onmousedown={startDeleteTemplateHold} onmouseup={stopDeleteTemplateHold} onmouseleave={stopDeleteTemplateHold} ontouchstart={startDeleteTemplateHold} ontouchend={stopDeleteTemplateHold}
        >
          <div class="absolute inset-0 bg-red-900/50 transition-all duration-[20ms]" style="width: {deleteTemplateProgress}%;"></div>
          <Trash2 class="size-4 relative z-10" />
        </button>
      </div>

      {#if !activeTemplate}
        <div class="text-center py-6">
          <p class="text-xs text-zinc-500 mb-2">No template loaded for this weekday.</p>
          <button class="px-3 py-1 bg-zinc-900 border border-zinc-800 text-xs font-bold rounded-lg" onclick={enterRoutineBuilder}>Assign or Create</button>
        </div>
      {:else}
        <!-- Exercises list: draggable rows (grip), selectable for inline name edit + properties, wide + row below, single delete (sized to match header delete) -->
        <div>
          <div class="flex items-center justify-between mb-1">
            <div class="text-[9px] text-zinc-500 tracking-widest">EXERCISES</div>
            <div class="flex items-center gap-1">
              <!-- single delete for selected; same size (w-8 h-8) as the template delete button in the header -->
              <button 
                class="w-8 h-8 rounded border border-red-900 bg-red-950/40 text-red-400 flex items-center justify-center hover:text-red-300 transition-all disabled:opacity-40 disabled:pointer-events-none"
                onclick={deleteSelectedExercise}
                disabled={!selectedExerciseId}
                title="Delete selected exercise"
              >
                <Trash2 class="size-4" />
              </button>
            </div>
          </div>

          {#if draftExercises.length === 0}
            <div class="text-center py-4 border border-dashed border-zinc-800 rounded-lg text-xs text-zinc-600">No exercises yet. Use the + row below.</div>
          {/if}

          <div class="space-y-1">
            {#each draftExercises as exercise, index (exercise.id)}
              <div 
                class="flex items-stretch gap-1 {selectedExerciseId === exercise.id ? 'outline outline-1 outline-offset-0 outline-zinc-600 rounded' : ''}"
                draggable="true"
                ondragstart={(e) => handleDragStart(e, index)}
                ondragover={handleDragOver}
                ondrop={(e) => handleDrop(e, index)}
                ondragend={handleDragEnd}
              >
                <!-- Grip for drag-to-reorder -->
                <div class="w-5 flex-shrink-0 flex items-center justify-center text-zinc-500 cursor-grab active:cursor-grabbing" title="Drag to reorder">
                  <GripVertical class="size-3" />
                </div>
                <!-- Number box -->
                <div class="w-6 flex-shrink-0 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded text-[10px] font-medium text-zinc-400">
                  {index + 1}
                </div>
                <!-- Selectable content: inline name input (edit directly here), meta reflects live values -->
                <div 
                  class="flex-1 p-1.5 bg-zinc-950 border border-zinc-800 rounded text-xs flex items-center justify-between cursor-pointer transition-colors {selectedExerciseId === exercise.id ? 'bg-zinc-900 border-zinc-600' : 'hover:bg-zinc-900 hover:border-zinc-700'}"
                  onclick={() => selectExercise(exercise.id)}
                >
                  <div class="flex items-center gap-1.5 min-w-0 flex-1">
                    {#if exercise.exercise_type === 'reps'}
                      <Dumbbell class="size-3 text-white flex-shrink-0" />
                    {:else}
                      <Timer class="size-3 text-white flex-shrink-0" />
                    {/if}
                    <input 
                      type="text"
                      value={exercise.name}
                      oninput={(e) => {
                        exercise.name = (e.currentTarget as HTMLInputElement).value;
                        // direct mutation on the $state object; Svelte reactivity should update list visuals instantly without array re-creation
                      }}

                      class="font-medium text-white bg-transparent border-0 p-0 m-0 focus:outline-none focus:ring-0 text-xs w-full min-w-[40px]"
                      placeholder="Name"
                    />
                    <span class="text-[9px] text-zinc-500 whitespace-nowrap ml-1 flex-shrink-0">
                      {exercise.exercise_type === 'reps' ? `${exercise.target_sets}×${exercise.target_reps} @${exercise.current_weight ?? 0}kg +${exercise.increment}kg` : `${exercise.target_sets}× ${exercise.target_minutes}m${exercise.target_seconds}s +${exercise.increment}s`}
                    </span>
                  </div>
                </div>
              </div>
            {/each}
          </div>

          <!-- Wide plus icon box, same structure/width as exercise entry rows (w-5 grip col + w-6 num col + flex-1 content) -->
          <div 
            class="flex items-stretch gap-1 mt-1 cursor-pointer active:opacity-75"
            onclick={addNewExercise}
            title="Add new exercise"
          >
            <div class="w-5 flex-shrink-0 flex items-center justify-center text-zinc-400">
              <Plus class="size-3" />
            </div>
            <div class="w-6 flex-shrink-0 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded text-[10px] text-zinc-400">
              +
            </div>
            <div class="flex-1 p-1.5 bg-zinc-950 border border-dashed border-zinc-700 rounded text-xs text-zinc-400 flex items-center">
              Add exercise
            </div>
          </div>
        </div>

        <!-- Live properties editor for selected exercise -->
        <div class="pt-3 border-t border-zinc-800 space-y-2">
          {#if selectedExerciseId}
            {@const ex = draftExercises.find((e: any) => e.id === selectedExerciseId)}
            {#if ex}
              <div class="text-[9px] text-zinc-500 tracking-widest">PROPERTIES</div>

              <!-- Type tabs (direct) -->
          <div class="grid grid-cols-2 gap-1">
            <button 
              class="py-1 text-[10px] rounded border transition-all {ex.exercise_type === 'reps' ? 'bg-zinc-800 text-white border-zinc-700' : 'text-zinc-500 border-zinc-800'}"
              onclick={() => { ex.exercise_type = 'reps'; }}
            >REPS / SETS</button>
            <button 
              class="py-1 text-[10px] rounded border transition-all {ex.exercise_type === 'time' ? 'bg-zinc-800 text-white border-zinc-700' : 'text-zinc-500 border-zinc-800'}"
              onclick={() => { ex.exercise_type = 'time'; }}
            >TIME / SETS</button>
          </div>


          
          <!-- Params (direct on ex) -->
          {#if ex.exercise_type === 'reps'}
            <div class="grid grid-cols-4 gap-1 text-[9px]">
              <div>
                <span class="text-zinc-500 block mb-0.5">Sets</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" value={ex.target_sets} oninput={(e) => { ex.target_sets = +(e.currentTarget as HTMLInputElement).value; }} />
              </div>
              <div>
                <span class="text-zinc-500 block mb-0.5">Reps</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" value={ex.target_reps} oninput={(e) => { ex.target_reps = +(e.currentTarget as HTMLInputElement).value; }} />
              </div>
              <div>
                <span class="text-zinc-500 block mb-0.5">Base kg</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" value={ex.current_weight ?? 0} oninput={(e) => { ex.current_weight = +(e.currentTarget as HTMLInputElement).value; }} />
              </div>
              <div>
                <span class="text-zinc-500 block mb-0.5">+ kg</span>
                <input type="number" step="0.5" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" value={ex.increment} oninput={(e) => { ex.increment = +(e.currentTarget as HTMLInputElement).value; }} />
              </div>
            </div>
          {:else}
            <div class="grid grid-cols-4 gap-1 text-[9px]">
              <div>
                <span class="text-zinc-500 block mb-0.5">Sets</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" value={ex.target_sets} oninput={(e) => { ex.target_sets = +(e.currentTarget as HTMLInputElement).value; }} />
              </div>
              <div>
                <span class="text-zinc-500 block mb-0.5">Min</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" value={ex.target_minutes} oninput={(e) => { ex.target_minutes = +(e.currentTarget as HTMLInputElement).value; }} />
              </div>
              <div>
                <span class="text-zinc-500 block mb-0.5">Sec</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" value={ex.target_seconds} oninput={(e) => { ex.target_seconds = +(e.currentTarget as HTMLInputElement).value; }} />
              </div>
              <div>
                <span class="text-zinc-500 block mb-0.5">+ s</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" value={ex.increment} oninput={(e) => { ex.increment = +(e.currentTarget as HTMLInputElement).value; draftExercises = [...draftExercises]; }} />
              </div>
            </div>
          {/if}
          {/if}

          {:else}
            <div class="text-center py-3 text-[10px] text-zinc-500 border border-dashed border-zinc-800 rounded">Select an exercise (or + to add) to edit type, sets, reps, and values live.</div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Footer -->
  <div class="mt-auto pt-5 text-center text-[9px] tracking-[1px] text-zinc-500">
    © 2026 LIFT TRACKER — All rights reserved. Arya
  </div>

</div>
