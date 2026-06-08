# Changelog

All notable changes to Lift Tracker are documented here.

## [1.0.0] - 2026-06-09

### Added

- Workout templates, rep/timed exercises, live workout mode with Supabase sync (PWA + sideloadable Android APK)
- Custom stats editor with configurable start values, optional targets, and 6-character units
- Daily stat logging with history view; archived labels when a stat is deleted
- Stat log snapshots persist name/unit even after a tracked stat is removed
- Account menu data usage chips for tracked stats and stat log entries
- `get_own_data_usage` RPC now reports `tracked_stats` and `stat_logs` counts
- **Full auto-update support for the sideloaded Android APK** (the main feature of this release):
  - Update check only runs after sign-in + all data loaded + main menu is visible (never during auth or boot).
  - Centered blur update prompt (matches account/settings menu style).
  - "Later" (X) only suppresses until next fresh cold start.
  - "Install" makes dialog unclosable, shows real-time download progress.
  - Permission check for "Install unknown apps" happens **before** downloading the APK (no wasted bandwidth).
  - Reliable native download (HttpURLConnection streaming + progress, modeled after Mihon) with browser-like UA.
  - Layered guards + post-download verification (content-type, size, "PK" magic bytes) in both native and JS paths to prevent corrupted/parse errors.
  - Hands off to standard Android package installer via FileProvider + content:// URI (with graceful unknown-sources handling).
  - After successful update, next launch shows "What's new" / changelog popup (same centered style).
- Stable signing key across all releases (fixed keystore + --force in build scripts so updates are installable over previous versions).
- Website footer click opens a working demo of the update menu (real GitHub fetch + browser download for testing without a device).

### Fixed

- Finishing a workout rolls back to the active session if the server sync fails
- `setup-db.fish --users-only` wipes `tracked_stats` / `stat_logs` (removed stale `bodyweight_logs`)
- Many auto-update reliability issues (size mismatch 1649 bytes, "parsing file", failed to fetch, premature prompts, etc.)

### Changed

- Web deploys use `@sveltejs/adapter-vercel` instead of adapter-auto

## [0.0.1] - initial

- Base workout logging app (templates, exercises, Supabase sync, PWA + Android builds)