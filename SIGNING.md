# Stable Release Signing Key for Lift Tracker

**This document is critical for all future release builds and AI/agent sessions.**

## Location of the Canonical Key
- Keystore: `scripts/android-signing/lift-tracker-release.keystore`
- Properties: `scripts/android-signing/keystore.properties`

These files are **gitignored** (see `.gitignore`) because they contain the private signing key.

## Password
Hardcoded in `scripts/setup-android-signing.fish` as `LiftTrackerDevSigningKey2026!` (for build reproducibility across environments while keeping the key material stable).

## How the Key Was Established
- The key was (re)generated with `--force` during the clean v1.0.0 "first stable release" build.
- This key is used for **ALL** release APKs going forward.
- The `build-release-apk.fish` script calls `setup-android-signing.fish` (without `--force` by default), which has defensive checks to **always reuse** an existing key.

## Rules for Future Builds (MUST FOLLOW)
1. **Never run `setup-android-signing.fish --force`** (or with `-f`) unless you are intentionally rotating the signing key. Rotating the key will cause "package conflict" / install failures for all existing users when they try to auto-update.
2. If the key files are missing in a new environment/session (e.g. fresh clone, new dev machine, or agent workspace):
   - **Restore the exact files from a secure backup** of `lift-tracker-release.keystore` and `keystore.properties`.
   - Do **not** regenerate with --force.
3. For extra safety when producing multiple versions in one session (e.g. base 1.0.0 then faux 1.0.1):
   - Set the environment variable: `LIFT_TRACKER_REUSE_SIGNING_KEY=1`
   - Then run `./scripts/build-release-apk.fish`
   - The setup script will honor this and force-reuse the current on-disk key.
4. After every release build, verify the APK was signed with this key (check fingerprint if needed).
5. Always back up the two key files after the initial creation. Store the backup securely (e.g. password manager, encrypted volume, or team secret store). Loss of the key means users must reinstall manually.

## Verification
Run this after a build to confirm the key in use:
```fish
keytool -list -v -keystore scripts/android-signing/lift-tracker-release.keystore \
  -storepass LiftTrackerDevSigningKey2026! -alias lift-tracker | grep -E 'Owner|SHA256'
```

## Why This Matters
The in-app auto-updater (and Android itself) requires the **exact same signing certificate** for seamless updates. Different keys = "package merge conflict" / "app not installed" errors on update.

This key (and this document) must be treated as the single source of truth for the project's release identity.


## Current Stable Key Fingerprint (as of latest lock-in)
Owner: CN=Lift Tracker, OU=Mobile, O=Lift Tracker, L=Unknown, ST=Unknown, C=XX
SHA256: (run `keytool -list -v -keystore scripts/android-signing/lift-tracker-release.keystore -storepass LiftTrackerDevSigningKey2026! -alias lift-tracker` after any build to get the exact current value)

This fingerprint (and the .keystore file) is the one that must be used for *all* releases from this point forward for auto-updates to succeed without uninstall.

## Historical Note (per user report)
Auto-update (download + seamless install) worked correctly on-device during the initial implementation period (around the commits titled "Auto-update support for sideloaded APK" and the early faux test releases like the first v1.0.1 / v1.0.2). 

It stopped working after the period of repeated release redos, key forces, and the 1.1.0 UI polish work (confetti, loading screen matching, etc.). During that time the signing script was invoked in ways that caused repeated regeneration of the key (visible in build logs as "No existing release keystore found — generating a new one" even when files existed). Each regeneration produced a new certificate.

The current key (after the final lock-in) is the new baseline. Existing installs from the "working" era will need a one-time uninstall + fresh install of an APK built with this key. After that, updates should work again as long as we never regenerate.

