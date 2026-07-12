<script lang="ts">
  import { onDestroy } from 'svelte';
  import { db, type Routine, type RoutineWithOwner } from '$lib/db';
  import { runDbActivityBatch } from '$lib/dbActivity';
  import GeneratedAvatar from '$lib/components/GeneratedAvatar.svelte';
  import {
    ArrowLeft,
    Plus,
    Pencil,
    Trash2,
    Bookmark,
    Copy,
    Download,
  } from '@lucide/svelte';

  let {
    onBack = () => {},
    onEditRoutine = (_routineId: string) => {},
    onDownload = (_routineId: string) => {},
    onActivate = (_routineId: string) => {},
    currentUserId = '',
    activeRoutineId = $bindable<string | null>(null),
    initialRoutines = [] as Routine[],
    initialAllRoutines = [] as RoutineWithOwner[],
    initialBookmarkIds = [] as string[],
  }: {
    onBack?: () => void;
    onEditRoutine?: (routineId: string) => void;
    onDownload?: (routineId: string) => void;
    onActivate?: (routineId: string) => void;
    currentUserId?: string;
    activeRoutineId?: string | null;
    initialRoutines?: Routine[];
    initialAllRoutines?: RoutineWithOwner[];
    initialBookmarkIds?: string[];
  } = $props();

  let myRoutines = $state<Routine[]>(initialRoutines);
  let allRoutines = $state<RoutineWithOwner[]>(initialAllRoutines);
  let bookmarks = $state<Set<string>>(new Set(initialBookmarkIds));
  let busyAction = $state<string | null>(null);
  let errorMsg = $state<string | null>(null);
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');
  let selectedAllId = $state<string | null>(null);

  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  const ROW_TOTAL = 40;
  let draggedRoutineIndex = $state<number | null>(null);
  let dragOverRoutineIndex = $state<number | null>(null);
  let routineListBody = $state<HTMLDivElement | undefined>();
  let routineRowDragged = $state(false);

  function dragShift(draggedIdx: number | null, overIdx: number | null, itemIdx: number): number {
    if (draggedIdx == null || overIdx == null || draggedIdx === overIdx) return 0;
    if (itemIdx === draggedIdx) return 0;
    if (draggedIdx < overIdx) {
      if (itemIdx > draggedIdx && itemIdx <= overIdx) return -ROW_TOTAL;
    } else {
      if (itemIdx >= overIdx && itemIdx < draggedIdx) return ROW_TOTAL;
    }
    return 0;
  }

  function computeRowIndex(e: DragEvent, container: HTMLElement, maxIndex: number, firstRowOffset = 0): number {
    const rect = container.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const idx = Math.floor((y - firstRowOffset) / ROW_TOTAL);
    return Math.max(0, Math.min(maxIndex, idx));
  }

  function handleDragStart(e: DragEvent, index: number) {
    draggedRoutineIndex = index;
    dragOverRoutineIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index.toString());
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (!routineListBody) return;
    const idx = computeRowIndex(e, routineListBody, myRoutines.length - 1);
    if (dragOverRoutineIndex !== idx) dragOverRoutineIndex = idx;
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOverRoutineIndex = null;
    if (draggedRoutineIndex === null || !routineListBody) {
      draggedRoutineIndex = null;
      return;
    }
    const targetIndex = computeRowIndex(e, routineListBody, myRoutines.length - 1);
    if (draggedRoutineIndex === targetIndex) {
      draggedRoutineIndex = null;
      return;
    }
    const arr = [...myRoutines];
    const [moved] = arr.splice(draggedRoutineIndex, 1);
    arr.splice(targetIndex, 0, moved);
    myRoutines = arr;
    draggedRoutineIndex = null;
    const orders = arr.map((r, i) => ({ id: r.id, display_order: i }));
    try {
      await runDbActivityBatch(() => db.updateRoutineDisplayOrders(orders));
    } catch (e) {
      console.error('Failed to persist routine reorder', e);
      errorMsg = 'Failed to reorder routines';
    }
  }

  function handleDragEnd() {
    const wasDragging = draggedRoutineIndex !== null;
    draggedRoutineIndex = null;
    dragOverRoutineIndex = null;
    if (wasDragging) {
      routineRowDragged = true;
      setTimeout(() => { routineRowDragged = false; }, 100);
    }
  }

  $effect(() => {
    if (initialRoutines.length > 0) myRoutines = initialRoutines;
  });

  $effect(() => {
    if (initialAllRoutines.length > 0) {
      allRoutines = currentUserId
        ? initialAllRoutines.filter((r) => r.user_id !== currentUserId)
        : initialAllRoutines;
    }
  });

  $effect(() => {
    if (initialBookmarkIds.length > 0) bookmarks = new Set(initialBookmarkIds);
  });

  $effect(() => {
    if (myRoutines.length === 0 && allRoutines.length === 0) {
      loadAll();
    }
    refreshTimer = setInterval(loadAllUsersSection, 15000);
    return () => {
      if (refreshTimer) clearInterval(refreshTimer);
    };
  });

  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });

  async function loadAll() {
    await Promise.all([loadMyRoutines(), loadAllUsersSection()]);
  }

  async function loadMyRoutines() {
    if (myRoutines.length > 0) return;
    try {
      myRoutines = await db.getMyRoutines();
      if (myRoutines.length === 0) {
        const created = await db.ensureDefaultRoutine();
        if (created) {
          myRoutines = await db.getMyRoutines();
          activeRoutineId = created.id;
        }
      }
    } catch (e) {
      errorMsg = 'Failed to load your routines';
      console.error('loadMyRoutines', e);
    }
  }

  async function loadAllUsersSection() {
    try {
      const [routines, bm] = await Promise.all([
        db.getAllUsersAndRoutines(),
        db.getUserBookmarks(),
      ]);
      allRoutines = currentUserId ? routines.filter((r) => r.user_id !== currentUserId) : routines;
      bookmarks = new Set(bm.map((b) => b.routine_id));
    } catch (e) {
      errorMsg = 'Failed to load community routines';
      console.error('loadAllUsersSection', e);
    }
  }

  async function addRoutine() {
    errorMsg = null;
    const optimistic: Routine = { id: 'temp-' + Date.now(), user_id: '', name: 'NEW ROUTINE', created_at: '', template_count: 0 };
    myRoutines = [...myRoutines, optimistic];
    try {
      const r = await runDbActivityBatch(() => db.createRoutine('NEW ROUTINE'));
      myRoutines = myRoutines.map((x) => x.id === optimistic.id ? r : x);
      renameRoutine(r.id);
    } catch (e) {
      myRoutines = myRoutines.filter((x) => x.id !== optimistic.id);
      errorMsg = 'Failed to create routine';
      console.error(e);
    }
  }

  function renameRoutine(id: string) {
    const r = myRoutines.find((r) => r.id === id);
    renamingId = id;
    renameValue = r?.name ?? '';
  }

  async function saveRename(id: string) {
    const value = renameValue.trim().toUpperCase();
    const prev = myRoutines.find((r) => r.id === id);
    myRoutines = myRoutines.map((r) => (r.id === id ? { ...r, name: value } : r));
    try {
      await runDbActivityBatch(() => db.renameRoutine(id, value));
    } catch (e) {
      if (prev) myRoutines = myRoutines.map((r) => (r.id === id ? { ...r, name: prev.name } : r));
      console.error(e);
    } finally {
      renamingId = null;
      renameValue = '';
    }
  }

  async function deleteRoutine(id: string) {
    if (myRoutines.length <= 1) return;
    const idx = myRoutines.findIndex((r) => r.id === id);
    const deleted = myRoutines.filter((r) => r.id === id);
    myRoutines = myRoutines.filter((r) => r.id !== id);
    if (activeRoutineId === id) {
      const prevIdx = Math.max(0, idx - 1);
      const nextActive = myRoutines[prevIdx]?.id ?? myRoutines[0]?.id ?? null;
      if (nextActive) {
        activeRoutineId = nextActive;
        try {
          await runDbActivityBatch(() => db.setActiveRoutine(nextActive));
          onActivate(nextActive);
        } catch (e) {
          console.error('Failed to activate fallback routine', e);
        }
      }
    }
    try {
      await runDbActivityBatch(() => db.deleteRoutine(id));
    } catch (e) {
      myRoutines = [...myRoutines, ...deleted];
      errorMsg = 'Failed to delete routine';
      console.error(e);
    }
  }

  async function activateRoutine(id: string) {
    if (busyAction !== null) return;
    busyAction = id;
    errorMsg = null;
    const prevActive = activeRoutineId;
    activeRoutineId = id;
    try {
      await runDbActivityBatch(() => db.setActiveRoutine(id));
      onActivate(id);
    } catch (e) {
      activeRoutineId = prevActive;
      errorMsg = 'Failed to activate routine';
      console.error(e);
    } finally {
      busyAction = null;
    }
  }

  async function toggleBookmark(routineId: string) {
    busyAction = routineId;
    errorMsg = null;
    const wasBookmarked = bookmarks.has(routineId);
    if (wasBookmarked) {
      bookmarks.delete(routineId);
    } else {
      bookmarks.add(routineId);
    }
    bookmarks = new Set(bookmarks);
    try {
      if (wasBookmarked) {
        const bm = (await db.getUserBookmarks()).find((b) => b.routine_id === routineId);
        if (bm) await runDbActivityBatch(() => db.unbookmarkRoutine(bm.id));
      } else {
        await runDbActivityBatch(() => db.bookmarkRoutine(routineId));
      }
    } catch (e) {
      if (wasBookmarked) bookmarks.add(routineId); else bookmarks.delete(routineId);
      bookmarks = new Set(bookmarks);
      errorMsg = 'Failed to toggle bookmark';
      console.error(e);
    } finally {
      busyAction = null;
    }
  }

  async function copyRoutine(routineId: string) {
    busyAction = routineId;
    errorMsg = null;
    const optimistic: Routine = { id: 'temp-' + Date.now(), user_id: '', name: 'COPYING…', created_at: '', template_count: 0 };
    myRoutines = [...myRoutines, optimistic];
    try {
      const newRoutine = await runDbActivityBatch(() => db.copyRoutine(routineId));
      myRoutines = myRoutines.map((x) => x.id === optimistic.id ? newRoutine : x);
    } catch (e) {
      myRoutines = myRoutines.filter((x) => x.id !== optimistic.id);
      errorMsg = 'Failed to copy routine';
      console.error(e);
    } finally {
      busyAction = null;
    }
  }

  function handleEdit(routineId: string) {
    activateRoutine(routineId).then(() => onEditRoutine(routineId));
  }

  function handleRowClick(routine: Routine) {
    if (routineRowDragged) return;
    if (busyAction !== null) return;
    activateRoutine(routine.id);
  }
</script>

<div class="flex flex-col gap-3 min-h-0 flex-1">
  <div class="flex items-center gap-2 border-b border-[#1e1e1e] pb-2 min-h-8">
    <button
      type="button"
      class="w-8 h-8 shrink-0 rounded-lg border border-[#1e1e1e] bg-transparent text-white flex items-center justify-center"
      onclick={onBack}
      title="Go back"
    >
      <ArrowLeft class="size-4" />
    </button>
    <span class="text-xs font-bold tracking-wider text-zinc-400 leading-none shrink-0">ROUTINES</span>
    <div class="flex-1"></div>
    {#if activeRoutineId}
      <button
        type="button"
        class="w-8 h-8 shrink-0 rounded-lg border border-[#1e1e1e] bg-transparent text-zinc-400 hover:text-white hover:bg-[#1a1a1a] flex items-center justify-center transition-colors"
        title="Export active routine as CSV"
        onclick={() => onDownload(activeRoutineId)}
      >
        <Download class="size-4" />
      </button>
    {/if}
  </div>

  {#if errorMsg}
    <div class="text-[9px] text-red-400 text-center">{errorMsg}</div>
  {/if}

  <!-- YOUR ROUTINES -->
  <div>
    <div class="flex items-center gap-2 mb-1.5">
      <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">YOUR ROUTINES</span>
    </div>

    {#if myRoutines.length === 0}
      <div class="text-[10px] text-zinc-600 text-center py-4">No routines yet</div>
    {:else}
      <div class="flex flex-col gap-1"
        role="list"
        bind:this={routineListBody}
        ondrop={handleDrop}
        ondragover={handleDragOver}
      >
        {#each myRoutines as routine, index (routine.id)}
          {@const isActive = activeRoutineId === routine.id}
          <div
            class="flex items-stretch gap-1 h-9 cursor-grab active:cursor-grabbing"
            style="transform: translateY({dragShift(draggedRoutineIndex, dragOverRoutineIndex, index)}px); transition: transform 150ms ease; {draggedRoutineIndex === index ? 'opacity: 0.25;' : ''}"
            draggable="true"
            ondragstart={(e) => handleDragStart(e, index)}
            ondragend={handleDragEnd}
          >
            <button
              type="button"
              class="w-6 h-9 shrink-0 flex items-center justify-center border rounded text-[10px] font-medium leading-none transition-colors {isActive ? '' : 'bg-[#141414] border-[#1e1e1e] text-zinc-400 hover:border-[#2a2a2a] hover:text-zinc-200'}"
              style={isActive ? `background-color: color-mix(in srgb, white 15%, #141414); border-color: white; color: white` : ''}
              onclick={() => handleRowClick(routine)}
            >
              {index + 1}
            </button>

            <div
              class="flex-1 h-9 min-w-0 px-1.5 border rounded text-xs flex items-center transition-colors cursor-pointer {isActive ? '' : 'bg-[#0d0d0d] border-[#1e1e1e] hover:bg-[#141414] hover:border-[#2a2a2a]'}"
              style={isActive ? `background-color: color-mix(in srgb, white 8%, #0d0d0d); border-color: white; color: white` : ''}
              role="button"
              tabindex="0"
              onclick={() => handleRowClick(routine)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleRowClick(routine); } }}
            >
              <div class="flex items-center gap-1 min-w-0 flex-1">
                {#if renamingId === routine.id}
                  <input
                    autocomplete="off"
                    class="font-medium bg-transparent border-0 p-0 m-0 focus:outline-none focus:ring-0 text-xs uppercase flex-1 min-w-0 truncate leading-none"
                    style={isActive ? `color: white` : `color: #aaa`}
                    bind:value={renameValue}
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') saveRename(routine.id);
                      if (e.key === 'Escape') renamingId = null;
                    }}
                    onblur={() => saveRename(routine.id)}
                  />
                {:else}
                  <span
                    class="font-medium text-xs flex-1 min-w-0 truncate leading-none select-none {isActive ? 'text-white' : 'text-zinc-400'}"
                    ondblclick={(e) => {
                      e.stopPropagation();
                      renameRoutine(routine.id);
                    }}
                  >{routine.name}</span>
                {/if}

                {#if routine.template_count && routine.template_count > 0}
                  <span class="text-[9px] shrink-0 px-1.5 py-0.5 rounded border leading-none"
                    style={isActive
                      ? `background-color: color-mix(in srgb, white 20%, #1e1e1e); border-color: white; color: white;`
                      : `background-color: #1e1e1e; border-color: #2a2a2a; color: #aaa;`}>
                    {routine.template_count} TEMPLATE{routine.template_count === 1 ? '' : 'S'}
                  </span>
                {/if}

                {#if isActive}
                  <span class="text-[9px] shrink-0 px-1.5 py-0.5 rounded border leading-none"
                    style="background-color: color-mix(in srgb, white 20%, #1e1e1e); border-color: white; color: white;">
                    ASSIGNED
                  </span>
                {/if}
                {#if isActive}
                  <button
                    type="button"
                    class="w-7 h-7 shrink-0 flex items-center justify-center rounded border transition-colors"
                    style="background-color: color-mix(in srgb, white 20%, #1e1e1e); color: white; border-color: white;"
                    title="Rename"
                    onclick={(e) => { e.stopPropagation(); renameRoutine(routine.id); }}
                  >
                    <Pencil class="size-3 pointer-events-none" />
                  </button>
                  {#if myRoutines.length > 1}
                    <button
                      type="button"
                      class="w-7 h-7 shrink-0 flex items-center justify-center rounded border border-red-900/80 bg-red-950/50 text-red-400 hover:text-red-300 hover:border-red-800 transition-colors"
                      title="Delete routine"
                      onclick={(e) => { e.stopPropagation(); deleteRoutine(routine.id); }}
                      disabled={busyAction !== null}
                    >
                      <Trash2 class="size-3.5 pointer-events-none" />
                    </button>
                  {/if}
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <div class="library-actions mt-1.5">
      <button
        type="button"
        class="library-action-btn library-action-btn--new"
        onclick={addRoutine}
        disabled={busyAction !== null}
        title="Create a new routine"
        aria-label="Create new routine"
      >
        <Plus class="size-3.5" strokeWidth={3} />
        <span>NEW</span>
      </button>
    </div>
  </div>

  <!-- ALL USERS -->
  <div>
    <div class="flex items-center gap-2 mb-1.5">
      <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">ALL USERS</span>
      <span class="text-[8px] text-zinc-600">(auto-refresh)</span>
    </div>

    {#if allRoutines.length === 0}
      <div class="text-[10px] text-zinc-600 text-center py-4">No routines found</div>
    {:else}
      <div class="flex flex-col gap-1">
        {#each allRoutines as routine, index (routine.id)}
          {@const isSelected = selectedAllId === routine.id}
          <div
            class="flex items-stretch gap-1 h-9 cursor-pointer"
            onclick={() => { selectedAllId = selectedAllId === routine.id ? null : routine.id; }}
            role="button"
            tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectedAllId = selectedAllId === routine.id ? null : routine.id; } }}
          >
            <div
              class="w-6 h-9 shrink-0 flex items-center justify-center border rounded text-[10px] font-medium leading-none transition-colors {isSelected ? '' : 'bg-[#141414] border-[#1e1e1e] text-zinc-400'}"
              style={isSelected ? `background-color: color-mix(in srgb, white 15%, #141414); border-color: white; color: white` : ''}
            >
              {index + 1}
            </div>
            <div
              class="flex-1 h-9 min-w-0 px-1.5 border rounded text-xs flex items-center transition-colors {isSelected ? '' : 'bg-[#0d0d0d] border-[#1e1e1e]'}"
              style={isSelected ? `background-color: color-mix(in srgb, white 8%, #0d0d0d); border-color: white; color: white` : ''}
            >
              <div class="flex items-center gap-1 min-w-0 flex-1">
                <GeneratedAvatar userId={routine.user_id} seed={routine.owner_avatar_seed ?? undefined} size={20} rounded={4} className="rounded shrink-0" />
                <span
                  class="text-[9px] font-semibold shrink-0 px-1.5 py-0.5 rounded leading-none {isSelected ? 'bg-white/20 text-white' : 'bg-[#1e1e1e] text-zinc-500'}"
                  style="border-color: {isSelected ? 'white' : '#2a2a2a'}; border-width: 1px;"
                >@{routine.owner_username}</span>
                <span class="font-medium text-xs truncate leading-none {isSelected ? 'text-white' : 'text-zinc-400'}">{routine.name}</span>
                <div class="flex-1"></div>
                {#if isSelected}
                  <button
                    type="button"
                    class="w-7 h-7 shrink-0 flex items-center justify-center rounded border transition-colors"
                    style={bookmarks.has(routine.id)
                      ? `background-color: color-mix(in srgb, white 20%, #1e1e1e); color: white; border-color: white;`
                      : `background-color: transparent; color: #888; border-color: #333;`}
                    title={bookmarks.has(routine.id) ? 'Remove bookmark' : 'Bookmark routine'}
                    onclick={(e) => { e.stopPropagation(); toggleBookmark(routine.id); }}
                    disabled={busyAction !== null}
                  >
                    {#if bookmarks.has(routine.id)}
                      <Bookmark class="size-3.5 pointer-events-none" fill="currentColor" />
                    {:else}
                      <Bookmark class="size-3.5 pointer-events-none" />
                    {/if}
                  </button>
                  <button
                    type="button"
                    class="w-7 h-7 shrink-0 flex items-center justify-center rounded border border-blue-900/80 bg-blue-950/50 text-blue-400 hover:text-blue-300 hover:border-blue-800 transition-colors"
                    title="Copy routine to your account"
                    onclick={(e) => { e.stopPropagation(); copyRoutine(routine.id); }}
                    disabled={busyAction !== null}
                  >
                    <Copy class="size-3.5 pointer-events-none" />
                  </button>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
