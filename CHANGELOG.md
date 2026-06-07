# Changelog

All notable changes to Lift Tracker are documented here.

## [1.0.2] - 2026-06-08

### Changed

- Faux test release (identical to 1.0.1) to verify the in-app auto-update flow from GitHub releases.

## [1.0.1] - 2026-06-08

### Added

- **Auto-updating for sideloaded APK** — On app startup (Android native only), the app checks GitHub Releases for a newer version.
- Centered update prompt with blur backdrop, matching the style and UX of the existing account/settings menu.
- "Later" (X) dismisses the prompt for the current launch only — it will reappear on the next fresh cold start.
- "Install" makes the dialog unclosable, shows real-time download progress, then hands off to the standard Android package installer.
- Proper handling of `REQUEST_INSTALL_PACKAGES` permission + guidance to open "Install unknown apps" settings when needed.
- Post-update "What's new" / changelog popup (same centered blur style) shown automatically the first time the newly installed version launches.
- All changes are fully native-plugin based where required (FileProvider + content URIs, conventional `ACTION_VIEW` install intent) for reliable, secure, industry-standard behavior.

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