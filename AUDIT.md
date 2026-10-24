# Lift Tracker — Codebase Audit & Remediation

**Audit date:** 2026-10-22  
**Scope:** SvelteKit + Capacitor client, Supabase schema/RLS/RPCs, local setup tooling  
**Branch:** `master` (working tree; no commit was made)  
**Status:** All verified functional and security defects fixed in the working tree. Database migrations applied to the linked Supabase project. `svelte-check` reports 0 errors; production build succeeds; browser end-to-end flows pass.

---

## 1. Executive summary

The audit covered the full application: the ~11.5k-line page component, the ~3.8k-line data layer, the component library, the Capacitor/native integration, all SQL migrations, the consolidated `setup.sql`, `seed.sql`, and the shell setup scripts.

**50 findings** were tracked and remediated:

- **18 server/database findings**, including two critical authorization flaws: a globally destructive account-wipe RPC executable by any client, and a workout RPC that accepted arbitrary exercise IDs and could corrupt other users' weights and personal bests.
- **23 client data/state findings**, including bootstrap queries that mixed all users' templates with only the current user's exercises, overlapping autosaves that lost edits, UTC/local date drift, a "today" that never rolled over at midnight, and failed operations that left optimistic UI state on screen.
- **9 UI/tooling findings**, including an unusable email login path, inaccessible touch targets, stale setup scripts, and 24 TypeScript errors.

The uncommitted mobile UX work already present in the tree (haptics, undo toasts, touch reordering) was preserved and completed rather than reverted.

---

## 2. Method

1. **Repository mapping** — source tree, build configuration, adapters (static/Capacitor and Vercel), native plugins, migrations, scripts.
2. **Static analysis** — `svelte-check`, TypeScript, production build, dead-code and call-site tracing.
3. **Live schema inspection** — `supabase migration list --linked`, catalog queries for policies, function ACLs, keys, triggers, and data counts.
4. **Line-by-line review** — data layer, auth flows, workout/session state machine, timers, autosave paths, routine editor/builder, stats editor, export/import, account deletion.
5. **SQL validation** — destructive migrations reviewed; `setup.sql` executed inside a transaction ending in `ROLLBACK` to prove it compiles against the current schema without changing data.
6. **Browser end-to-end tests** — real Supabase auth, bookmark/activate a community routine, start/log/finish a workout, verify rows and weights in SQL, then delete the test account and verify cascade cleanup.

The browser environment exposes a 0×0 viewport, so pointer automation was performed with synthetic DOM events; all assertions were made against the live DOM and database.

---

## 3. Server / database findings

### Critical

| ID | Location | Finding | Fix |
|----|----------|---------|-----|
| S-01 | `delete_all_accounts()` | The function deletes **every** row in app tables and all `auth.users`, but inherited Supabase's default `EXECUTE` grant for `anon` and `authenticated`. Anyone with the public anon key could wipe the entire project. | Revoked from `public`, `anon`, `authenticated`; granted only to `service_role` and `postgres` (`20260720000000_security_hardening.sql`, `scripts/setup-db.fish`). Verified live: both roles now return `false`. |
| S-02 | `complete_workout_session(...)` | Accepted exercise UUIDs without checking ownership. A crafted call could update another user's exercise weight and write personal bests against exercises the caller does not own. | Validates every submitted exercise (own library, or referenced by the submitted template when its routine is owned/bookmarked); validates type and caps set/rep/time dimensions. Exercised in `20260720000000` and extended for bookmarked templates in `20261022010000`. |

### High

| ID | Location | Finding | Fix |
|----|----------|---------|-----|
| S-03 | `exercise_personal_bests` | Primary key was `(exercise_id)` only, so a PR on an exercise row was shared globally. When exercises were copied between accounts, one user's best could overwrite another's. | PK changed to `(exercise_id, user_id)`; completion RPC reads/writes per user; validation trigger ensures the exercise belongs to the user or a bookmarked routine (`20261022010000`). |
| S-04 | `rename_username(text)` | For email/OAuth accounts it rewrote the real inbox to a synthetic `@example.com` address, making the account unrecoverable; it also deleted and reinserted the profile row, losing avatar/active routine. | Only synthetic username-account emails may be rewritten; profile is updated in place (`20260720000000`). |
| S-05 | `unbookmark_routine(uuid)` | Removed only the bookmark row. The routine's templates stayed in the materialized `schedule` and `active_routine_id` could still point at it, so the calendar kept showing (and trying to start) a routine the user had removed. | Deletes affected schedule rows and clears `active_routine_id` when it matches (`20260720000000`). |
| S-06 | Username/profile creation | Accounts created with email or OAuth got no `usernames` row. Community attribution, avatar seeds, active-routine selection, and several joins then had no profile. | `ensure_username_row()` plus trigger fallback and a one-time backfill for all auth users; `save_avatar_seed` and `set_active_routine` self-heal missing rows (`20261022010000`). |
| S-07 | Bookmarked-routine workouts | Two defects: `complete_workout_session` rejected exercises not owned by the caller (so bookmarked routines could not be completed), and its weight update wrote back to the publisher's exercise row. | Accepts exercises referenced by a template in an owned or bookmarked routine; only advances stored weight when the exercise row is owned; PRs are per user (`20261022010000`). Verified in browser: publisher's `MACHINE BENCH` weight stayed 15 while the viewer received a `PULLUPS` PR. |
| S-08 | Exercise deletion | `templates.exercise_ids` is a plain `uuid[]` with no foreign key, so deleting a library exercise left dangling IDs. Templates then appeared non-empty, broke assignment guards, and copied dead references. | `exercises_cleanup_template_refs()` trigger prunes the deleted ID from every template atomically, including templates owned by other users (`20261022000000`). |

### Medium / low

| ID | Location | Finding | Fix |
|----|----------|---------|-----|
| S-09 | Routine copy (client) | Copy was a multi-request client sequence; a failure left an orphan routine, exercises, or templates. It also copied only templates assigned to a weekday, losing unassigned templates. | Replaced with transactional `copy_routine(uuid)`: copies every template, clones each exercise once, remaps IDs, reseeds the seven-day plan (`20260719000000`). |
| S-10 | Week schedule save (client) | Delete-all then insert from the client was not atomic; a failed insert erased the schedule. | `save_routine_schedule(uuid, jsonb)` validates all seven days and template ownership before deleting, writes transactionally, and syncs the personal calendar when the routine is active (`20260719000000`). |
| S-11 | `createRoutine` | If seeding the seven empty schedule days failed, the routine row remained, leaving a routine that could never be scheduled correctly. | Seed failure now deletes the just-created routine before surfacing the error (`src/lib/db.ts`). |
| S-12 | Routine import | Exercises and routine were inserted before templates/schedule; a later failure left orphan rows. | Import runs in a try/catch that removes the created routine and exercises on failure (`src/lib/db.ts`). |
| S-13 | Legacy schema | Pre-routines tables (`week_schedules`, `week_schedule_days`, `bodyweight_logs`, tags, active schedules) and RPCs referencing dropped columns were still deployed. Several functions could not run at all, and the wipe helper inserted into removed tables. | Dropped legacy tables/functions; rebuilt `delete_all_accounts` for the current schema; removed the client's dead `deleteAllUserData` (`20260719000000`). |
| S-14 | Function grants | New RPCs inherited `EXECUTE` for `anon`; several security-definer functions were callable before sign-in. | ACL loop revokes `anon`/`public` from every app RPC and grants `authenticated, service_role`; only `is_username_available` remains anon-executable (`20260720000000`). Verified live: anon can execute exactly one public function. |
| S-15 | `schedule` RLS | Insert/update policies allowed any `template_id`, so a client could attach another user's template to its calendar. | New policies require the template to belong to a routine owned by `auth.uid()`; security-definer RPCs still support bookmarked routines (`20260719000000`). |
| S-16 | `copy_routine` result | Returned the number of weekday assignments as `template_count`, while every list counts all templates. A copied routine with an unassigned template showed a stale lower count until reload. | Returns the number of cloned templates (`20261022020000`), and `setup.sql` was updated to match. |
| S-17 | Account deletion (client) | After `delete_own_account()` succeeded, the auth row was already gone; a failing `signOut()` then made a successful deletion look like an error. | Sign-out after RPC success is best-effort and never fails the deletion (`src/lib/db.ts`). |
| S-18 | Setup tooling | `setup.sql`, `seed.sql`, and `scripts/setup-db.fish` had drifted from migrations; the wipe function referenced dropped columns; `psql` errors were suppressed; seed data used removed fields. | Schema/seed regenerated to the current model; wipe function rebuilt; `ON_ERROR_STOP=1`; grants locked down. `setup.sql` validated in a rolled-back transaction. |

---

## 4. Client findings

### High

| ID | Location | Finding | Fix |
|----|----------|---------|-----|
| C-01 | `db.bootstrap()` | RLS exposes every community template. The boot query fetched **all** templates but only the current user's exercises, so foreign templates entered the editor without their exercises, while a bookmarked active routine's exercises were missing. | Own templates are scoped through `routines!inner(user_id)`; templates referenced by the materialized schedule but not owned are fetched separately with their exercises and merged (`src/lib/db.ts`). |
| C-02 | Routine lists | `template_count` was derived from weekday assignments (max 7) and discovery additionally filtered out templates with empty `exercise_ids`. Routines with unassigned/empty templates showed 0 and were hidden from the community list. | Count the `templates` relation consistently for owned, bookmarked, and discovery lists; removed the hiding filter (`src/lib/db.ts`). |
| C-03 | Stats editor autosave | Saves overlapped. A slow earlier response could overwrite newer drafts and selection IDs; rapid edits could be dropped; errors were only logged. | Serialized coalescing loop (`statDraftSavePromise` + pending flag) re-snapshots the latest drafts, rebinds stable list keys/selection, and exposes `statSaveError` in the UI. |
| C-04 | Template exercise autosave | Same overlapping-save race, plus no guard for read-only bookmarked templates and no handling when the last exercise is removed. | Same coalescing pattern, read-only check, save error banner, and automatic removal of an emptied template from all weekdays (`src/routes/+page.svelte`). |
| C-05 | Date filtering | `toISOString().slice(0, 10)` produced UTC dates for local calendar data (history window, stat-log window, export filename). Users outside UTC could miss the oldest day or include the wrong one. | Added `localDateString()` and used it for bootstrap cutoffs, recent history, stat logs, snapshots, and export filenames (`src/lib/db.ts`). |
| C-06 | `REAL_TODAY` | Computed once at module load. After midnight the UI's "today" stayed on the previous day while database writes used the live date: wrong week strip, wrong date gating, wrong log target, until a full reload. | Reactive `todayEpoch` derived date refreshed on a 30s timer, tab visibility, Capacitor resume, and after auth; moves the selection only when it was on the old today and fetches the new day's log. |
| C-07 | Skip workout | Optimistically wrote a skipped log to `todayLog`/`weekLogs`/`viewedLog`; on server failure only an error was shown, leaving a workout marked skipped that was never persisted. | Snapshots and restores all three views on failure (`syncSkipWorkout(previous)`), with operation-generation guards. |
| C-08 | Week day log fetch | A failed per-date request only logged to console. The render gate waited for `weekLogs[date]` forever, so the selected day showed "Loading day…" indefinitely. | Per-date error map, "Could not load this day" panel with RETRY, clearing errors on success, and failure marking for batch fetches. |
| C-09 | Timed-set pause | Pausing left `timerStartTimestamp` running, so paused time counted toward the set; resuming recalculated from the original start. | On pause, freeze elapsed and clear the anchor; resume anchors to the frozen value (`src/routes/+page.svelte`). |
| C-10 | Rest timer after background | On resume, an expired rest period could leave the progress bar locked at `0:00` and the UI in a running state. | Expired/no-target rest now calls `stopRestTimer()`; expired persisted state is cleared on load. |
| C-11 | Day switching | Rest/fade timers and their exercise/set identifiers were not cleared when changing days, so the previous day's rest UI could appear on another day. | Clear all rest/fade state and timers when the selected day changes. |
| C-12 | Baseline weight | The template meta line resolved `weight_before ?? current_weight`, but the input branch tested `current_weight`, so a logged workout's baseline could hide the input or show the wrong value. | Both display and input gate now use the resolved `shownWeight`; missing weight renders `—` and shows the baseline input. |

### Medium

| ID | Location | Finding | Fix |
|----|----------|---------|-----|
| C-13 | Week schedule lookup | `schedule[weekday]` assumed a dense seven-element array, but rows are sparse until materialized; days could display another day's template. | `scheduleByDay` map keyed by `day_of_week`. |
| C-14 | Past-day stats | `enterStatsView()` returned unless viewing today, so past logged workouts had no route to the stats panel alongside the erase action. | Removed the guard; the existing past-day UI already supports it. |
| C-15 | Clear/undo workout log | Optimistic clear updated `weekLogs` and conditionally `viewedLog`, leaving `todayLog` and the other derived views stale; rollback could restore only part of the state. | Shared `applyWorkoutLogLocally(log, date)` updates today, week, and viewed views together, used by clear/undo and completion paths. |
| C-16 | Export/import | Export fetched only templates assigned to a day (unassigned templates lost); import matched templates by display name (duplicate, sanitized, or truncated names collided); counts used weekday assignments; failures left partial rows. | Export includes every routine template with stable `key`/`weekKeys`; import prefers keys with name fallback for older files; count is inserted templates; failure rolls back created routine and exercises (`src/lib/db.ts`). |
| C-17 | Failed routine deletion | After `delete_own_routine` failed, the list was restored but the server's active routine had already been switched, producing a list/schedule mismatch. | `restoreActiveRoutine(prevActive)` re-applies the previous active routine and reports a second failure. |
| C-18 | Copy + unbookmark | Copy succeeded but bookmark removal failed; local state removed the bookmark, so the bookmarked row disappeared locally while still existing server-side. | Keep/re-add the bookmark row and show "copied, but bookmark could not be removed". |
| C-19 | Auth listener | `onAuthStateChange` awaited `supabase.auth.getUser()` inside the callback. Supabase holds an auth lock during callbacks, so this can deadlock sign-in/sign-out. | Use `session.user` directly in the callback. |
| C-20 | Export button | `onDownload(activeRoutineId)` could pass `null` and export the wrong/missing routine. | Guard the call and disable when no active routine exists. |
| C-21 | Undo after delete | Restoring deleted stats/exercises restored drafts but not stable row keys or selection, causing flash/remount and potentially losing the selection; the re-save could race the autosave loop. | Snapshot keys, selection, and cached template data; restore before re-persisting through the coalescing save loop. |
| C-22 | Timed-entry parsing | Tracking keys are `<uuid>-<set>`, but parsing used `split('-')[0]`. UUIDs contain hyphens, so the exercise lookup failed and the target duration was lost on reload. | Parse with `lastIndexOf('-')`. |
| C-23 | Dead routines code | `ensureDefaultRoutine` still generated routines from the removed legacy `schedule` model, and `deleteAllUserData` bypassed the account RPC. | Removed both; account deletion uses the RPC/API path. |

---

## 5. UI and tooling findings

| ID | Location | Finding | Fix |
|----|----------|---------|-----|
| U-01 | Auth screen | Only username sign-in existed, although Supabase email auth and password reset existed underneath; email accounts could not sign in from the UI. | Added a "USE EMAIL INSTEAD" / "USE USERNAME INSTEAD" toggle that updates the credential mode and labels. |
| U-02 | Sign-out | Settings UI was reset and the panel closed **before** attempting sign-out, so a failure produced no visible context. | Close/reset only on success; keep the panel open and show `accountError` on failure. |
| U-03 | Hold gestures | Sign-out/delete hold progress could survive unmount or an action started while the password form was open; delete-account failure also closed the panel. | Stop/reset hold state on action/unmount; keep the panel open on failure so the error is visible. |
| U-04 | Touch targets | Row actions were 20–24 px; settings and install controls 28 px; color-picker hue swatches 20 px. Hard to hit on phones. | Bumped actions to 32 px, close controls to 36 px, hue swatches to 28 px. |
| U-05 | Color picker | Fixed 240 px panel could overflow narrow screens. | `max-width: calc(100vw - 16px)`. |
| B-01 | Type checking | 24 TypeScript errors: removed update-asset field still typed, nullable avatar seed, implicit snippet params, nullable selected stat ID, updater types. | Fixed; `svelte-check` now reports 0 errors. |
| B-02 | Compiler warnings | Seven "state_referenced_locally" warnings in `RoutinesMenu` from intentionally seeding local state with props. | Wrapped seeding reads in `untrack()`; warnings dropped from 34 to 27. |
| B-03 | Dead update path | `downloadApkToCache` duplicated the native `UpdaterNative.downloadUpdate` path and carried unused Filesystem imports/types. | Removed; the native/JS download flow uses the plugin. |
| B-04 | Build | Optional `@opentelemetry/api` warning from `@supabase/supabase-js` during Vercel build. | Non-fatal and upstream; documented below. |

---

## 6. Database changes

All migrations are in `supabase/migrations/` and were applied to the linked Supabase project on 2026-10-22; local and remote migration history are in sync.

| Migration | Purpose |
|-----------|---------|
| `20260719000000_cleanup_legacy_and_atomic_rpcs.sql` | Drops legacy week-schedule/bodyweight tables and dead RPCs; tightens `schedule` insert/update RLS; rewrites `assign_schedule_days` to validate up front and dual-write the active routine plan; adds `save_routine_schedule` and `copy_routine`; rebuilds `delete_all_accounts` for the current schema. |
| `20260720000000_security_hardening.sql` | Locks down `delete_all_accounts`; global RPC ACL cleanup; ownership/bounds validation in `complete_workout_session`; PB validation trigger; safe `rename_username`; `unbookmark_routine` schedule cleanup. |
| `20261022000000_exercise_delete_cleanup.sql` | Trigger pruning deleted exercise IDs from every `templates.exercise_ids`. |
| `20261022010000_bookmarked_workout_profiles_and_pbs.sql` | Per-user PB primary key; profile-row guarantee/backfill; bookmarked-routine completion support; publisher weight protection. |
| `20261022020000_copy_routine_template_count.sql` | Correct `template_count` in the copy result; keeps `setup.sql` in sync. |

`supabase/setup.sql`, `supabase/seed.sql`, and `scripts/setup-db.fish` were regenerated/updated to match this schema. The consolidated setup was executed inside a transaction ending in `ROLLBACK` against the live database without errors.

**Deployment order matters:** the client now calls `save_routine_schedule` and `copy_routine`. Apply migrations before shipping this client build, otherwise routine saving/copying fails against the old schema. Migration `20260719000000` drops legacy tables irreversibly; take a backup before promoting beyond the dev project.

---

## 7. Verification performed

### Static

- `npm run check` → **0 errors, 27 warnings** (remaining warnings are accessibility only; see below).
- `npm run build` → success with `@sveltejs/adapter-vercel`; only the non-fatal optional `@opentelemetry/api` notice.
- Consolidated `setup.sql` → compiled in a rolled-back transaction.
- Migration history → local and remote aligned, including all five audit migrations.

### Live database assertions

- `delete_all_accounts` executable by `anon`: **false**; by `authenticated`: **false**.
- Public functions executable by `anon`: **1** (`is_username_available`).
- `exercise_personal_bests` primary key: **`exercise_id, user_id`**.
- Exercise cleanup trigger exists: **true**.

### Browser end-to-end

- Signed out and back in; toggled email/username credential mode.
- Bookmarked a community routine owned by `@arya`; activated it read-only; loaded an 11-exercise `UPPER` template.
- Started, logged, and finished the workout; SQL confirmed an 11-exercise history row and a per-user PB, and confirmed the publisher's exercise weight was unchanged.
- Deleted the test account via the 4-second hold; SQL confirmed zero remaining auth user, profile, routine, bookmark, workout, and PB rows for that account.

### Not exercised live

- Midnight rollover (logic and refresh paths reviewed statically).
- Forced skip-workout failure and rollback (failure injection not practical in the live project).
- Native Android haptics, back button, background resume, and APK install flow (require a device build).
- Real-email/OAuth sign-up and rename (schema/function logic reviewed; no external inbox used).

---

## 8. Remaining warnings and known limitations

- **27 Svelte accessibility warnings** remain in `src/routes/+page.svelte` and `src/lib/components/RoutinesMenu.svelte`. They are drag-row/clickable-container ARIA and keyboard-handler warnings (plus one intentional `autofocus`). They do not affect functionality or the build, but should be addressed in a dedicated accessibility pass; adding roles/tab stops mechanically to complex nested rows risks changing interaction behavior.
- **Database advisor/perf advisories** (unindexed advisory checks, auth connection settings) were not part of this functional audit. RLS policies and RPC ACLs were reviewed directly.
- **No automated test suite** exists in the repository. All verification is static analysis, SQL assertions, and manual/scripted browser flows. Adding Playwright (web) and SQL test fixtures would prevent regressions in the routine/workout flows.
- **`@opentelemetry/api`** is an optional peer of Supabase's client; the build warning is benign unless tracing is enabled.

---

## 9. Changed files

Client and tooling:

- [src/routes/+page.svelte](src/routes/+page.svelte) — date rollover, day-log error state, autosave serialization, timers, skip rollback, stats/undo/haptics, auth toggle, touch targets, error UI.
- [src/lib/db.ts](src/lib/db.ts) — scoped bootstrap, local dates, atomic RPC usage, template counts, export/import, rollback paths, account-deletion tolerance.
- [src/lib/components/RoutinesMenu.svelte](src/lib/components/RoutinesMenu.svelte) — active-routine compensation, bookmark/copy failure handling, export guard, untracked seeding.
- [src/lib/updater.ts](src/lib/updater.ts) — removed duplicated download path and obsolete asset field.
- [src/lib/components/GeneratedAvatar.svelte](src/lib/components/GeneratedAvatar.svelte) — nullable seed.
- [src/lib/components/TemplateColorPicker.svelte](src/lib/components/TemplateColorPicker.svelte) — responsive width, larger hue targets.
- [src/routes/layout.css](src/routes/layout.css) — touch-target sizes and coarse-pointer reorder affordance.
- [src/lib/haptics.ts](src/lib/haptics.ts), [src/lib/undo.svelte.ts](src/lib/undo.svelte.ts), [src/lib/components/UndoToast.svelte](src/lib/components/UndoToast.svelte) — in-progress mobile UX work preserved and integrated.
- [package.json](package.json), [package-lock.json](package-lock.json) — `@capacitor/haptics`.

Database and setup:

- [supabase/setup.sql](supabase/setup.sql) — consolidated schema synchronized with all migrations.
- [supabase/seed.sql](supabase/seed.sql) — seed data updated to routine-owned templates.
- [scripts/setup-db.fish](scripts/setup-db.fish) — safe wipe, error propagation, current schema.
- Five migrations listed in section 6.

No commits were created and no secrets were exposed or written to any file.
