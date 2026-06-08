# Changelog

All notable changes to Lift Tracker are documented here.

## [1.0.1] - 2026-06-08

### Added

- **Auto-updating for sideloaded APK** — On app startup (Android native only), the app automatically checks GitHub Releases for a newer version.
- Beautiful centered update prompt with blur backdrop (matching the style of the account/settings menu).
- "Later" (X) dismisses the prompt for the current launch only — it will reappear on the next fresh cold start (not on resume from background).
- "Install" makes the dialog unclosable, shows real-time download progress, then hands off to the standard Android package installer.
- Proper handling of `REQUEST_INSTALL_PACKAGES` permission + guidance to open the "Install unknown apps" settings screen when needed.
- Post-update "What's new" / changelog popup (same centered blur style) shown automatically the first time you launch the newly installed version.
- All changes follow Android best practices (FileProvider content URIs, conventional `ACTION_VIEW` + `PackageInstaller` flow) for reliable, secure updates using the same signing key.

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