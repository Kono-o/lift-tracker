# Changelog

All notable changes to Lift Tracker are documented here.

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