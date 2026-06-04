<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { db, supabase, type Template, type Exercise } from '$lib/db';
  import {
    ArrowDown,
    ArrowLeft,
    ArrowUp,
    Dumbbell,
    Pause,
    Pencil,
    Play,
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
  const TODAY = new Date().getDay();

  // State
  let selectedDay = $state(TODAY);
  let currentView = $state<'track' | 'swap_template' | 'edit_template'>('track');
  let isLoading = $state(true);
  let isSyncing = $state(false);
  let hasInitialLoad = $state(false);
  let workoutState = $state<'idle' | 'active' | 'done' | 'skipped'>('idle');

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
  let newExerciseName = $state('');
  let newExerciseType = $state<'reps' | 'time'>('reps');
  let newExerciseSets = $state<number>(3);
  let newExerciseReps = $state<number>(12);
  let newExerciseMinutes = $state<number>(0);
  let newExerciseSeconds = $state<number>(30);
  let newExerciseWeightIncrement = $state<number>(2.5);
  let newExerciseBaseKg = $state<number>(15);

  // Draft state for template editing (local until commit on finish)
  let draftExercises = $state<any[]>([]);
  let draftTemplateName = $state('');
  let editingExerciseId = $state<string | null>(null);
  let originalTemplateId = $state<string | null>(null);
  let originalExerciseIds = $state<Set<string>>(new Set());

  // Svelte 5 Derived State
  let currentDaySchedule = $derived(schedule.find(s => s.day_of_week === selectedDay));
  let activeTemplate = $derived(templates.find(t => t.id === currentDaySchedule?.template_id) || null);
  let isViewingToday = $derived(selectedDay === TODAY);

  // Initialize draft when entering template editor; clear otherwise
  $effect(() => {
    if (currentView === 'edit_template' && activeTemplate) {
      if (originalTemplateId !== activeTemplate.id) {
        draftExercises = activeTemplate.exercises.map((e) => ({ ...e }));
        draftTemplateName = activeTemplate.name;
        originalExerciseIds = new Set(activeTemplate.exercises.map((e) => e.id));
        originalTemplateId = activeTemplate.id;
        editingExerciseId = null;
        resetNewExerciseForm();
      }
    } else if (currentView !== 'edit_template') {
      if (draftExercises.length > 0 || editingExerciseId || draftTemplateName) {
        draftExercises = [];
        draftTemplateName = '';
        editingExerciseId = null;
        originalExerciseIds = new Set();
        originalTemplateId = null;
      }
    }
  });

  function formatTime(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  function getExerciseStatus(exercise: Exercise) {
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
  }

  function getSetBubbleStatus(exerciseId: string, setIndex: number, targetReps?: number) {
    const key = `${exerciseId}-${setIndex}`;
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
			}
		} catch (err) {
			console.error(err);
			if (!options.preserveSession) workoutState = 'idle';
		} finally {
			isLoading = false;
			isSyncing = false;
			hasInitialLoad = true;
		}
	}

  onMount(() => { loadData(); });
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

		workoutState = 'done';

		await loadData();
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
      await loadData();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleCreateTemplate() {
    if (!newTemplateName.trim()) return;
    const template = await db.createTemplate(newTemplateName);
    if (template) { 
      await db.assignTemplateToDay(selectedDay, template.id); 
      newTemplateName = ''; 
      await loadData(); 
      currentView = 'edit_template'; 
    }
  }

  function resetNewExerciseForm() {
    newExerciseName = '';
    newExerciseSets = 3;
    newExerciseReps = 12;
    newExerciseMinutes = 0;
    newExerciseSeconds = 30;
    newExerciseWeightIncrement = 2.5;
    newExerciseBaseKg = 15;
  }

  function startEditingExercise(ex: any) {
    editingExerciseId = ex.id;
    newExerciseName = ex.name || '';
    newExerciseType = ex.exercise_type;
    newExerciseSets = ex.target_sets ?? 3;
    newExerciseReps = ex.target_reps ?? 12;
    newExerciseMinutes = ex.target_minutes ?? 0;
    newExerciseSeconds = ex.target_seconds ?? 30;
    newExerciseWeightIncrement = ex.increment ?? (ex.exercise_type === 'time' ? 5 : 2.5);
    newExerciseBaseKg = ex.current_weight ?? 15;
  }

  function handleSaveExerciseToDraft() {
    if (!newExerciseName.trim() || !activeTemplate) return;
    const exData: any = {
      name: newExerciseName.trim(),
      exercise_type: newExerciseType,
      target_sets: newExerciseSets,
      target_reps: newExerciseType === 'reps' ? newExerciseReps : 0,
      target_minutes: newExerciseType === 'time' ? newExerciseMinutes : 0,
      target_seconds: newExerciseType === 'time' ? newExerciseSeconds : 0,
      increment: newExerciseType === 'reps' ? newExerciseWeightIncrement : 0,
      current_weight: newExerciseType === 'reps' ? newExerciseBaseKg : null,
      display_order: draftExercises.length,
      template_id: activeTemplate.id,
    };
    if (editingExerciseId) {
      draftExercises = draftExercises.map((ex: any) =>
        ex.id === editingExerciseId ? { ...ex, ...exData, id: ex.id } : ex
      );
      editingExerciseId = null;
    } else {
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      draftExercises = [...draftExercises, { ...exData, id: tempId }];
    }
    resetNewExerciseForm();
  }

  async function commitDraftExercises() {
    if (!activeTemplate || (draftExercises.length === 0 && originalExerciseIds.size === 0)) return;
    const templateId = activeTemplate.id;
    const draftReal = draftExercises.filter((e: any) => !String(e.id).startsWith('temp-'));
    const currentRealIds = new Set(draftReal.map((e: any) => e.id));
    const toDelete = Array.from(originalExerciseIds).filter((id) => !currentRealIds.has(id));
    for (const id of toDelete) {
      try { await db.deleteExercise(id); } catch (err) { console.error(err); }
    }
    for (let i = 0; i < draftExercises.length; i++) {
      const d: any = draftExercises[i];
      const isTemp = String(d.id).startsWith('temp-');
      const updateData = {
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
        if (isTemp) {
          await supabase.from('exercises').insert({
            template_id: templateId,
            ...updateData,
          });
        } else {
          await supabase.from('exercises').update(updateData).eq('id', d.id);
        }
      } catch (err) {
        console.error('commit error', err);
      }
    }
    // also save template name if edited
    if (draftTemplateName && draftTemplateName.trim() && draftTemplateName !== activeTemplate.name) {
      try {
        await supabase.from('templates').update({ name: draftTemplateName.trim() }).eq('id', templateId);
      } catch (err) {
        console.error('template name update err', err);
      }
    }

    await loadData();
    // refresh draft from server if still editing
    if (currentView === 'edit_template' && activeTemplate) {
      draftExercises = activeTemplate.exercises.map((e) => ({ ...e }));
      draftTemplateName = activeTemplate.name;
      originalExerciseIds = new Set(activeTemplate.exercises.map((e) => e.id));
      originalTemplateId = activeTemplate.id;
      editingExerciseId = null;
    }
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

  // handleAdd kept for fallback; primary path for editor is local draft + commit on finish
  async function handleAddExercise() {
    if (!activeTemplate || !newExerciseName.trim()) return;
    await db.addExerciseToTemplate(
      activeTemplate.id,
      newExerciseName,
      newExerciseSets,
      newExerciseReps,
      newExerciseWeightIncrement,
      newExerciseType,
      newExerciseMinutes,
      newExerciseSeconds
    );
    resetNewExerciseForm();
    await loadData();
  }

  function handleMoveExercise(index: number, direction: 'up' | 'down') {
    if (currentView === 'edit_template' && draftExercises.length > 0) {
      const list = [...draftExercises];
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= list.length) return;
      const temp = list[index];
      list[index] = list[targetIndex];
      list[targetIndex] = temp;
      draftExercises = list;
      return;
    }
    if (!activeTemplate) return;
    const exercisesList = [...activeTemplate.exercises];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= exercisesList.length) return;
    const temp = exercisesList[index];
    exercisesList[index] = exercisesList[targetIndex];
    exercisesList[targetIndex] = temp;
    activeTemplate.exercises = exercisesList;
    db.updateExerciseOrder(exercisesList);
  }

  function handleDeleteExercise(id: string) {
    if (currentView === 'edit_template' && draftExercises.length > 0) {
      draftExercises = draftExercises.filter((e: any) => e.id !== id);
      if (editingExerciseId === id) {
        editingExerciseId = null;
        resetNewExerciseForm();
      }
      return;
    }
    db.deleteExercise(id).then(() => loadData());
  }

  async function handleDeleteTemplate() {
    if (activeTemplate && confirm('Delete this template permanently?')) {
      await db.deleteTemplate(activeTemplate.id);
      await loadData();
      currentView = 'track';
    }
  }
</script>

<div class="app max-w-md mx-auto min-h-screen select-none text-white bg-[#0a0a0a] p-4 flex flex-col gap-3 font-sans">
  
  <div class="day-strip grid grid-cols-7 gap-1 bg-[#141414] border border-[#1e1e1e] rounded-xl p-1.5">
    {#each DAYS as day, i}
      {@const isSelected = selectedDay === i}
      {@const isToday = TODAY === i}
      {@const isDone = isToday && workoutState === 'done'}
      {@const isSkipped = isToday && workoutState === 'skipped'}
      <button 
        class="day-btn h-11 flex flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-bold tracking-wide transition-colors duration-150 border-none bg-transparent text-zinc-600
          {isDone ? '!bg-[#14532d] !text-[#4ade80]' : ''} 
          {isSkipped ? '!bg-[#451a03] !text-amber-500' : ''} 
          {isToday && !isDone && !isSkipped ? '!bg-white !text-black' : ''} 
          {isSelected && !isToday && !isDone && !isSkipped ? '!bg-[#1e1e1e] !text-white' : ''}"
        onclick={() => { selectedDay = i; currentView = 'track'; }}
        disabled={workoutState === 'active'}
      >
        <span>{day}</span>
        {#if isToday && workoutState !== 'done' && workoutState !== 'skipped'}
          <span class="dot w-1 h-1 rounded-full bg-current"></span>
        {/if}
      </button>
    {/each}
  </div>

  {#if isLoading}
    <div class="flex flex-col items-center justify-center py-20 text-zinc-500 text-xs tracking-widest gap-2">
      <RefreshCw class="size-4 animate-spin" /> LOADING...
    </div>
  
  {:else if currentView === 'track'}
    {#if !activeTemplate}
      <div class="flex flex-col items-center justify-center py-8 gap-3">
        <div class="text-white text-sm font-medium tracking-[1px]">
          REST DAY
        </div>
        <button class="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-xs font-bold text-white hover:bg-zinc-800" onclick={() => currentView = 'swap_template'}>
          Create / Mount Template
        </button>
      </div>
    {:else}
      <!-- 3-button CTA: narrow WEIGHT | wider center (uses most space, biggest) | narrow SKIP/CANCEL/ERASE; uses grid-cols-5 + col-spans (1-3-1) so center is wider than the rest while widths stay consistent across idle/active/done/skipped; consistent theme/font in CAPS; WEIGHT + ERASE also in skipped -->
      <div>
        {#if workoutState === 'idle' || workoutState === 'active' || workoutState === 'done' || workoutState === 'skipped'}
          <div class="grid grid-cols-5 gap-3">
            <!-- WEIGHT dummy (left, narrow) -->
            <button class="col-span-1 h-[52px] rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-[#141414] !text-zinc-500 border border-[#1e1e1e] !cursor-default">
              WEIGHT
            </button>

            {#if workoutState === 'idle'}
              <!-- Center: START WORKOUT (wider) -->
              <button class="col-span-3 h-[52px] border-none rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-white text-black" onclick={startWorkout}>
                START WORKOUT
              </button>
              <!-- Right: SKIP (hold, narrow) -->
              <button class="col-span-1 h-[52px] border border-[#1e1e1e] rounded-xl bg-[#0d0d0d] font-sans font-black text-[11px] tracking-[0.15em] text-zinc-500 flex items-center justify-center relative overflow-hidden"
                onmousedown={startSkipHold} onmouseup={stopSkipHold} onmouseleave={stopSkipHold} ontouchstart={startSkipHold} ontouchend={stopSkipHold}>
                <div class="absolute inset-0 bg-amber-900/40 transition-all duration-[20ms]" style="width: {skipProgress}%;"></div>
                <span class="relative z-10">SKIP</span>
              </button>
            {:else if workoutState === 'active'}
              <!-- Center: FINISH (wider) -->
              <button class="col-span-3 h-[52px] border-none rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-[#4ade80] text-black" onclick={finishWorkout}>
                FINISH
              </button>
              <!-- Right: CANCEL (hold, narrow) -->
              <button class="col-span-1 h-[52px] border border-[#3f1515] rounded-xl bg-transparent text-[#f87171] font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center relative overflow-hidden"
                onmousedown={startCancelHold} onmouseup={stopCancelHold} onmouseleave={stopCancelHold} ontouchstart={startCancelHold} ontouchend={stopCancelHold}>
                <div class="absolute inset-0 bg-red-900/50 transition-all duration-[20ms]" style="width: {cancelProgress}%;"></div>
                <span class="relative z-10">CANCEL</span>
              </button>
            {:else if workoutState === 'done'}
              <!-- Center: WORKOUT COMPLETE (wider) -->
              <button class="col-span-3 h-[52px] border-none rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-[#14532d] text-[#4ade80] cursor-default">
                WORKOUT COMPLETE
              </button>
              <!-- Right: ERASE (hold to delete day's log) -->
              <button class="col-span-1 h-[52px] rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-[#141414] !text-zinc-500 border border-[#1e1e1e] !cursor-default relative overflow-hidden"
                onmousedown={startEraseHold} onmouseup={stopEraseHold} onmouseleave={stopEraseHold} ontouchstart={startEraseHold} ontouchend={stopEraseHold}>
                <div class="absolute inset-0 bg-red-900/50 transition-all duration-[20ms]" style="width: {eraseProgress}%;"></div>
                <span class="relative z-10">ERASE</span>
              </button>
            {:else if workoutState === 'skipped'}
              <!-- Center: SESSION SKIPPED (wider) -->
              <button class="col-span-3 h-[52px] border border-amber-900/40 rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-[#451a03]/20 text-amber-500 cursor-default">
                SESSION SKIPPED
              </button>
              <!-- Right: ERASE (hold to delete day's log) -->
              <button class="col-span-1 h-[52px] rounded-xl font-sans font-black text-[11px] tracking-[0.15em] flex items-center justify-center bg-[#141414] !text-zinc-500 border border-[#1e1e1e] !cursor-default relative overflow-hidden"
                onmousedown={startEraseHold} onmouseup={stopEraseHold} onmouseleave={stopEraseHold} ontouchstart={startEraseHold} ontouchend={stopEraseHold}>
                <div class="absolute inset-0 bg-red-900/50 transition-all duration-[20ms]" style="width: {eraseProgress}%;"></div>
                <span class="relative z-10">ERASE</span>
              </button>
            {/if}
          </div>
        {/if}
      </div>
      <!-- Template box on main screen -->
      <div class="tpl-header bg-[#141414] border border-[#1e1e1e] rounded-xl p-3 flex flex-col gap-2 {sessionStatus === 'green' ? '!bg-[#052e16] !border-emerald-700' : ''} {sessionStatus === 'yellow' ? '!bg-[#3f2a00] !border-amber-700' : ''}">
        <div class="flex items-center">
          {#if workoutState !== 'active'}
            <button class="w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center border {sessionStatus === 'green' ? 'border-emerald-700' : sessionStatus === 'yellow' ? 'border-amber-700' : 'border-[#1e1e1e]'} bg-transparent {sessionStatus === 'green' ? 'text-[#4ade80] hover:text-white' : sessionStatus === 'yellow' ? 'text-[#fbbf24] hover:text-white' : 'text-zinc-500 hover:text-white'}" onclick={() => currentView = 'swap_template'} title="Swap Template"><Repeat class="size-4" /></button>
          {:else}
            <div class="w-8 h-8 flex-shrink-0"></div>
          {/if}
          <div class="flex-1 text-center px-2 min-w-0">
            <span class="inline-flex items-center">
              <span class="tpl-name text-lg font-semibold tracking-tight text-white truncate">[ {activeTemplate.name} ]</span>
              {#if isPerfectDay}
                <span class="text-[9px] font-extrabold tracking-wider text-[#fbbf24] bg-[#1c1200] border border-[#713f12] rounded px-1.5 py-0.5 ml-1.5 whitespace-nowrap">PERFECT DAY</span>
              {/if}
            </span>
          </div>
          {#if workoutState !== 'active'}
            <button class="w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center border {sessionStatus === 'green' ? 'border-emerald-700' : sessionStatus === 'yellow' ? 'border-amber-700' : 'border-[#1e1e1e]'} bg-transparent {sessionStatus === 'green' ? 'text-[#4ade80] hover:text-white' : sessionStatus === 'yellow' ? 'text-[#fbbf24] hover:text-white' : 'text-zinc-500 hover:text-white'}" onclick={() => currentView = 'edit_template'} title="Edit Exercises"><Pencil class="size-4" /></button>
          {:else}
            <div class="w-8 h-8 flex-shrink-0"></div>
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
      <div class="bg-[#141414] border border-[#1e1e1e] rounded-xl overflow-hidden">
        {#each activeTemplate.exercises as exercise, index}
          {@const status = getExerciseStatus(exercise)}
          {@const isTargetMet = status === 'green'}
          {@const isTimeEx = exercise.exercise_type === 'time'}
          {@const hasActiveTimerThis = isTimeEx && activeTimerExerciseId === exercise.id && activeTimerSetIndex !== null}
          {@const timeTotal = isTimeEx ? (exercise.target_minutes * 60 + exercise.target_seconds) : 0}
          {@const isDoneToday = workoutState === 'done' && isViewingToday && todayLog?.workout_snapshot?.exercises}
          {@const loggedEx = isDoneToday ? todayLog.workout_snapshot.exercises.find((e: any) => e.id === exercise.id) : null}
          {@const displayCurrentWeight = loggedEx?.weight_before ?? exercise.current_weight}
          <div class="p-3.5 flex gap-2 {index > 0 ? 'border-t border-[#1e1e1e]' : ''} {status === 'green' ? '!border-emerald-700 !bg-[#052e16]' : ''} {status === 'yellow' ? '!border-amber-700 !bg-[#3f2a00]' : ''}">
            <!-- list number on left: boxed, vertically centered in strip, slightly larger -->
            <div class="w-6 flex-shrink-0 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded text-[11px] font-medium text-zinc-400
              {status === 'green' ? '!bg-[#052e16] !border-emerald-700 !text-white' : ''} 
              {status === 'yellow' ? '!bg-[#3f2a00] !border-amber-700 !text-white' : ''}">
              {index + 1}
            </div>
            <div class="flex-1 flex flex-col gap-2">
              <div class="ex-top flex justify-between items-start">
              <div class="truncate pr-2">
                <div class="ex-name-row flex items-center gap-2">
                  {#if exercise.exercise_type === 'reps'}
                    <Dumbbell class="size-4 text-white shrink-0" />
                  {:else}
                    <Timer class="size-4 text-white shrink-0" />
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
                    <div class="text-2xl font-extrabold tracking-tighter {isOvertime ? 'text-[#4ade80]' : 'text-white'}">{isOvertime ? '+' : ''}{m}<span class="unit text-[10px] text-zinc-400 font-normal ml-1 tracking-[1px]">M</span> {s}<span class="unit text-[10px] text-zinc-400 font-normal ml-1 tracking-[1px]">S</span></div>
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
                    {@const repsValue = trackedReps[`${exercise.id}-${s}`]}
                    {@const isEditingThisSet = editingSetKey === `${exercise.id}-${s}`}
                    <div class="relative h-8 rounded-lg bg-[#0d0d0d] border border-[#1a1a1a] flex flex-col items-center justify-center transition-all overflow-hidden
                      {bubbleStatus === 'green' ? '!bg-emerald-800 !border-emerald-500 !text-white' : ''} 
                      {bubbleStatus === 'yellow' ? '!bg-amber-800 !border-amber-500 !text-white' : ''}">
                      
                      {#if isEditingThisSet}
                        <input type="number" id="input-{exercise.id}-{s}" value={repsValue !== undefined ? repsValue : ''} placeholder={exercise.target_reps.toString()}
                          class="absolute inset-0 w-full h-full bg-transparent border-none outline-none text-center font-sans text-xs font-extrabold text-white"
                          onblur={() => saveManualRepEdit(exercise.id, s)}
                          onkeydown={(e) => { if (e.key === 'Enter') saveManualRepEdit(exercise.id, s); }} />
                      {:else}
                        <button class="w-full h-full flex flex-col items-center justify-center bg-transparent border-none p-0 text-zinc-400 font-sans"
                          onclick={() => handleSetBubbleClick(exercise.id, s, exercise.target_reps)}
                          disabled={workoutState !== 'active'}>
                          <span class="sl text-[10px] tracking-wider opacity-50 block">S{s + 1}</span>
                          <span class="sv text-xs font-extrabold block text-current">{repsValue !== undefined ? `${repsValue}R` : '—'}</span>
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
                <div class="h-8 flex items-center gap-2 text-sm leading-none text-white">
                  <div class="flex-1 h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden">
                    <div class="h-1.5 rounded-full transition-all" style="width:{prog}%; background:{countdownSeconds >= timeTotal ? '#4ade80' : 'white'}"></div>
                  </div>
                  <div class="flex gap-1 pl-1 border-l border-[#222] text-white">
                    <button class="hover:text-zinc-300 active:scale-95 transition" onclick={toggleExerciseTimer}>
                      {#if countdownRunning}<Pause class="size-5 fill-current" />{:else}<Play class="size-5 fill-current" />{/if}
                    </button>
                    <button class="text-white hover:text-zinc-300 active:scale-95 transition" onclick={() => stopAndSaveTimedSet(exercise.id, s, timeTotal)}>
                      <Square class="size-5 fill-current" />
                    </button>
                  </div>
                </div>
              {:else}
                <div class="set-row grid gap-1" style="grid-template-columns: repeat({exercise.target_sets}, minmax(0, 1fr));">
                  {#each Array(exercise.target_sets) as _, s}
                    {@const bubbleStatus = getSetBubbleStatus(exercise.id, s)}
                    {@const saved = completedTimers[`${exercise.id}-${s}`]}
                    <div class="relative h-8 rounded-lg bg-[#0d0d0d] border border-[#1a1a1a] flex flex-col items-center justify-center transition-all overflow-hidden text-[10px]
                      {bubbleStatus === 'green' ? '!bg-emerald-800 !border-emerald-500 !text-white' : ''} 
                      {bubbleStatus === 'yellow' ? '!bg-amber-800 !border-amber-500 !text-white' : ''}">
                      <button class="w-full h-full flex flex-col items-center justify-center bg-transparent border-none p-0 text-white font-sans"
                        onclick={() => activateOrSwitchTimeSet(exercise.id, s)}
                        disabled={workoutState !== 'active'}>
                        <span class="sl text-[10px] tracking-wider opacity-50 block">S{s + 1}</span>
                        <span class="sv text-xs font-extrabold block text-current leading-none">{saved ? saved.result : '—'}</span>
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
    <div class="bg-[#141414] border border-[#1e1e1e] rounded-xl p-4 space-y-4">
      <div class="flex items-center gap-2 border-b border-zinc-800 pb-3">
        <button class="w-8 h-8 rounded-lg border border-zinc-800 bg-transparent text-white flex items-center justify-center text-xs" onclick={() => currentView = 'track'}><ArrowLeft class="size-4" /></button>
        <span class="text-xs font-bold tracking-wider text-zinc-400">ASSIGN ROUTINE TEMPLATE</span>
      </div>

      <div class="space-y-2">
        <span class="text-[10px] text-zinc-500 block">MOUNT TEMPLATE TO {DAYS[selectedDay]}:</span>
        <div class="flex flex-col gap-1">
          <button class="w-full text-left px-3 py-2.5 rounded-lg border border-dashed border-zinc-800 bg-transparent text-xs text-red-400 flex justify-between items-center"
            onclick={async () => { await db.assignTemplateToDay(selectedDay, null); await loadData(); currentView = 'track'; }}>
            <span>[ REST DAY ]</span>
            {#if !currentDaySchedule?.template_id}<span class="text-[9px] bg-red-950/40 px-1 rounded border border-red-900">ACTIVE</span>{/if}
          </button>
          
          {#each templates as template}
            <button class="w-full text-left px-3 py-2.5 rounded-lg border border-zinc-800 bg-zinc-900 text-xs flex justify-between items-center transition-all hover:border-zinc-700
              {currentDaySchedule?.template_id === template.id ? 'border-emerald-500 text-emerald-400 bg-emerald-950/10' : 'text-zinc-400'}"
              onclick={async () => { await db.assignTemplateToDay(selectedDay, template.id); await loadData(); currentView = 'track'; }}>
              <span>[ {template.name} ]</span>
              {#if currentDaySchedule?.template_id === template.id}<span class="text-[9px] bg-emerald-950 px-1 rounded border border-emerald-800">MOUNTED</span>{/if}
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
          onclick={async () => { await commitDraftExercises(); currentView = 'track'; }}
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
          <button class="px-3 py-1 bg-zinc-900 border border-zinc-800 text-xs font-bold rounded-lg" onclick={() => currentView = 'swap_template'}>Assign or Create</button>
        </div>
      {:else}
        <!-- Exercises list - minimal and balanced -->
        <div>
          <div class="text-[9px] text-zinc-500 tracking-widest mb-1">EXERCISES</div>
          {#if draftExercises.length === 0}
            <div class="text-center py-4 border border-dashed border-zinc-800 rounded-lg text-xs text-zinc-600">No exercises yet</div>
          {/if}

          <div class="space-y-1">
            {#each draftExercises as exercise, index}
              <div class="flex items-stretch gap-1">
                <!-- Number box in front of the exercise name box -->
                <div class="w-6 flex-shrink-0 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded text-[10px] font-medium text-zinc-400">
                  {index + 1}
                </div>
                <!-- Exercise field box -->
                <div class="flex-1 p-1.5 bg-zinc-950 border border-zinc-800 rounded text-xs flex items-center justify-between">
                  <div class="flex items-center gap-1.5 min-w-0">
                    {#if exercise.exercise_type === 'reps'}
                      <Dumbbell class="size-3 text-white flex-shrink-0" />
                    {:else}
                      <Timer class="size-3 text-white flex-shrink-0" />
                    {/if}
                    <span class="font-medium truncate text-white">{exercise.name}</span>
                    <span class="text-[9px] text-zinc-500 whitespace-nowrap ml-1">
                      {exercise.exercise_type === 'reps' ? `${exercise.target_sets}×${exercise.target_reps} @${exercise.current_weight ?? 0}kg +${exercise.increment}kg` : `${exercise.target_sets}× ${exercise.target_minutes}m${exercise.target_seconds}s +${exercise.increment}s`}
                    </span>
                  </div>
                  <!-- Reorder inside the box -->
                  <div class="flex gap-0.5 ml-2">
                    <button class="px-0.5 py-0.5 bg-zinc-900 border border-zinc-800 rounded text-[9px] disabled:opacity-20" disabled={index === 0} onclick={() => handleMoveExercise(index, 'up')}><ArrowUp class="size-2.5" /></button>
                    <button class="px-0.5 py-0.5 bg-zinc-900 border border-zinc-800 rounded text-[9px] disabled:opacity-20" disabled={index === draftExercises.length - 1} onclick={() => handleMoveExercise(index, 'down')}><ArrowDown class="size-2.5" /></button>
                  </div>
                </div>
                <!-- Edit and delete outside, full height of the box -->
                <button class="px-2 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-[10px] h-full flex items-center justify-center text-zinc-400" onclick={() => startEditingExercise(exercise)}><Pencil class="size-4" /></button>
                <button class="px-2 py-1.5 bg-red-950/40 border border-red-900 text-red-400 rounded text-[10px] h-full flex items-center justify-center" onclick={() => handleDeleteExercise(exercise.id)}><Trash2 class="size-4" /></button>
              </div>
            {/each}
          </div>
        </div>

        <!-- Add / edit form - tight and consistent -->
        <div class="pt-3 border-t border-zinc-800 space-y-2">
          <div class="text-[9px] text-zinc-500 tracking-widest">{editingExerciseId ? 'EDIT EXERCISE' : 'ADD EXERCISE'}</div>

          <!-- Type switcher -->
          <div class="grid grid-cols-2 gap-1">
            <button 
              class="py-1 text-[10px] rounded border transition-all {newExerciseType === 'reps' ? 'bg-zinc-800 text-white border-zinc-700' : 'text-zinc-500 border-zinc-800'}"
              onclick={() => { newExerciseType = 'reps'; if (!editingExerciseId) { newExerciseSets = 3; newExerciseReps = 12; newExerciseBaseKg = 15; newExerciseWeightIncrement = 2.5; } }}
            >REPS / SETS</button>
            <button 
              class="py-1 text-[10px] rounded border transition-all {newExerciseType === 'time' ? 'bg-zinc-800 text-white border-zinc-700' : 'text-zinc-500 border-zinc-800'}"
              onclick={() => { newExerciseType = 'time'; if (!editingExerciseId) { newExerciseSets = 2; newExerciseMinutes = 0; newExerciseSeconds = 30; newExerciseWeightIncrement = 5; } }}
            >TIME / SETS</button>
          </div>

          <input 
            placeholder="Exercise name" 
            class="w-full bg-black border border-zinc-800 text-xs text-white p-1.5 rounded-lg outline-none focus:border-zinc-700" 
            bind:value={newExerciseName} 
          />
          
          {#if editingExerciseId}
            <div class="flex items-center justify-between text-[9px]">
              <span class="text-amber-500">Editing</span>
              <button class="text-zinc-400 hover:text-white" onclick={() => { editingExerciseId = null; resetNewExerciseForm(); }}>Cancel</button>
            </div>
          {/if}

          <!-- Params grid - balanced -->
          {#if newExerciseType === 'reps'}
            <div class="grid grid-cols-4 gap-1 text-[9px]">
              <div>
                <span class="text-zinc-500 block mb-0.5">Sets</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" bind:value={newExerciseSets} />
              </div>
              <div>
                <span class="text-zinc-500 block mb-0.5">Reps</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" bind:value={newExerciseReps} />
              </div>
              <div>
                <span class="text-zinc-500 block mb-0.5">Base kg</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" bind:value={newExerciseBaseKg} />
              </div>
              <div>
                <span class="text-zinc-500 block mb-0.5">+ kg</span>
                <input type="number" step="0.5" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" bind:value={newExerciseWeightIncrement} />
              </div>
            </div>
          {:else}
            <div class="grid grid-cols-4 gap-1 text-[9px]">
              <div>
                <span class="text-zinc-500 block mb-0.5">Sets</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" bind:value={newExerciseSets} />
              </div>
              <div>
                <span class="text-zinc-500 block mb-0.5">Min</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" bind:value={newExerciseMinutes} />
              </div>
              <div>
                <span class="text-zinc-500 block mb-0.5">Sec</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" bind:value={newExerciseSeconds} />
              </div>
              <div>
                <span class="text-zinc-500 block mb-0.5">+ s</span>
                <input type="number" class="w-full bg-black border border-zinc-800 text-center text-xs p-1 rounded text-white outline-none" bind:value={newExerciseWeightIncrement} />
              </div>
            </div>
          {/if}

          <button class="w-full py-1.5 text-xs bg-zinc-800 text-white rounded border border-zinc-700 font-medium hover:bg-zinc-700 transition-colors" onclick={handleSaveExerciseToDraft}>
            {editingExerciseId ? 'Update' : 'Add'}
          </button>
        </div>
      {/if}
    </div>
  {/if}

</div>
