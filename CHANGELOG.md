# Changelog

All notable changes to Lift Tracker are documented here.

## [1.1.0] - 2026-06-09

### UI Polish for Update Experience

- The update available prompt and post-update ("what's new") screen now share a consistent, polished design: green pill headings ("UPDATE AVAILABLE" / "UPDATED"), clear version comparison, "WHAT'S NEW" changelog boxes with matching styling, and primary action buttons in emerald.
- Added a fun confetti spray animation (small, centered bursts radiating outward, short duration) when the updated menu opens after installing a new version.
- Loading/boot screen placeholders now exactly match the user menu format and dimensions: boxed identity fields (name, joined, session, UID) and the Data usage grid (with "Data usage" header, consistent chip styling, updated abbreviations like "wrk logs", "sts", "sts logs", and swapped total size / sts logs order). This ensures seamless height/width matching during the reveal animation with no layout shift.
- Progress bar in the install flow is now a proper standalone bar (with percentage displayed on the right) shown in a reserved space so the dialog doesn't grow taller on click; the main button text updates in place to "Installing…".
- Added fake delays to the progress animation for a more satisfying feel: starts a bit late after tapping install, and after the real download completes it holds at 100% briefly before proceeding (no weird backtracking).
- Removed the "Later" button and the old GitHub footer message from the update prompt for a cleaner, more focused UI.
- Removed demo-specific error bubbles from the website version of the update menu.
- Identity texts (name, joined, session, UID) are now plain (no backgrounds or boxes); only the data usage chips use the boxed style.
- Updated website demo data to point to the correct existing release.

This release focuses on making the in-app update flow (and its website demo) feel polished, consistent, and delightful.

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