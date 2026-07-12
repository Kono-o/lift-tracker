# Changelog

All notable changes to Lift Tracker are documented here.

## [1.0.8] - 2026-07-13

**Feature release** — multi-routines, bookmarks, discovery, import/export. Built and signed with the **exact same long-lived release key** (fingerprint 37:04:C3:...) as all prior 1.0.x releases so in-app updates continue to install cleanly.

### Multi-routines
- Multiple routines per account; assign one as active
- Routines schedule templates across the week; templates hold exercises
- Create, rename, reorder, delete owned routines (keep at least one owned)
- Empty routines show an empty template list (no leftover from the previous assignment)

### Bookmarks & discovery
- Browse other users’ routines; **bookmark** (live read-only link) or **copy** (full editable duplicate)
- Bookmarked routines appear in Your list as `NAME - USERNAME` with a green bookmark badge
- Bookmarked = read-only in the editor; compact chip: `ROUTINE IS A BOOKMARK (READ ONLY) from @user`
- Copy from a bookmark (or community list) to get your own editable routine
- Bookmarked items are hidden from the community tree (they already live under Your routines)
- All Users list is a username tree (one avatar per person, routines nested)

### Import / export
- Export the selected routine as CSV (metadata + week plan + templates/exercises)
- Filename includes the routine name; import button loads exported CSVs as a new owned routine

### Database
- Hardening migration: `set_active_routine`, bookmark/unbookmark RPCs, safe delete, live resync for bookmarked active plans — no user data deleted

## [1.0.5] - 2026-06-10

**Feature release** — new branding, reliable exercise editing, zero-increment support for timed work, and automatic workout duration estimates. Built and signed with the **exact same long-lived release key** (fingerprint 37:04:C3:...) as all prior 1.0.x releases so in-app updates continue to install cleanly.

### New Features & Improvements
- **New app icon / logo**: Replaced the simple dumbbell with a proper gym barbell design across the entire product.
  - Web/PWA: updated `static/icon.svg`, `manifest.webmanifest`, `src/lib/assets/favicon.svg`, and `<link rel="apple-touch-icon">`.
  - Android: regenerated all launcher icons (ldpi through xxxhdpi + round), adaptive icon foreground/background, and the source `assets/icon.png`.
- **Full exercise property editor**: All target fields now work reliably in the routine editor (sets, reps, current weight, +kg, minutes, seconds, +s). Previously only the new rest times were updating/saving correctly; switched the remaining fields to the same controlled + immutable `draftExercises = map(...)` pattern.
- **Timed exercise +s (increment) defaults to 0 and is fully settable to 0**: Client-side clamps, normalize, validation, and display updated. Most importantly, the server-side `save_template_exercises` RPC was fixed (in both `setup.sql` and the rest-time migration) — it no longer forces `greatest(1, ..., 5)` for time exercises. The change was applied live to the DB without any data loss.
- **Automatic session time estimator on the template box**: The header line that used to say only "X EXERCISES • Y SETS" now also shows an estimated total workout duration.
  - Reps sets: 1 minute of work each (as specified).
  - Timed sets: exact target time (`target_minutes * 60 + target_seconds`).
  - Rests: one rest after every set for both types (N sets = N rests per exercise, per feedback).
  - Shown as `• ~45m` or `• ~1h 20m` right next to the exercise/set counts. Works for scheduled templates, active sessions, and historical logs.

All changes preserve the existing stable signing key, auto-update flow, and no-breaking-changes promise.

See v1.0.0 notes for the full original feature list and sideloading story.

## [1.0.4] - 2026-06-09

**Feature release** — focused on better workflow enforcement, phone-native UX, auth onboarding, and polish for the update experience. Built and signed with the **exact same long-lived release key** (fingerprint 37:04:C3:...) as all prior 1.0.x releases so in-app updates continue to install cleanly.

### New Features & Improvements
- **Strict per-exercise set ordering**: You can only log sets in sequence. 
  - Only the "next" unlogged set for an exercise is unlocked and interactive (hold-to-log, manual edit, or timer activate).
  - Future sets are locked: Lock icon centered, dimmed (opacity-60), disabled interactions, plus runtime guards in all start/edit/activate functions.
  - Already-logged previous sets show their values/colors but are closed to new actions.
  - Applies live on "today"; historical views unaffected.
- **Phone back button support**: Hardware back (and iOS swipe in some cases) now closes open editors/menus exactly like the on-screen back arrows:
  - Template editor (`exitEditTemplate` — saves + cleans).
  - Routine editor (`exitRoutineEditor` — saves draft + cleans).
  - Account/settings panel (`closeSettingsPanel`).
  - Stats view/editor (`exitStatsView` / `exitStatsEditor` — saves tracked stats).
  - Guards ensure saves happen the same way.
- **Update and post-update modals**: Touching/clicking outside the dialog no longer closes them (prevents accidental dismiss). Only the X (close) button or "GOT IT" button works. (Update prompt remains unclosable during install.)
- **Auth first-use UX**: 
  - Brand new install on a device defaults to **Sign Up** tab first.
  - After any successful authentication (sign up or sign in), subsequent launches default to **Sign In** tab first.
  - Preference persisted via Capacitor Preferences (survives restarts, but automatically resets on app uninstall/reinstall so fresh installs always start with Sign Up).
  - Social preview icons hidden (code kept for future implementation when OAuth is wired).
- **Remove menu fade-in on reload**: Main app content (`app-stage-reveal`) now reveals immediately (`stageRevealActive` set true right away in boot flow) instead of fading in after a hold. Boot overlay and account reveal timing preserved for loading experience.
- **Faster update experience**: Settle delay before showing the update prompt or post-update "UPDATED" screen reduced from 600ms to **250ms** (after main menu is ready and boot overlay gone). Comment updated to cover both.
- **Markdown support in changelog boxes**: Both the update prompt ("Update available") and post-update ("UPDATED") "WHAT'S NEW" sections now render GitHub release notes as proper markdown (lists, **bold**, *italic*, links, etc.) instead of raw pre-wrapped text. Uses `marked` + `DOMPurify` for safe HTML rendering. Basic styles added for readability in the small dark boxes.
- **Button styling consistency**: The ERASE (past logs) and CANCEL (active workout) side buttons now use bright white text + hover (like STATS and SKIP) instead of dim `text-zinc-500`. Progress/hold states (red) unchanged.
- **Future workouts**: Routine editor and "Edit Exercises" (template) buttons now appear in the header when viewing a future scheduled day (relaxed `showHeaderEditActions`; still no live logging on future).

All changes preserve the existing stable signing key, auto-update flow, and no-breaking-changes promise.

See v1.0.0 notes for the full original feature list and sideloading story.

## [1.0.3] - 2026-06-09

**Feature release** — major quality-of-life and polish additions on top of the stable 1.0.x baseline. Built and signed with the **exact same long-lived release key** (fingerprint 37:04:C3:...) as v1.0.0/v1.0.1/v1.0.2 so in-app updates continue to install cleanly with no uninstall or data loss for existing users.

### New Features & Improvements
- **CSV routine export**: One-click export of your entire routine (all templates + full SMTWTFS schedule) from the routine editor. Produces a clean, human-readable CSV with idiomatic formatting such as "4 × 8 @ 82.5kg (+2.5)". Works great on phone (writes to Android Documents / app-specific storage). Sensible separators and quoting.
- **Per-exercise rest times**: Every exercise (reps-based or timed) now has independent `rest_minutes` + `rest_seconds`. Full input sanitization, clamping (MIN=0), defaults to 0 (displayed as "0"), same patterns as timed targets. Changes live on the exercises table (not the template), with a new DB migration, updated RPCs (`save_template_exercises`, `complete_workout_session`), explicit column selects, immutable client maps, and complete save/fetch/display roundtrips. Rest times are honored by the new rest timer.
- **Doubled rep-set hold duration**: `REP_SET_HOLD_MS` increased to 500 ms for more deliberate "fill to log" interactions.
- **Full post-set rest timer** (the big one):
  - Automatically begins after *any* set is logged (hold-to-log, manual numeric entry, or finishing a timed set).
  - Uses the exercise's own rest time; completely skipped when 0m0s.
  - Re-uses the exact same progress-bar visual/layout as timed exercises (works identically for reps exercises and time exercises during their rest phase).
  - Distinct orange theme (`#f97316` orangey accent) applied to the whole exercise card (background, icon, name, meta, progress cubes) while preserving the normal yellow/green `status-surface` borders.
  - "REST" label written on the left of the rest progress bar, styled identically to the "S1"/"S2" set labels.
  - No stop/pause button (rest is non-interactive by design).
  - 1-second delay + fade: the card gently transitions to orange during the delay; the set bubbles cross-fade (opacity + pointer-events) out while the rest bar cross-fades in.
  - Cross-exercise locking: while rest is active on one exercise, all sets on every *other* exercise are locked (centered Lock icon, reduced opacity, disabled interactions, early-return guards in hold/start/edit/activate paths).
  - Survives refresh: full rest state (exercise, set index, remaining/target seconds, start timestamp) is persisted to `sessionStorage` alongside ongoing timers. On reload the countdown resumes with intervals restarted and visuals restored.
  - Never-offscreen layout: `h-7` relative container + absolutely positioned layers + `min-w-0` everywhere + progress region taking the remaining space after the fixed "REST" label + actions.
  - Precise 00:00 behavior: the bar reaches true 100% fill at exactly zero, the animation freezes, a static full bar is shown briefly (≈250 ms), then the rest UI cleanly ends (bar disappears, sets reappear).
  - Landed together with a large batch of timer-bar hardening that fixed the previous "so many bugs": correct normalization (scaled fraction × dynamic cube count from measured width), phase-shift + adjusted-raw bounce so normal→overtime never jumps or desyncs, `isPast`/`effective` forces + met capture so the bar truly hits 100% when time reaches 0 and stays frozen, snippet deduplication, direct `bind:clientWidth` for cube count, etc.
  - Yellow→green flip on refresh for timed sets also fixed (hydrate now prefers the frozen `target_*` values captured in the workout log's snapshot at the moment the set was originally logged).
- **Strict in-order set logging per exercise**: You can only interact with the "next" unlogged set for an exercise. 
  - At any moment exactly one set (the first unlogged one) is unlocked and fully interactive.
  - All later sets are locked: they display a Lock icon, are dimmed, and have disabled hold/click/activate/edit actions (plus runtime guards in `startRepSetHold`, `beginRepSetEdit`, `activateOrSwitchTimeSet`, etc.).
  - Once the current set is logged the following one automatically unlocks.
  - Already-logged previous sets remain visible with their values and colors but are closed to further logging actions.
  - Only applies during a live active workout on "today"; historical/past/completed views are unaffected and show the full recorded data.
- **Badge placement fix**: "UNTOUCHED" and "NEW PR" badges now sit right next to the exercise name (tight `gap-1` flex subgroup containing the name span + badge, with the name's truncation still working). Removed a layout-breaking `truncate` on the outer name wrapper that was interfering with flex positioning. Badges remain properly aligned/visible even on long names or when the right-hand weight/timer column is present.

All of the above was developed, tested, and landed on top of the v1.0.2 baseline while preserving the existing stable signing key and auto-update guarantees.

See the v1.0.0 release notes for the complete original feature list, sideloading instructions, and philosophy. Everything there still applies; this release is a pure additive polish layer.

## [1.0.2] - 2026-06-09

**Faux test release** (for chained auto-update verification).

This release is primarily intended to let users who installed v1.0.0 or v1.0.1 exercise the full in-app update pipeline one more time in a controlled way (v1.0.1 → v1.0.2). It uses the **exact same stable release signing key** as all prior 1.0.x releases, so the update will install cleanly over existing installs without any "package conflict" or uninstall requirement.

### Purpose of This Faux Release
- Validate end-to-end auto-update on real devices for the second link in the chain.
- Confirm that "last seen version" tracking correctly suppresses re-prompting after a successful update.
- Ensure the native downloader, progress reporting, verification (size + magic bytes), permission flow, and post-update "UPDATED + confetti" screen all continue to work after the v1.0.1 baseline.
- The in-app updater will pull this release via `/repos/Kono-o/lift-tracker/releases/latest` and offer the `lift-tracker-v1.0.2.apk` asset.

### What's Included
- All the solid foundation from v1.0.0 + v1.0.1 (templates, live workouts, rep + timed exercises, custom stats, Supabase sync, beautiful centered update UX).
- Small incremental polish that landed since v1.0.1 (improved identicon/avatar rendering and persistence of custom seeds).
- No breaking changes. The APK is built with the locked-down `scripts/build-release-apk.fish` process and the documented long-lived keystore (see `SIGNING.md` and `RELEASE.md`).

After you update, the first cold start should show the friendly "UPDATED" modal with these notes and confetti. Future real feature releases will follow the same safe signing + distribution rules.

See the v1.0.0 release notes for the complete feature list and sideloading instructions. All of that still applies.

**Thank you for testing the update machinery.** This is what makes a sideloaded Android app feel production-grade.

## [1.0.0] - 2026-06-09

**Lift Tracker v1.0.0** is the first stable release of a focused workout logging app.

This is the complete, holistic foundation: everything you need for serious training in one clean, reliable package — on web as a PWA and as a proper sideloadable Android APK.

### Core Training Experience
- Create and reuse workout templates with any combination of exercises
- Log rep-based sets (weight × reps) and timed exercises (with live timer and auto-stop)
- Fluid live workout screen with easy editing, reordering, and instant feedback
- Full history of every workout with beautiful, fast review

### Stats & Body Tracking
- Fully customizable tracked stats: choose start value, optional target, and a short unit (up to 6 characters)
- Daily stat logging with complete history and quick entry
- Smart archiving: delete a stat and its past logs still keep the original name and unit
- Account menu shows a clear breakdown of your data usage (number of tracked stats, stat logs, templates, exercises, workout logs)

### Sync & Account
- Supabase-powered real-time sync: sign in once and your templates, workouts, stats, and logs are available everywhere
- Private by default with secure auth
- Data usage transparency so you always know how much you're storing

### Android & Distribution (Sideload-first)
- Clean, production-quality signed release APK built with a stable, long-lived release signing key
- **Built-in auto-update system**: on app launch (after sign-in + your data has fully loaded), the app checks GitHub Releases for a newer version
- Beautiful centered update prompt with blur background (matches the style of the account/settings menus)
- "Install" downloads the APK (with real-time progress), verifies it, then hands off to the standard Android package installer
- Handles "install from unknown sources" permission gracefully before downloading
- Post-update: on the first launch after installing a new version you get a nice "UPDATED" changelog popup with confetti
- Website has a demo mode (click the footer) so you can test the entire update UI without a real device

### UI & Polish Highlights in the Stable Release
- Consistent, modern design language across menus, the workout screen, stats, and the update flows
- Loading/boot experience that exactly matches the dimensions and layout of the user menu (no jarring shifts)
- Progress bars, buttons, and "WHAT'S NEW" boxes that feel native and delightful
- Careful attention to small details: no growing dialogs during install, fake delays for satisfying feedback, plain text for identity fields, properly abbreviated data usage chips ("wrk logs", "sts", "sts logs"), etc.

### Technical Foundations
- Svelte 5 + Tailwind + Capacitor for a high-quality native-feeling web + Android experience
- Robust native downloader on Android (HttpURLConnection streaming + size + magic-byte verification) so large APKs download reliably even on flaky connections
- Same signing key is used for every release, guaranteeing that in-app updates install cleanly over previous versions without requiring uninstall

This 1.0.0 release is the solid, complete, and delightful base that everything else will build on. It is ready for daily use on both web and Android.

## [1.0.1] - 2026-06-09

**Faux test release** (for auto-update verification only).

- Small bump used exclusively to test that the in-app update flow (download → progress → system install prompt → post-update changelog) works end-to-end from a clean 1.0.0 install.
- No user-facing changes.

## [0.0.1] - initial (historical)

- Early prototype of the workout logging app (templates, exercises, Supabase sync, PWA + Android builds)