<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    db,
    type Routine,
    type RoutineWithOwner,
    type UserRoutineListItem,
  } from '$lib/db';
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
    BookmarkX,
    Upload,
  } from '@lucide/svelte';

  let {
    onBack = () => {},
    onEditRoutine = (_routineId: string) => {},
    onViewRoutine = (_routineId: string) => {},
    onDownload = (_routineId: string) => {},
    onImport = async (_file: File) => {},
    onActivate = (_routineId: string) => {},
    onListChange = (_list: UserRoutineListItem[], _activeId: string | null) => {},
    currentUserId = '',
    activeRoutineId = $bindable<string | null>(null),
    initialList = [] as UserRoutineListItem[],
    initialAllRoutines = [] as RoutineWithOwner[],
    initialBookmarkIds = [] as string[],
  }: {
    onBack?: () => void;
    onEditRoutine?: (routineId: string) => void;
    onViewRoutine?: (routineId: string) => void;
    onDownload?: (routineId: string) => void;
    onImport?: (file: File) => void | Promise<void>;
    onActivate?: (routineId: string) => void;
    onListChange?: (list: UserRoutineListItem[], activeId: string | null) => void;
    currentUserId?: string;
    activeRoutineId?: string | null;
    initialList?: UserRoutineListItem[];
    initialAllRoutines?: RoutineWithOwner[];
    initialBookmarkIds?: string[];
  } = $props();

  /** Local source of truth while menu is open — never clobber from stale parent props. */
  let myList = $state<UserRoutineListItem[]>([...initialList]);
  let allRoutines = $state<RoutineWithOwner[]>(
    currentUserId
      ? initialAllRoutines.filter((r) => r.user_id !== currentUserId)
      : [...initialAllRoutines],
  );
  let bookmarks = $state<Set<string>>(new Set(initialBookmarkIds));
  let busyAction = $state<string | null>(null);
  let errorMsg = $state<string | null>(null);
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');
  let selectedAllId = $state<string | null>(null);
  let loading = $state(initialList.length === 0);

  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  const ROW_TOTAL = 40;
  let draggedRoutineIndex = $state<number | null>(null);
  let dragOverRoutineIndex = $state<number | null>(null);
  let routineListBody = $state<HTMLDivElement | undefined>();
  let routineRowDragged = $state(false);

  const ownedRoutines = $derived(myList.filter((r) => r.source === 'owned'));
  const canDeleteOwned = $derived(ownedRoutines.length > 1);

  /** Community routines grouped by owner for tree UI (one avatar/username line per user). */
  type UserRoutineGroup = {
    user_id: string;
    username: string;
    avatar_seed: string | null;
    routines: RoutineWithOwner[];
  };

  const allUsersGrouped = $derived.by((): UserRoutineGroup[] => {
    const order: string[] = [];
    const map = new Map<string, UserRoutineGroup>();
    for (const r of allRoutines) {
      // Already in your list as a bookmark — hide from discovery
      if (bookmarks.has(r.id)) continue;
      let g = map.get(r.user_id);
      if (!g) {
        g = {
          user_id: r.user_id,
          username: r.owner_username || 'unknown',
          avatar_seed: r.owner_avatar_seed ?? null,
          routines: [],
        };
        map.set(r.user_id, g);
        order.push(r.user_id);
      }
      g.routines.push(r);
    }
    // Drop empty user groups; stable username order
    return order
      .map((id) => map.get(id)!)
      .filter((g) => g.routines.length > 0)
      .sort((a, b) => a.username.localeCompare(b.username));
  });

  function emitListChange() {
    onListChange(myList, activeRoutineId);
  }

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

  function handleDragStart(e: DragEvent, index: number, item: UserRoutineListItem) {
    // Only owned routines are reorderable among owned block
    if (item.source !== 'owned') {
      e.preventDefault();
      return;
    }
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
    if (!routineListBody || draggedRoutineIndex === null) return;
    // Only reorder within owned prefix
    const ownedCount = ownedRoutines.length;
    const idx = computeRowIndex(e, routineListBody, Math.max(0, ownedCount - 1));
    if (dragOverRoutineIndex !== idx) dragOverRoutineIndex = idx;
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOverRoutineIndex = null;
    if (draggedRoutineIndex === null || !routineListBody) {
      draggedRoutineIndex = null;
      return;
    }
    const ownedCount = ownedRoutines.length;
    const targetIndex = computeRowIndex(e, routineListBody, Math.max(0, ownedCount - 1));
    if (draggedRoutineIndex === targetIndex || draggedRoutineIndex >= ownedCount) {
      draggedRoutineIndex = null;
      return;
    }
    const owned = [...ownedRoutines];
    const bookmarked = myList.filter((r) => r.source === 'bookmarked');
    const [moved] = owned.splice(draggedRoutineIndex, 1);
    owned.splice(targetIndex, 0, moved);
    myList = [...owned, ...bookmarked];
    draggedRoutineIndex = null;
    emitListChange();
    const orders = owned.map((r, i) => ({ id: r.id, display_order: i }));
    try {
      await runDbActivityBatch(() => db.updateRoutineDisplayOrders(orders));
    } catch (err) {
      console.error('Failed to persist routine reorder', err);
      errorMsg = 'Failed to reorder routines';
      await reloadList();
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

  async function reloadList() {
    // Don't clobber in-flight copy/create optimistic rows
    if (busyAction !== null) return;
    try {
      const list = await db.getUserRoutineList();
      if (destroyed || busyAction !== null) return;
      myList = list;
      bookmarks = new Set(list.filter((r) => r.source === 'bookmarked').map((r) => r.id));
      emitListChange();
    } catch (e) {
      console.error('reloadList', e);
    }
  }

  async function loadAllUsersSection() {
    if (busyAction !== null) return;
    try {
      const [routines, bm] = await Promise.all([
        db.getAllUsersAndRoutines(),
        db.getUserBookmarks(),
      ]);
      if (destroyed || busyAction !== null) return;
      allRoutines = currentUserId
        ? routines.filter((r) => r.user_id !== currentUserId)
        : routines;
      // Don't overwrite bookmark set during copy; only refresh when idle
      bookmarks = new Set(bm.map((b) => b.routine_id));
      if (myList.some((r) => r.source === 'bookmarked')) {
        await reloadList();
      }
    } catch (e) {
      errorMsg = 'Failed to load community routines';
      console.error('loadAllUsersSection', e);
    }
  }

  async function loadAll() {
    loading = true;
    errorMsg = null;
    try {
      let list = await db.getUserRoutineList();
      if (list.filter((r) => r.source === 'owned').length === 0) {
        const created = await db.ensureDefaultRoutine();
        if (created) {
          list = await db.getUserRoutineList();
          if (!activeRoutineId) {
            activeRoutineId = created.id;
          }
        }
      }
      if (destroyed) return;
      myList = list;
      bookmarks = new Set(list.filter((r) => r.source === 'bookmarked').map((r) => r.id));
      emitListChange();
      await loadAllUsersSection();
    } catch (e) {
      errorMsg = 'Failed to load routines';
      console.error('loadAll', e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadAll();
    refreshTimer = setInterval(() => {
      void loadAllUsersSection();
    }, 15000);
  });

  onDestroy(() => {
    destroyed = true;
    if (refreshTimer) clearInterval(refreshTimer);
  });

  async function addRoutine() {
    if (busyAction !== null) return;
    errorMsg = null;
    const optimistic: UserRoutineListItem = {
      id: 'temp-' + Date.now(),
      user_id: currentUserId,
      name: 'NEW ROUTINE',
      created_at: '',
      template_count: 0,
      source: 'owned',
      is_readonly: false,
    };
    myList = [...myList, optimistic];
    try {
      const r = await runDbActivityBatch(() => db.createRoutine('NEW ROUTINE'));
      myList = myList.map((x) =>
        x.id === optimistic.id
          ? { ...r, source: 'owned' as const, is_readonly: false }
          : x,
      );
      emitListChange();
      renameRoutine(r.id);
    } catch (e) {
      myList = myList.filter((x) => x.id !== optimistic.id);
      errorMsg = 'Failed to create routine';
      console.error(e);
    }
  }

  function renameRoutine(id: string) {
    const r = myList.find((r) => r.id === id);
    if (!r || r.source !== 'owned') return;
    renamingId = id;
    renameValue = r.name ?? '';
  }

  async function saveRename(id: string) {
    const item = myList.find((r) => r.id === id);
    if (!item || item.source !== 'owned') {
      renamingId = null;
      return;
    }
    const value = renameValue.trim().toUpperCase() || item.name;
    const prev = item.name;
    myList = myList.map((r) => (r.id === id ? { ...r, name: value } : r));
    emitListChange();
    try {
      await runDbActivityBatch(() => db.renameRoutine(id, value));
    } catch (e) {
      myList = myList.map((r) => (r.id === id ? { ...r, name: prev } : r));
      emitListChange();
      console.error(e);
    } finally {
      renamingId = null;
      renameValue = '';
    }
  }

  async function deleteOwnedRoutine(id: string) {
    const item = myList.find((r) => r.id === id);
    if (!item || item.source !== 'owned') return;
    if (ownedRoutines.length <= 1) {
      errorMsg = 'Keep at least one owned routine, or create a new one first';
      return;
    }
    errorMsg = null;
    const snapshot = myList;
    myList = myList.filter((r) => r.id !== id);

    if (activeRoutineId === id) {
      const nextOwned = myList.find((r) => r.source === 'owned' && !r.id.startsWith('temp-'));
      const nextAny = myList.find((r) => !r.id.startsWith('temp-'));
      const nextActive = nextOwned?.id ?? nextAny?.id ?? null;
      activeRoutineId = nextActive;
      if (nextActive) {
        try {
          await runDbActivityBatch(() => db.setActiveRoutine(nextActive));
          onActivate(nextActive);
        } catch (e) {
          console.error('Failed to activate fallback routine', e);
        }
      } else {
        try {
          await runDbActivityBatch(() => db.setActiveRoutine(null));
        } catch (e) {
          console.error(e);
        }
      }
    }
    emitListChange();

    try {
      await runDbActivityBatch(() => db.deleteRoutine(id));
    } catch (e) {
      myList = snapshot;
      emitListChange();
      errorMsg = 'Failed to delete routine';
      console.error(e);
    }
  }

  /** Bookmarked routines: remove from list only — never delete source. */
  async function removeBookmark(routineId: string) {
    errorMsg = null;
    const snapshot = myList;
    const wasActive = activeRoutineId === routineId;
    myList = myList.filter((r) => !(r.source === 'bookmarked' && r.id === routineId));
    bookmarks.delete(routineId);
    bookmarks = new Set(bookmarks);

    if (wasActive) {
      const nextOwned = myList.find((r) => r.source === 'owned' && !r.id.startsWith('temp-'));
      const nextAny = myList.find((r) => !r.id.startsWith('temp-'));
      const nextActive = nextOwned?.id ?? nextAny?.id ?? null;
      activeRoutineId = nextActive;
      try {
        if (nextActive) {
          await runDbActivityBatch(() => db.setActiveRoutine(nextActive));
          onActivate(nextActive);
        } else {
          await runDbActivityBatch(() => db.setActiveRoutine(null));
        }
      } catch (e) {
        console.error('Failed to reassign after unbookmark', e);
      }
    }
    emitListChange();

    try {
      await runDbActivityBatch(() => db.removeBookmarkFromList(routineId));
    } catch (e) {
      myList = snapshot;
      bookmarks.add(routineId);
      bookmarks = new Set(bookmarks);
      emitListChange();
      errorMsg = 'Failed to remove bookmark';
      console.error(e);
    }
  }

  async function activateRoutine(id: string) {
    if (busyAction !== null) return;
    if (id.startsWith('temp-')) return;
    busyAction = id;
    errorMsg = null;
    const prevActive = activeRoutineId;
    activeRoutineId = id;
    emitListChange();
    try {
      await runDbActivityBatch(() => db.setActiveRoutine(id));
      onActivate(id);
    } catch (e) {
      activeRoutineId = prevActive;
      emitListChange();
      errorMsg = 'Failed to activate routine';
      console.error(e);
    } finally {
      busyAction = null;
    }
  }

  async function toggleBookmark(routineId: string) {
    errorMsg = null;
    const wasBookmarked = bookmarks.has(routineId);
    if (wasBookmarked) {
      await removeBookmark(routineId);
      return;
    }
    // Optimistic add
    bookmarks.add(routineId);
    bookmarks = new Set(bookmarks);
    const community = allRoutines.find((r) => r.id === routineId);
    if (community) {
      const optimistic: UserRoutineListItem = {
        id: community.id,
        user_id: community.user_id,
        name: community.name,
        created_at: community.created_at,
        template_count: community.template_count ?? community.schedule?.filter((s) => s.template_id).length ?? 0,
        source: 'bookmarked',
        is_readonly: true,
        owner_username: community.owner_username,
        owner_avatar_seed: community.owner_avatar_seed,
      };
      if (!myList.some((r) => r.id === routineId)) {
        myList = [...myList, optimistic];
        emitListChange();
      }
    }
    try {
      await runDbActivityBatch(() => db.bookmarkRoutine(routineId));
      await reloadList();
    } catch (e) {
      bookmarks.delete(routineId);
      bookmarks = new Set(bookmarks);
      myList = myList.filter((r) => !(r.source === 'bookmarked' && r.id === routineId));
      emitListChange();
      errorMsg = 'Failed to bookmark routine';
      console.error(e);
    }
  }

  async function copyRoutine(routineId: string) {
    if (busyAction !== null) return;
    errorMsg = null;
    const wasBookmarked =
      bookmarks.has(routineId) ||
      myList.some((r) => r.id === routineId && r.source === 'bookmarked');
    const existingBm = myList.find((r) => r.id === routineId && r.source === 'bookmarked');
    const snapshot = [...myList];
    const bookmarksSnapshot = new Set(bookmarks);
    const prevActive = activeRoutineId;
    const tempId = 'temp-copy-' + Date.now();
    busyAction = 'copy:' + routineId;

    if (existingBm) {
      // Replace the bookmarked row in place (no extra row)
      myList = myList.map((r) =>
        r.id === routineId
          ? {
              id: tempId,
              user_id: currentUserId,
              name: 'COPYING…',
              created_at: r.created_at,
              template_count: r.template_count ?? 0,
              display_order: r.display_order,
              source: 'owned' as const,
              is_readonly: false,
            }
          : r,
      );
      bookmarks.delete(routineId);
      bookmarks = new Set(bookmarks);
      if (activeRoutineId === routineId) activeRoutineId = tempId;
    } else {
      myList = [
        ...myList,
        {
          id: tempId,
          user_id: currentUserId,
          name: 'COPYING…',
          created_at: '',
          template_count: 0,
          source: 'owned' as const,
          is_readonly: false,
        },
      ];
    }
    emitListChange();

    try {
      // Don't nest under extra busy guards; copy is the slow path
      const result = (await db.copyRoutine(routineId)) as Routine & {
        source_name: string;
        source_username: string;
      };

      if (wasBookmarked) {
        try {
          await db.removeBookmarkFromList(routineId);
        } catch (e) {
          console.error('Failed to remove bookmark after copy', e);
        }
      }

      const ownedItem: UserRoutineListItem = {
        ...result,
        source: 'owned',
        is_readonly: false,
      };
      // Swap COPYING row → real owned routine (keep position)
      myList = myList
        .map((r) => (r.id === tempId ? ownedItem : r))
        .filter((r) => !(r.source === 'bookmarked' && r.id === routineId));
      if (!myList.some((r) => r.id === result.id)) {
        myList = [...myList, ownedItem];
      }
      bookmarks.delete(routineId);
      bookmarks = new Set(bookmarks);
      emitListChange();

      // Clear busy *before* activate — activateRoutine no-ops while busyAction is set
      busyAction = null;
      await activateRoutine(result.id);
    } catch (e) {
      myList = snapshot;
      bookmarks = bookmarksSnapshot;
      activeRoutineId = prevActive;
      emitListChange();
      errorMsg = 'Failed to copy routine';
      console.error(e);
      busyAction = null;
    } finally {
      if (busyAction?.startsWith('copy:')) busyAction = null;
    }
  }

  function handleRowClick(routine: UserRoutineListItem) {
    if (routineRowDragged) return;
    if (busyAction !== null) return;
    if (routine.id.startsWith('temp-')) return;
    activateRoutine(routine.id);
  }

  /** Open routine editor (owned) or read-only view (bookmarked). */
  function handleEdit(routineId: string) {
    const item = myList.find((r) => r.id === routineId);
    if (!item || item.id.startsWith('temp-') || item.id.startsWith('temp-copy-')) return;
    // Open editor immediately; activate/sync schedule in the background
    activeRoutineId = routineId;
    emitListChange();
    if (item.source === 'bookmarked') {
      onViewRoutine(routineId);
    } else {
      onEditRoutine(routineId);
    }
    if (busyAction === null) {
      void activateRoutine(routineId);
    }
  }

  function displayRoutineName(routine: UserRoutineListItem): string {
    if (routine.source === 'bookmarked' && routine.owner_username) {
      return `${routine.name} - ${routine.owner_username}`.toUpperCase();
    }
    return routine.name;
  }

  const activeRoutine = $derived(
    activeRoutineId ? myList.find((r) => r.id === activeRoutineId) ?? null : null,
  );
  const activeDownloadLabel = $derived(
    activeRoutine ? displayRoutineName(activeRoutine) : null,
  );

  let importInputEl = $state<HTMLInputElement | undefined>();
  let importBusy = $state(false);

  function openImportPicker() {
    if (importBusy || busyAction !== null) return;
    importInputEl?.click();
  }

  async function onImportFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    importBusy = true;
    errorMsg = null;
    try {
      await onImport(file);
      await reloadList();
      // Parent may have activated the imported routine
      try {
        const active = await db.getActiveRoutineId();
        if (active) activeRoutineId = active;
      } catch {
        /* ignore */
      }
      emitListChange();
    } catch (err) {
      console.error(err);
      errorMsg = err instanceof Error ? err.message : 'Failed to import routine CSV';
    } finally {
      importBusy = false;
    }
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
    <div class="flex-1 min-w-0"></div>
    <input
      bind:this={importInputEl}
      type="file"
      accept=".csv,text/csv"
      class="hidden"
      onchange={onImportFileChange}
    />
    {#if activeRoutineId}
      <button
        type="button"
        class="h-8 max-w-[min(100%,12rem)] shrink min-w-0 rounded-lg border border-[#1e1e1e] bg-transparent text-zinc-400 hover:text-white hover:bg-[#1a1a1a] flex items-center justify-center gap-1.5 px-2 transition-colors"
        title={activeDownloadLabel
          ? `Export ${activeDownloadLabel} as CSV`
          : 'Export selected routine as CSV'}
        onclick={() => onDownload(activeRoutineId)}
      >
        <span class="text-[10px] font-bold tracking-wide truncate leading-none min-w-0 uppercase">
          {activeDownloadLabel ?? 'ROUTINE'}
        </span>
        <Upload class="size-4 shrink-0" />
      </button>
    {/if}
    <button
      type="button"
      class="h-8 shrink-0 rounded-lg border border-[#1e1e1e] bg-transparent text-zinc-400 hover:text-white hover:bg-[#1a1a1a] flex items-center justify-center gap-1.5 px-2 transition-colors disabled:opacity-50"
      title="Import routine from CSV"
      onclick={openImportPicker}
      disabled={importBusy || busyAction !== null}
    >
      <Download class="size-4 shrink-0" />
      <span class="text-[10px] font-bold tracking-wide leading-none shrink-0">IMPORT</span>
    </button>
  </div>

  {#if errorMsg}
    <div class="text-[9px] text-red-400 text-center">{errorMsg}</div>
  {/if}

  <!-- YOUR ROUTINES (owned + bookmarked) -->
  <div class="min-w-0">
    <div class="flex items-center gap-2 mb-1.5">
      <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">YOUR ROUTINES</span>
    </div>

    {#if loading && myList.length === 0}
      <div class="text-[10px] text-zinc-600 text-center py-4">Loading…</div>
    {:else if myList.length === 0}
      <div class="text-[10px] text-zinc-600 text-center py-4">No routines yet</div>
    {:else}
      <div
        class="flex flex-col gap-1 min-w-0"
        role="list"
        bind:this={routineListBody}
        ondrop={handleDrop}
        ondragover={handleDragOver}
      >
        {#each myList as routine, index (routine.id)}
          {@const isActive = activeRoutineId === routine.id}
          {@const isOwned = routine.source === 'owned'}
          {@const isBookmarked = routine.source === 'bookmarked'}
          {@const tc = Number(routine.template_count) || 0}
          <div
            class="flex items-stretch gap-1 h-9 min-w-0 {isOwned ? 'cursor-grab active:cursor-grabbing' : ''}"
            style="transform: translateY({isOwned ? dragShift(draggedRoutineIndex, dragOverRoutineIndex, index) : 0}px); transition: transform 150ms ease; {draggedRoutineIndex === index ? 'opacity: 0.25;' : ''}"
            draggable={isOwned}
            ondragstart={(e) => handleDragStart(e, index, routine)}
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
              <div class="flex items-center gap-1 min-w-0 flex-1 overflow-hidden">
                {#if isBookmarked}
                  <span class="shrink-0 inline-flex text-emerald-400" title="Bookmarked (live link)">
                    <Bookmark class="size-3.5" fill="currentColor" strokeWidth={2} />
                  </span>
                {/if}

                {#if renamingId === routine.id && isOwned}
                  <input
                    autocomplete="off"
                    class="font-medium bg-transparent border-0 p-0 m-0 focus:outline-none focus:ring-0 text-xs uppercase flex-1 min-w-0 truncate leading-none"
                    style={isActive ? `color: white` : `color: #aaa`}
                    bind:value={renameValue}
                    autofocus
                    onclick={(e) => e.stopPropagation()}
                    onmousedown={(e) => e.stopPropagation()}
                    onfocus={(e) => (e.currentTarget as HTMLInputElement).select()}
                    onkeydown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        saveRename(routine.id);
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        renamingId = null;
                        renameValue = '';
                      }
                    }}
                    onblur={() => saveRename(routine.id)}
                  />
                {:else if routine.name === 'COPYING…' || routine.id.startsWith('temp-copy-')}
                  <span
                    class="routine-copying-breathe font-medium text-xs flex-1 min-w-0 truncate leading-none uppercase {isActive ? 'text-white' : 'text-zinc-400'}"
                  >COPYING…</span>
                {:else}
                  <span
                    class="font-medium text-xs flex-1 min-w-0 truncate leading-none select-none uppercase {isActive ? 'text-white' : 'text-zinc-400'} {isOwned ? 'cursor-text' : ''}"
                    title={isOwned ? 'Double-click to rename' : displayRoutineName(routine)}
                    ondblclick={(e) => {
                      e.stopPropagation();
                      if (isOwned) renameRoutine(routine.id);
                    }}
                  >{displayRoutineName(routine)}</span>
                {/if}

                <span
                  class="text-[9px] shrink-0 px-1.5 py-0.5 rounded border leading-none"
                  style={isActive
                    ? `background-color: color-mix(in srgb, white 20%, #1e1e1e); border-color: white; color: white;`
                    : `background-color: #1e1e1e; border-color: #2a2a2a; color: #aaa;`}
                >
                  {tc} TEMPLATE{tc === 1 ? '' : 'S'}
                </span>

                {#if isActive}
                  <span class="text-[9px] shrink-0 px-1.5 py-0.5 rounded border leading-none"
                    style="background-color: color-mix(in srgb, white 20%, #1e1e1e); border-color: white; color: white;">
                    ASSIGNED
                  </span>
                {/if}

                {#if isActive}
                  {#if isOwned}
                    <button
                      type="button"
                      class="w-7 h-7 shrink-0 flex items-center justify-center rounded border transition-colors"
                      style="background-color: color-mix(in srgb, white 20%, #1e1e1e); color: white; border-color: white;"
                      title="Open routine editor"
                      onclick={(e) => { e.stopPropagation(); handleEdit(routine.id); }}
                      disabled={busyAction !== null}
                    >
                      <Pencil class="size-3 pointer-events-none" />
                    </button>
                    {#if canDeleteOwned}
                      <button
                        type="button"
                        class="w-7 h-7 shrink-0 flex items-center justify-center rounded border border-red-900/80 bg-red-950/50 text-red-400 hover:text-red-300 hover:border-red-800 transition-colors"
                        title="Delete routine"
                        onclick={(e) => { e.stopPropagation(); deleteOwnedRoutine(routine.id); }}
                        disabled={busyAction !== null}
                      >
                        <Trash2 class="size-3.5 pointer-events-none" />
                      </button>
                    {/if}
                  {:else if isBookmarked}
                    <button
                      type="button"
                      class="w-7 h-7 shrink-0 flex items-center justify-center rounded border transition-colors"
                      style="background-color: color-mix(in srgb, white 20%, #1e1e1e); color: white; border-color: white;"
                      title="View routine (read-only)"
                      onclick={(e) => { e.stopPropagation(); handleEdit(routine.id); }}
                      disabled={busyAction !== null}
                    >
                      <Pencil class="size-3 pointer-events-none" />
                    </button>
                    <button
                      type="button"
                      class="w-7 h-7 shrink-0 flex items-center justify-center rounded border border-blue-900/80 bg-blue-950/50 text-blue-400 hover:text-blue-300 hover:border-blue-800 transition-colors"
                      title="Copy into your account (editable duplicate)"
                      onclick={(e) => { e.stopPropagation(); copyRoutine(routine.id); }}
                      disabled={busyAction !== null}
                    >
                      <Copy class="size-3.5 pointer-events-none" />
                    </button>
                    <button
                      type="button"
                      class="w-7 h-7 shrink-0 flex items-center justify-center rounded border border-amber-900/80 bg-amber-950/40 text-amber-400 hover:text-amber-300 hover:border-amber-800 transition-colors"
                      title="Remove from your list (does not delete the source)"
                      onclick={(e) => { e.stopPropagation(); removeBookmark(routine.id); }}
                      disabled={busyAction !== null}
                    >
                      <BookmarkX class="size-3.5 pointer-events-none" />
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

  <!-- ALL USERS: username line → nested routines (one avatar per user) -->
  <div class="min-w-0">
    <div class="flex items-center gap-2 mb-1.5">
      <span class="text-[9px] uppercase tracking-[2px] text-zinc-500 leading-none">ALL USERS</span>
    </div>

    {#if allUsersGrouped.length === 0}
      <div class="text-[10px] text-zinc-600 text-center py-4">No community routines found</div>
    {:else}
      <div class="flex flex-col gap-2.5 min-w-0">
        {#each allUsersGrouped as group (group.user_id)}
          <div class="min-w-0 flex flex-col gap-1">
            <!-- User header -->
            <div class="flex items-center gap-1.5 min-h-7 px-0.5">
              <GeneratedAvatar
                userId={group.user_id}
                seed={group.avatar_seed ?? undefined}
                size={22}
                rounded={5}
                className="rounded shrink-0"
              />
              <span class="text-[11px] font-bold tracking-wide text-zinc-300 truncate leading-none">
                @{group.username}
              </span>
              <span class="text-[8px] shrink-0 px-1.5 py-0.5 rounded border border-[#2a2a2a] bg-[#141414] text-zinc-500 leading-none">
                {group.routines.length} ROUTINE{group.routines.length === 1 ? '' : 'S'}
              </span>
            </div>

            <!-- Nested routines -->
            <div class="flex flex-col gap-1 min-w-0 ml-2.5 pl-2.5 border-l border-[#1e1e1e]">
              {#each group.routines as routine, index (routine.id)}
                {@const isSelected = selectedAllId === routine.id}
                {@const isBm = bookmarks.has(routine.id)}
                {@const allTc = Number(routine.template_count ?? routine.schedule?.filter((s) => s.template_id).length) || 0}
                <div
                  class="flex items-stretch gap-1 h-9 min-w-0 cursor-pointer"
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
                    <div class="flex items-center gap-1 min-w-0 flex-1 overflow-hidden">
                      <span class="font-medium text-xs truncate leading-none min-w-0 flex-1 {isSelected ? 'text-white' : 'text-zinc-400'}">{routine.name}</span>
                      <span
                        class="text-[9px] shrink-0 px-1.5 py-0.5 rounded border leading-none"
                        style={isSelected
                          ? `background-color: color-mix(in srgb, white 20%, #1e1e1e); border-color: white; color: white;`
                          : `background-color: #1e1e1e; border-color: #2a2a2a; color: #aaa;`}
                      >
                        {allTc} TEMPLATE{allTc === 1 ? '' : 'S'}
                      </span>
                      {#if isBm}
                        <span class="shrink-0 inline-flex text-emerald-400" title="In your list">
                          <Bookmark class="size-4" fill="currentColor" strokeWidth={2} />
                        </span>
                      {/if}
                      {#if isSelected}
                        <button
                          type="button"
                          class="w-7 h-7 shrink-0 flex items-center justify-center rounded border transition-colors"
                          style={isBm
                            ? `background-color: color-mix(in srgb, rgb(52 211 153) 18%, #1e1e1e); color: rgb(52 211 153); border-color: rgb(52 211 153);`
                            : `background-color: transparent; color: #888; border-color: #333;`}
                          title={isBm ? 'Remove from your list' : 'Bookmark (live read-only link)'}
                          onclick={(e) => { e.stopPropagation(); toggleBookmark(routine.id); }}
                        >
                          {#if isBm}
                            <Bookmark class="size-4 pointer-events-none text-emerald-400" fill="currentColor" />
                          {:else}
                            <Bookmark class="size-4 pointer-events-none" />
                          {/if}
                        </button>
                        <button
                          type="button"
                          class="w-7 h-7 shrink-0 flex items-center justify-center rounded border border-blue-900/80 bg-blue-950/50 text-blue-400 hover:text-blue-300 hover:border-blue-800 transition-colors"
                          title="Copy routine into your account"
                          onclick={(e) => { e.stopPropagation(); copyRoutine(routine.id); }}
                        >
                          <Copy class="size-3.5 pointer-events-none" />
                        </button>
                      {/if}
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
