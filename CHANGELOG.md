# Changelog

All notable changes to Lift Tracker are documented here.

## [1.0.0] - 2026-06-09

**Lift Tracker v1.0.0** is the first stable release of a focused workout logging app.

### Core Features
- Create reusable workout templates
- Log both rep-based and timed exercises during live workouts
- Real-time workout tracking with Supabase sync (auth + data persistence across devices)
- PWA support on web + a clean sideloadable Android APK

### Stats & Tracking
- Fully customizable stats (start values, optional targets, up to 6-character units)
- Daily stat logging with full history
- Archived stat labels when you delete a stat
- Stat log entries keep their name/unit even if the original stat is removed later
- Account menu shows your data usage (tracked stats + stat log count)

### Android Experience
- Proper sideload-friendly build with a stable release signing key (so future updates will install cleanly over this version)
- Built-in auto-update system that detects new releases from GitHub
- Clean, centered update prompt (only appears after you're logged in and your data has loaded)
- Safe download + install flow with proper unknown-sources permission handling

### Other
- Website footer can trigger a demo of the update flow for testing
- Various fixes around workout rollback on sync failure and database cleanup

This release represents the complete, polished foundation of the app.

## [0.0.1] - initial

- Base workout logging app (templates, exercises, Supabase sync, PWA + Android builds)