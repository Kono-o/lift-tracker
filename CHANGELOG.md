# Changelog

All notable changes to Lift Tracker are documented here.

## [1.0.2] - 2026-06-09

### Changed / Fixed

- Ported reliable native APK download to the Capacitor UpdaterPlugin (HttpURLConnection streaming + progress events, modeled on Mihon/tachiyomi architecture) for much more robust sideload updates than JS fetch in WebView.
- Layered download guards and post-write verification (early content-type / small-body / size checks + size + "PK" magic-byte validation + cleanup of bad files) in both native Java and JS fallback paths. Prevents "Download corrupted (size mismatch...)" and "problem with parsing file" errors.
- Stricter update prompt timing: now gated on `currentUser && hasInitialLoad && stageRevealActive` (only after login + all data loaded + main menu visible), plus a small settle delay. Matches the spec that the menu should not appear during auth/boot.
- Website footer now always triggers a demo of the centered update menu (real fetch when possible, graceful dummy + browser <a download> on Install).
- Minor: removed dead `downloadApkToCache` import; fixed scoping in the (now-unused on main path) JS download helper; gated Supabase health polling to reduce pre-login 401 noise.
- Stable signing key + build scripts ensure APKs from .1 and .2 are updatable.

## [1.0.1] - 2026-06-08

### Added

- Full auto-update support for the sideloaded Android APK.
- Update check only runs after sign-in + data load + main menu is visible (never during auth or boot).
- Centered blur update prompt (matches account/settings menu style).
- "Later" (X) only suppresses until next fresh cold start.
- "Install" makes dialog unclosable, shows real-time download progress.
- Downloads APK reliably (proper GitHub headers + asset API URL on native; size + magic-byte verification after download to prevent "parsing file" errors).
- Hands off to standard Android package installer (with unknown-sources permission handling).
- After successful update, next launch shows "What's new" changelog popup (same centered style).
- Stable signing key across releases (fixed keystore regeneration in build scripts).
- Website footer click opens demo of the update menu (with real fetch + browser download for testing).

## [1.0.0] - 2026-06-07

### Added

- Custom stats editor with configurable start values, optional targets, and 6-character units
- Daily stat logging with history view; archived labels when a stat is deleted
- Stat log snapshots persist name/unit even after a tracked stat is removed
- Account menu data usage chips for tracked stats and stat log entries
- `get_own_data_usage` RPC now reports `tracked_stats` and `stat_logs` counts

### Fixed

- Finishing a workout rolls back to the active session if the server sync fails
- `setup-db.fish --users-only` wipes `tracked_stats` / `stat_logs` (removed stale `bodyweight_logs`)

### Changed

- Web deploys use `@sveltejs/adapter-vercel` instead of adapter-auto

## [0.0.1] - initial

- Workout templates, rep/timed exercises, live workout mode, Supabase sync, PWA and Android builds