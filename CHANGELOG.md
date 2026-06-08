# Changelog

All notable changes to Lift Tracker are documented here.

## [1.0.2] - 2026-06-08

### Changed

- Faux test release (functionally identical to 1.0.1) for verifying the in-app auto-update flow.

## [1.0.1] - 2026-06-08

### Added

- Full auto-update support for the sideloaded Android APK.
- On startup (after reaching the main menu), the app checks GitHub Releases.
- Centered update prompt with blur background (same visual style as the account menu).
- Dismiss with X only affects the current launch (reappears on next fresh start).
- "Install" makes the dialog unclosable, shows live download progress, then launches the standard Android system installer.
- Handles "Install unknown apps" permission properly (opens settings if needed).
- After installing a new version, the next launch shows a "What's new" changelog popup.
- Stable release signing key so updates are accepted by Android.

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