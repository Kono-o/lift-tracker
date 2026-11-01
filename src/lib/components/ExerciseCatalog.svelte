<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import {
    AlertCircle,
    ArrowLeft,
    BookOpen,
    Check,
    ChevronDown,
    ChevronRight,
    Loader2,
    Plus,
    Search,
    SlidersHorizontal,
    X,
  } from '@lucide/svelte';
  import {
    db,
    type CatalogCategory,
    type CatalogEquipment,
    type CatalogExerciseDetail,
    type CatalogExerciseSummary,
    type CatalogMuscle,
  } from '$lib/db';
  import { hapticLight, hapticSuccess } from '$lib/haptics';
  import { portal } from '$lib/portal';
  import { Input } from '$lib/components/ui/input';
  import MuscleDiagram from './MuscleDiagram.svelte';

  interface Props {
    open?: boolean;
    onclose?: () => void;
    onadd?: (detail: CatalogExerciseDetail) => void | Promise<void>;
    addedCatalogIds?: ReadonlySet<number>;
  }

  let {
    open = false,
    onclose = () => {},
    onadd = () => {},
    addedCatalogIds = new Set<number>(),
  }: Props = $props();

  const PAGE_SIZE = 30;

  let categories = $state<CatalogCategory[]>([]);
  let equipment = $state<CatalogEquipment[]>([]);
  let muscles = $state<CatalogMuscle[]>([]);
  let filtersLoading = $state(false);
  let filtersLoaded = $state(false);
  let filtersError = $state<string | null>(null);

  let query = $state('');
  let categoryId = $state('');
  let equipmentId = $state('');
  let muscleId = $state('');

  let results = $state<CatalogExerciseSummary[]>([]);
  let total = $state(0);
  let listLoading = $state(false);
  let listLoadingMore = $state(false);
  let listError = $state<string | null>(null);

  let detailId = $state<number | null>(null);
  let detail = $state<CatalogExerciseDetail | null>(null);
  let detailLoading = $state(false);
  let detailError = $state<string | null>(null);

  let addingId = $state<number | null>(null);
  let initialized = $state(false);
  let dialogEl = $state<HTMLDivElement | undefined>();
  let listScrollEl = $state<HTMLDivElement | undefined>();

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let listRequestSeq = 0;
  let detailRequestSeq = 0;

  const activeFilterCount = $derived(
    (categoryId ? 1 : 0) + (equipmentId ? 1 : 0) + (muscleId ? 1 : 0),
  );
  const hasFilters = $derived(Boolean(query.trim()) || activeFilterCount > 0);
  const canLoadMore = $derived(results.length < total);

  function errorMessage(err: unknown): string {
    if (err && typeof err === 'object' && 'message' in err) {
      const message = (err as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
    return 'Could not reach the exercise catalog.';
  }

  async function loadFilters() {
    filtersLoading = true;
    filtersError = null;
    try {
      const data = await db.getCatalogFilters();
      categories = data.categories;
      equipment = data.equipment;
      muscles = data.muscles;
      filtersLoaded = true;
    } catch (err) {
      filtersError = errorMessage(err);
    } finally {
      filtersLoading = false;
    }
  }

  async function fetchPage(reset: boolean) {
    const seq = ++listRequestSeq;
    if (reset) {
      listLoading = true;
      listError = null;
    } else {
      listLoadingMore = true;
    }
    try {
      const page = await db.searchCatalog({
        query: query.trim(),
        categoryId: categoryId ? Number(categoryId) : null,
        equipmentId: equipmentId ? Number(equipmentId) : null,
        muscleId: muscleId ? Number(muscleId) : null,
        limit: PAGE_SIZE,
        offset: reset ? 0 : results.length,
      });
      if (seq !== listRequestSeq) return;
      results = reset ? page.exercises : [...results, ...page.exercises];
      total = page.total;
      if (reset && listScrollEl) listScrollEl.scrollTop = 0;
    } catch (err) {
      if (seq !== listRequestSeq) return;
      listError = errorMessage(err);
      if (reset) {
        results = [];
        total = 0;
      }
    } finally {
      if (seq === listRequestSeq) {
        listLoading = false;
        listLoadingMore = false;
      }
    }
  }

  function queueSearch(value: string) {
    query = value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void fetchPage(true);
    }, 260);
  }

  function clearSearch() {
    query = '';
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    void fetchPage(true);
  }

  function applyFilter() {
    detailId = null;
    detail = null;
    detailError = null;
    void fetchPage(true);
  }

  function resetFilters() {
    query = '';
    categoryId = '';
    equipmentId = '';
    muscleId = '';
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    void fetchPage(true);
    void hapticLight();
  }

  async function openDetail(summary: CatalogExerciseSummary) {
    if (detailId === summary.id && !detailError) return;
    detailId = summary.id;
    detail = null;
    detailError = null;
    detailLoading = true;
    const seq = ++detailRequestSeq;
    void hapticLight();
    try {
      const row = await db.getCatalogExercise(summary.id);
      if (seq !== detailRequestSeq) return;
      if (!row) {
        detailError = 'That exercise is no longer available.';
      } else {
        detail = row;
      }
    } catch (err) {
      if (seq !== detailRequestSeq) return;
      detailError = errorMessage(err);
    } finally {
      if (seq === detailRequestSeq) detailLoading = false;
    }
  }

  function closeDetail() {
    detailId = null;
    detail = null;
    detailError = null;
    detailLoading = false;
    detailRequestSeq += 1;
  }

  function close() {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    onclose();
  }

  async function addToTemplate(row: CatalogExerciseDetail) {
    if (addingId !== null || addedCatalogIds.has(row.id)) return;
    addingId = row.id;
    try {
      await onadd(row);
      void hapticSuccess();
    } finally {
      addingId = null;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    if (detailId !== null) closeDetail();
    else close();
  }

  function muscleLabel(muscle: CatalogMuscle): string {
    return muscle.name_en?.trim() || muscle.name;
  }

  $effect(() => {
    if (!open) return;
    if (!filtersLoaded && !filtersLoading) void loadFilters();
    if (!initialized) {
      initialized = true;
      void fetchPage(true);
    }
  });

  $effect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    void tick().then(() => {
      if (open) dialogEl?.focus();
    });
    return () => {
      document.body.style.overflow = previous;
    };
  });

  $effect(() => {
    if (!open) {
      detailId = null;
      detail = null;
      detailError = null;
      detailLoading = false;
    }
  });

  onDestroy(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div
    class="catalog-overlay"
    role="presentation"
    use:portal
    transition:fade={{ duration: 160 }}
    onclick={(event) => {
      if (event.target === event.currentTarget) close();
    }}
  >
    <div
      bind:this={dialogEl}
      class="catalog-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Exercise catalog"
      tabindex="-1"
      in:fly={{ y: 20, duration: 220, opacity: 0 }}
      out:fly={{ y: 12, duration: 140, opacity: 0 }}
    >
      <header class="catalog-header">
        <div class="catalog-header__title">
          <span class="catalog-header__icon"><BookOpen class="app-icon-control" /></span>
          <div class="min-w-0">
            <h2>EXERCISE CATALOG</h2>
            <p>Built-in movements from the wger database. Tap one to inspect muscles and equipment.</p>
          </div>
        </div>
        <div class="catalog-header__side">
          <span class="catalog-count">
            {#if listLoading && results.length === 0}
              <Loader2 class="app-icon-small animate-spin" />
            {:else}
              {total}
            {/if}
            <span>EXERCISES</span>
          </span>
          <button type="button" class="catalog-close" onclick={close} aria-label="Close exercise catalog">
            <X class="app-icon-control" />
          </button>
        </div>
      </header>

      <div class="catalog-filters">
        <div class="catalog-search">
          <Search class="catalog-search__icon" />
          <Input
            type="text"
            inputmode="search"
            autocomplete="off"
            spellcheck="false"
            enterkeyhint="search"
            placeholder="Search exercises"
            value={query}
            oninput={(event) => queueSearch(event.currentTarget.value)}
            class="catalog-search__input"
          />
          {#if query}
            <button type="button" class="catalog-search__clear" onclick={clearSearch} aria-label="Clear search">
              <X class="app-icon-small" />
            </button>
          {/if}
        </div>

        <div class="catalog-filter-row">
          <label class="catalog-select">
            <span class="sr-only">Category</span>
            <select bind:value={categoryId} onchange={applyFilter}>
              <option value="">All categories</option>
              {#each categories as category (category.id)}
                <option value={String(category.id)}>{category.name}</option>
              {/each}
            </select>
            <ChevronDown class="catalog-select__chevron" />
          </label>

          <label class="catalog-select">
            <span class="sr-only">Equipment</span>
            <select bind:value={equipmentId} onchange={applyFilter}>
              <option value="">Any equipment</option>
              {#each equipment as item (item.id)}
                <option value={String(item.id)}>{item.name}</option>
              {/each}
            </select>
            <ChevronDown class="catalog-select__chevron" />
          </label>

          <label class="catalog-select">
            <span class="sr-only">Muscle</span>
            <select bind:value={muscleId} onchange={applyFilter}>
              <option value="">Any muscle</option>
              {#each muscles as muscle (muscle.id)}
                <option value={String(muscle.id)}>{muscleLabel(muscle)}</option>
              {/each}
            </select>
            <ChevronDown class="catalog-select__chevron" />
          </label>

          {#if activeFilterCount > 0 || query}
            <button type="button" class="catalog-reset" onclick={resetFilters} title="Clear search and filters">
              <SlidersHorizontal class="app-icon-small" />
              RESET
            </button>
          {/if}
        </div>
      </div>

      {#if filtersError}
        <div class="catalog-banner catalog-banner--error">
          <AlertCircle class="app-icon-small shrink-0" />
          <span class="flex-1 min-w-0">{filtersError}</span>
          <button type="button" onclick={() => void loadFilters()}>Retry</button>
        </div>
      {/if}

      <div class="catalog-body" class:has-detail={detailId !== null}>
        <div class="catalog-list-pane">
          <div class="catalog-list-head">
            <span>NAME</span>
            <span>PRIMARY MUSCLES</span>
          </div>

          <div class="catalog-list" bind:this={listScrollEl}>
            {#if listLoading && results.length === 0}
              {#each Array(7) as _, index (index)}
                <div class="catalog-skeleton" style="animation-delay: {index * 55}ms">
                  <span class="catalog-skeleton__title"></span>
                  <span class="catalog-skeleton__sub"></span>
                </div>
              {/each}
            {:else if listError}
              <div class="catalog-empty">
                <AlertCircle class="app-icon-nav text-red-400" />
                <p>{listError}</p>
                <button type="button" class="catalog-retry" onclick={() => void fetchPage(true)}>TRY AGAIN</button>
              </div>
            {:else if results.length === 0}
              <div class="catalog-empty">
                <Search class="app-icon-nav" />
                <p>
                  {hasFilters
                    ? 'No exercises match these filters.'
                    : 'The catalog is empty. Run the wger import to populate it.'}
                </p>
                {#if hasFilters}
                  <button type="button" class="catalog-retry" onclick={resetFilters}>CLEAR FILTERS</button>
                {/if}
              </div>
            {:else}
              {#each results as row (row.id)}
                {@const added = addedCatalogIds.has(row.id)}
                {@const primaryNames = row.primary_muscles.map(muscleLabel).join(', ')}
                <button
                  type="button"
                  class="catalog-row"
                  class:is-active={detailId === row.id}
                  onclick={() => void openDetail(row)}
                  aria-pressed={detailId === row.id}
                >
                  <span class="catalog-row__main">
                    <span class="catalog-row__title">
                      {row.name}
                      {#if added}<Check class="catalog-row__added" aria-label="Already in template" />{/if}
                    </span>
                    <span class="catalog-row__meta">
                      {#if row.category_name}<span class="catalog-chip catalog-chip--quiet">{row.category_name}</span>{/if}
                      {#if row.equipment.length > 0}
                        <span class="catalog-row__equipment">{row.equipment.map((item) => item.name).join(' · ')}</span>
                      {:else}
                        <span class="catalog-row__equipment">Bodyweight</span>
                      {/if}
                    </span>
                  </span>
                  <span class="catalog-row__muscles">{primaryNames || '—'}</span>
                  <ChevronRight class="catalog-row__chevron" />
                </button>
              {/each}

              {#if canLoadMore}
                <button
                  type="button"
                  class="catalog-load-more"
                  disabled={listLoadingMore}
                  onclick={() => void fetchPage(false)}
                >
                  {#if listLoadingMore}
                    <Loader2 class="app-icon-small animate-spin" /> LOADING
                  {:else}
                    LOAD MORE · {results.length}/{total}
                  {/if}
                </button>
              {/if}
            {/if}
          </div>
        </div>

        <div class="catalog-detail">
          {#if detailLoading}
            <div class="catalog-detail__loading">
              <div class="catalog-detail__skeleton catalog-detail__skeleton--title"></div>
              <div class="catalog-detail__skeleton catalog-detail__skeleton--diagram"></div>
              <div class="catalog-detail__skeleton"></div>
              <div class="catalog-detail__skeleton catalog-detail__skeleton--short"></div>
            </div>
          {:else if detailError}
            <div class="catalog-empty catalog-empty--detail">
              <AlertCircle class="app-icon-nav text-red-400" />
              <p>{detailError}</p>
              <button type="button" class="catalog-retry" onclick={() => {
                const summary = results.find((row) => row.id === detailId);
                if (summary) void openDetail(summary);
              }}>TRY AGAIN</button>
            </div>
          {:else if detail}
            {@const row = detail}
            {@const primaryIds = row.primary_muscles.map((muscle) => muscle.id)}
            {@const secondaryIds = row.secondary_muscles.map((muscle) => muscle.id)}
            {@const added = addedCatalogIds.has(row.id)}
            <div class="catalog-detail__head">
              <button type="button" class="catalog-back" onclick={closeDetail}>
                <ArrowLeft class="app-icon-small" />
                <span>BACK</span>
              </button>
              <div class="catalog-detail__heading">
                <div class="catalog-detail__badges">
                  <span class="catalog-chip">{row.category_name || 'Uncategorised'}</span>
                  {#if row.equipment.length > 0}
                    <span class="catalog-chip catalog-chip--quiet">{row.equipment.map((item) => item.name).join(' · ')}</span>
                  {:else}
                    <span class="catalog-chip catalog-chip--quiet">Bodyweight</span>
                  {/if}
                </div>
                <h3>{row.name}</h3>
              </div>
            </div>

            <div class="catalog-detail__scroll">
              <section class="catalog-section">
                <h4>MUSCLES</h4>
                {#if primaryIds.length > 0 || secondaryIds.length > 0}
                  <MuscleDiagram primary={primaryIds} secondary={secondaryIds} showLegend />
                  <div class="catalog-muscle-groups">
                    {#if row.primary_muscles.length > 0}
                      <div class="catalog-muscle-group">
                        <span class="catalog-muscle-group__label">
                          <i class="catalog-muscle-group__dot catalog-muscle-group__dot--primary"></i>PRIMARY
                        </span>
                        <div class="catalog-chips">
                          {#each row.primary_muscles as muscle (muscle.id)}
                            <span class="catalog-chip catalog-chip--primary">{muscleLabel(muscle)}</span>
                          {/each}
                        </div>
                      </div>
                    {/if}
                    {#if row.secondary_muscles.length > 0}
                      <div class="catalog-muscle-group">
                        <span class="catalog-muscle-group__label">
                          <i class="catalog-muscle-group__dot catalog-muscle-group__dot--secondary"></i>SECONDARY
                        </span>
                        <div class="catalog-chips">
                          {#each row.secondary_muscles as muscle (muscle.id)}
                            <span class="catalog-chip catalog-chip--secondary">{muscleLabel(muscle)}</span>
                          {/each}
                        </div>
                      </div>
                    {/if}
                  </div>
                {:else}
                  <p class="catalog-muted">No muscle groups recorded for this movement.</p>
                {/if}
              </section>

              <section class="catalog-section">
                <h4>HOW TO PERFORM</h4>
                {#if row.description}
                  <p class="catalog-description">{row.description}</p>
                {:else}
                  <p class="catalog-muted">No description available yet for this exercise.</p>
                {/if}
              </section>

              <section class="catalog-section catalog-section--attribution">
                <h4>ATTRIBUTION</h4>
                <p>
                  Exercise data from
                  <a href="https://wger.de" target="_blank" rel="noopener noreferrer">wger.de</a>
                  · License: {row.license || 'CC-BY-SA 4.0'}
                  · Author: {row.license_author || 'wger contributors'}
                </p>
                {#if row.license_url}
                  <a
                    class="catalog-license-link"
                    href={row.license_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >License details</a>
                {/if}
              </section>
            </div>

            <div class="catalog-detail__actions">
              <button
                type="button"
                class="catalog-add"
                class:is-added={added}
                disabled={added || addingId !== null}
                onclick={() => void addToTemplate(row)}
              >
                {#if addingId === row.id}
                  <Loader2 class="app-icon-control animate-spin" />
                  ADDING…
                {:else if added}
                  <Check class="app-icon-control" />
                  IN THIS TEMPLATE
                {:else}
                  <Plus class="app-icon-control" strokeWidth={2.5} />
                  ADD TO TEMPLATE
                {/if}
              </button>
              <p>Creates a tracked exercise with its own progression. Muscle diagram is illustrative.</p>
            </div>
          {:else}
            <div class="catalog-empty catalog-empty--detail">
              <BookOpen class="app-icon-display" />
              <p>Select an exercise to see its muscles, equipment, and instructions.</p>
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .catalog-overlay {
    position: fixed;
    inset: 0;
    z-index: 180;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 0;
    background: rgb(0 0 0 / 0.72);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }

  .catalog-dialog {
    display: flex;
    width: 100%;
    height: calc(100dvh - env(safe-area-inset-top, 0px));
    max-height: 100dvh;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--app-outline);
    border-bottom: 0;
    border-radius: var(--app-radius-dialog) var(--app-radius-dialog) 0 0;
    background: var(--app-surface-1);
    color: var(--app-fg-primary);
    box-shadow: 0 -24px 70px rgb(0 0 0 / 0.65);
    outline: none;
  }

  .catalog-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3-5) var(--space-3-5) var(--space-3);
    border-bottom: 1px solid var(--app-outline-subtle);
    background:
      radial-gradient(120% 150% at 0% 0%, rgb(251 191 36 / 0.07), transparent 60%),
      var(--app-surface-1);
  }

  .catalog-header__title {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    gap: var(--space-2-5);
  }

  .catalog-header__icon {
    display: flex;
    width: 2rem;
    height: 2rem;
    flex: none;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--app-outline);
    border-radius: var(--app-radius-control);
    background: var(--app-surface-2);
    color: #fbbf24;
  }

  .catalog-header h2 {
    margin: 0;
    font-size: var(--type-caption);
    font-weight: 800;
    letter-spacing: 0.16em;
    line-height: 1.3;
    color: var(--app-fg-primary);
  }

  .catalog-header p {
    max-width: 36rem;
    margin: var(--space-0-5) 0 0;
    font-size: var(--type-micro);
    line-height: 1.35;
    color: var(--app-fg-muted);
  }

  .catalog-header__side {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
  }

  .catalog-count {
    display: none;
    align-items: baseline;
    gap: var(--space-1);
    border: 1px solid var(--app-outline);
    border-radius: 999px;
    padding: var(--space-1) var(--space-2);
    font-family: var(--font-mono, monospace);
    font-size: var(--type-micro);
    color: var(--app-fg-primary);
    background: var(--app-surface-0);
  }

  .catalog-count span {
    font-size: var(--type-micro);
    letter-spacing: 0.14em;
    color: var(--app-fg-muted);
  }

  .catalog-close {
    display: flex;
    width: 2.25rem;
    height: 2.25rem;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--app-outline);
    border-radius: var(--app-radius-control);
    background: var(--app-surface-2);
    color: var(--app-fg-secondary);
    transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
  }

  .catalog-close:hover {
    border-color: var(--app-outline-strong);
    background: var(--app-surface-3);
    color: #fff;
  }

  .catalog-filters {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2-5) var(--space-3-5);
    border-bottom: 1px solid var(--app-outline-subtle);
    background: var(--app-surface-0);
  }

  .catalog-search {
    position: relative;
    display: flex;
    align-items: center;
  }

  .catalog-search :global(.catalog-search__icon) {
    position: absolute;
    left: 0.65rem;
    z-index: 1;
    width: 0.85rem;
    height: 0.85rem;
    color: var(--app-fg-muted);
    pointer-events: none;
  }

  .catalog-search :global(.catalog-search__input) {
    height: 2.25rem;
    padding-left: 2.05rem;
    padding-right: var(--space-8);
    border-color: var(--app-outline);
    border-radius: var(--app-radius-control);
    background: var(--app-surface-1);
    font-size: var(--type-caption);
    color: var(--app-fg-primary);
    box-shadow: none;
  }

  .catalog-search :global(.catalog-search__input:focus-visible) {
    border-color: var(--app-outline-strong);
    --tw-ring-shadow: 0 0 #0000;
    box-shadow: none;
  }

  .catalog-search__clear {
    position: absolute;
    right: 0.4rem;
    display: flex;
    width: 1.6rem;
    height: 1.6rem;
    align-items: center;
    justify-content: center;
    border-radius: var(--app-radius-compact);
    color: var(--app-fg-muted);
  }

  .catalog-search__clear:hover {
    background: var(--app-surface-4);
    color: var(--app-fg-primary);
  }

  .catalog-filter-row {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .catalog-filter-row::-webkit-scrollbar {
    display: none;
  }

  .catalog-select {
    position: relative;
    display: flex;
    min-width: 0;
    flex: 1 1 0;
    align-items: center;
  }

  .catalog-select select {
    width: 100%;
    height: 2rem;
    appearance: none;
    border: 1px solid var(--app-outline);
    border-radius: var(--app-radius-control);
    background: var(--app-surface-1);
    padding: 0 var(--space-6) 0 var(--space-2);
    font-size: var(--type-micro);
    color: var(--app-fg-secondary-strong);
    outline: none;
    text-overflow: ellipsis;
  }

  .catalog-select select:focus-visible {
    border-color: var(--app-outline-strong);
  }

  .catalog-select :global(.catalog-select__chevron) {
    position: absolute;
    right: 0.45rem;
    width: 0.75rem;
    height: 0.75rem;
    color: var(--app-fg-muted);
    pointer-events: none;
  }

  .catalog-reset {
    display: flex;
    height: 2rem;
    flex: none;
    align-items: center;
    gap: var(--space-1);
    border: 1px solid var(--app-outline);
    border-radius: var(--app-radius-control);
    padding: 0 var(--space-2);
    font-size: var(--type-micro);
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--app-fg-secondary);
  }

  .catalog-reset:hover {
    border-color: var(--app-outline-strong);
    color: #fff;
  }

  .catalog-banner {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    margin: var(--space-2) var(--space-3-5) 0;
    border: 1px solid rgb(248 113 113 / 0.35);
    border-radius: var(--app-radius-control);
    background: rgb(69 10 10 / 0.35);
    padding: var(--space-2) var(--space-2);
    font-size: var(--type-micro);
    color: #fca5a5;
  }

  .catalog-banner button {
    flex: none;
    border: 1px solid rgb(248 113 113 / 0.4);
    border-radius: var(--app-radius-compact);
    padding: var(--space-1) var(--space-2);
    font-size: var(--type-micro);
    font-weight: 700;
    letter-spacing: 0.06em;
  }

  .catalog-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
    flex: 1;
  }

  .catalog-list-pane {
    display: flex;
    min-height: 0;
    flex-direction: column;
  }

  .catalog-list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-3-5);
    border-bottom: 1px solid var(--app-outline-subtle);
    font-size: var(--type-micro);
    font-weight: 700;
    letter-spacing: 0.16em;
    color: var(--app-fg-disabled);
  }

  .catalog-list {
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .catalog-row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: var(--space-2);
    border-bottom: 1px solid var(--app-outline-subtle);
    padding: var(--space-2) var(--space-3-5);
    text-align: left;
    transition: background 120ms ease;
  }

  .catalog-row:hover {
    background: var(--app-surface-1);
  }

  .catalog-row.is-active {
    background: var(--app-surface-2);
    box-shadow: inset 2px 0 0 #fbbf24;
  }

  .catalog-row__main {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: var(--space-1);
  }

  .catalog-row__title {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--space-1-5);
    overflow: hidden;
    font-size: var(--type-caption);
    font-weight: 600;
    color: var(--app-fg-primary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .catalog-row :global(.catalog-row__added) {
    width: 0.8rem;
    height: 0.8rem;
    flex: none;
    color: #4ade80;
  }

  .catalog-row__meta {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--space-1-5);
    font-size: var(--type-micro);
    color: var(--app-fg-muted);
  }

  .catalog-row__equipment {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .catalog-row__muscles {
    display: none;
    max-width: 13rem;
    flex: none;
    overflow: hidden;
    font-size: var(--type-micro);
    color: var(--app-fg-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .catalog-row :global(.catalog-row__chevron) {
    width: 0.9rem;
    height: 0.9rem;
    flex: none;
    color: var(--app-fg-disabled);
  }

  .catalog-chip {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--app-outline);
    border-radius: 999px;
    padding: var(--space-0-5) var(--space-1-5);
    font-size: var(--type-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--app-fg-secondary-strong);
    background: var(--app-surface-2);
    white-space: nowrap;
  }

  .catalog-chip--quiet {
    border-color: var(--app-outline);
    background: transparent;
    color: var(--app-fg-secondary);
  }

  .catalog-chip--primary {
    border-color: rgb(251 191 36 / 0.35);
    background: rgb(251 191 36 / 0.1);
    color: #fcd34d;
  }

  .catalog-chip--secondary {
    border-color: rgb(56 189 248 / 0.3);
    background: rgb(56 189 248 / 0.08);
    color: #7dd3fc;
  }

  .catalog-skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
    border-bottom: 1px solid var(--app-outline-subtle);
    padding: var(--space-3) var(--space-3-5);
    animation: catalog-pulse 1.4s ease-in-out infinite;
  }

  .catalog-skeleton__title,
  .catalog-skeleton__sub {
    display: block;
    height: 0.55rem;
    border-radius: 999px;
    background: var(--app-surface-4);
  }

  .catalog-skeleton__title {
    width: 48%;
  }

  .catalog-skeleton__sub {
    width: 72%;
    height: 0.4rem;
    background: var(--app-surface-3);
  }

  .catalog-empty {
    display: flex;
    height: 100%;
    min-height: 12rem;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-6);
    text-align: center;
    color: var(--app-fg-muted);
  }

  .catalog-empty p {
    margin: 0;
    max-width: 20rem;
    font-size: var(--type-micro);
    line-height: 1.45;
  }

  .catalog-retry {
    border: 1px solid var(--app-outline);
    border-radius: var(--app-radius-compact);
    padding: var(--space-1-5) var(--space-2-5);
    font-size: var(--type-micro);
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--app-fg-secondary-strong);
  }

  .catalog-retry:hover {
    border-color: var(--app-outline-strong);
    color: #fff;
  }

  .catalog-load-more {
    display: flex;
    width: calc(100% - 1.8rem);
    height: 2.1rem;
    margin: var(--space-3) var(--space-3-5);
    align-items: center;
    justify-content: center;
    gap: var(--space-1-5);
    border: 1px dashed var(--app-outline);
    border-radius: var(--app-radius-control);
    font-size: var(--type-micro);
    font-weight: 700;
    letter-spacing: 0.12em;
    color: var(--app-fg-secondary);
  }

  .catalog-load-more:hover:not(:disabled) {
    border-color: var(--app-outline-strong);
    color: #fff;
  }

  .catalog-load-more:disabled {
    opacity: 0.6;
  }

  .catalog-detail {
    display: none;
    min-height: 0;
    flex-direction: column;
    border-left: 1px solid var(--app-outline-subtle);
    background: var(--app-surface-1);
  }

  .catalog-body.has-detail .catalog-list-pane {
    display: none;
  }

  .catalog-body.has-detail .catalog-detail {
    display: flex;
  }

  .catalog-empty--detail {
    flex: 1;
  }

  .catalog-detail__head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-3-5);
    border-bottom: 1px solid var(--app-outline-subtle);
    background:
      radial-gradient(100% 160% at 100% 0%, rgb(56 189 248 / 0.06), transparent 55%),
      var(--app-surface-1);
  }

  .catalog-back {
    display: flex;
    align-self: flex-start;
    align-items: center;
    gap: var(--space-1);
    border: 1px solid var(--app-outline);
    border-radius: var(--app-radius-compact);
    padding: var(--space-1) var(--space-2);
    font-size: var(--type-micro);
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--app-fg-secondary);
  }

  .catalog-back:hover {
    border-color: var(--app-outline-strong);
    color: #fff;
  }

  .catalog-detail__heading {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
  }

  .catalog-detail__badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .catalog-detail h3 {
    margin: 0;
    font-size: var(--type-subhead);
    font-weight: 800;
    line-height: 1.2;
    letter-spacing: 0.01em;
    color: var(--app-fg-primary);
  }

  .catalog-detail__scroll {
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--space-3) var(--space-3-5) var(--space-4);
  }

  .catalog-section {
    padding-bottom: var(--space-3-5);
    margin-bottom: var(--space-3-5);
    border-bottom: 1px solid var(--app-outline-subtle);
  }

  .catalog-section:last-child {
    margin-bottom: 0;
    border-bottom: 0;
    padding-bottom: 0;
  }

  .catalog-section h4 {
    margin: 0 0 var(--space-2);
    font-size: var(--type-micro);
    font-weight: 800;
    letter-spacing: 0.18em;
    color: var(--app-fg-muted);
  }

  .catalog-muscle-groups {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-2-5);
  }

  .catalog-muscle-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .catalog-muscle-group__label {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--type-micro);
    font-weight: 700;
    letter-spacing: 0.14em;
    color: var(--app-fg-muted);
  }

  .catalog-muscle-group__dot {
    width: 0.35rem;
    height: 0.35rem;
    border-radius: 999px;
  }

  .catalog-muscle-group__dot--primary {
    background: #fbbf24;
  }

  .catalog-muscle-group__dot--secondary {
    background: #38bdf8;
  }

  .catalog-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .catalog-description {
    margin: 0;
    white-space: pre-line;
    font-size: var(--type-micro);
    line-height: 1.55;
    color: var(--app-fg-secondary);
  }

  .catalog-muted {
    margin: 0;
    font-size: var(--type-micro);
    line-height: 1.45;
    color: var(--app-fg-muted);
  }

  .catalog-section--attribution p {
    margin: 0 0 var(--space-1-5);
    font-size: var(--type-micro);
    line-height: 1.5;
    color: var(--app-fg-muted);
  }

  .catalog-section--attribution a {
    color: var(--app-fg-secondary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .catalog-section--attribution a:hover {
    color: #fff;
  }

  .catalog-license-link {
    font-size: var(--type-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .catalog-detail__actions {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
    padding: var(--space-2-5) var(--space-3-5) calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--app-outline-subtle);
    background: var(--app-surface-0);
  }

  .catalog-add {
    display: flex;
    width: 100%;
    height: 2.6rem;
    align-items: center;
    justify-content: center;
    gap: var(--space-1-5);
    border-radius: var(--app-radius-control);
    background: #fbbf24;
    font-size: var(--type-micro);
    font-weight: 800;
    letter-spacing: 0.12em;
    color: #000;
    transition: background 120ms ease, transform 120ms ease;
  }

  .catalog-add:hover:not(:disabled) {
    background: #fcd34d;
  }

  .catalog-add:active:not(:disabled) {
    transform: translateY(1px);
  }

  .catalog-add:disabled {
    cursor: default;
  }

  .catalog-add.is-added {
    background: #14532d;
    color: #86efac;
  }

  .catalog-detail__actions p {
    margin: 0;
    text-align: center;
    font-size: var(--type-micro);
    line-height: 1.4;
    color: var(--app-fg-disabled);
  }

  .catalog-detail__loading {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-3-5);
  }

  .catalog-detail__skeleton {
    height: 1.4rem;
    border-radius: var(--app-radius-compact);
    background: var(--app-surface-3);
    animation: catalog-pulse 1.4s ease-in-out infinite;
  }

  .catalog-detail__skeleton--title {
    width: 65%;
    height: 2rem;
  }

  .catalog-detail__skeleton--diagram {
    height: 9rem;
  }

  .catalog-detail__skeleton--short {
    width: 45%;
  }

  @keyframes catalog-pulse {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 1;
    }
  }

  @media (min-width: 640px) {
    .catalog-overlay {
      align-items: center;
      padding: var(--space-5);
    }

    .catalog-dialog {
      height: min(86dvh, 46rem);
      max-width: 62rem;
      border-bottom: 1px solid var(--app-outline);
      border-radius: var(--app-radius-dialog);
    }

    .catalog-header {
      padding: var(--space-4) var(--space-4) var(--space-3);
    }

    .catalog-count {
      display: inline-flex;
    }

    .catalog-filters {
      padding: var(--space-3) var(--space-4);
    }

    .catalog-filter-row {
      overflow: visible;
    }

    .catalog-select {
      max-width: 13rem;
    }

    .catalog-list-head {
      padding: var(--space-2) var(--space-4);
    }

    .catalog-row {
      padding: var(--space-2) var(--space-4);
    }

    .catalog-row__title {
      font-size: var(--type-caption);
    }

    .catalog-row__muscles {
      display: block;
    }

    .catalog-detail__head {
      padding: var(--space-3-5) var(--space-4);
    }

    .catalog-back {
      display: none;
    }

    .catalog-detail__scroll {
      padding: var(--space-4) var(--space-4) var(--space-4);
    }

    .catalog-detail__actions {
      padding: var(--space-3) var(--space-4);
    }

    .catalog-detail h3 {
      font-size: var(--type-title);
    }

    .catalog-section {
      padding-bottom: var(--space-4);
      margin-bottom: var(--space-4);
    }

    .catalog-description {
      font-size: var(--type-caption);
    }
  }

  @media (min-width: 900px) {
    .catalog-body {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.08fr);
    }

    .catalog-list-pane,
    .catalog-body.has-detail .catalog-list-pane {
      display: flex;
    }

    .catalog-detail,
    .catalog-body.has-detail .catalog-detail {
      display: flex;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .catalog-skeleton,
    .catalog-detail__skeleton {
      animation: none;
    }

    .catalog-add,
    .catalog-row,
    .catalog-close {
      transition: none;
    }
  }
</style>
