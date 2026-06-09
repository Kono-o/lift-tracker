# Lift Tracker Stable Release Signing Key

**This is the single most important thing for Android releases.**

**For the full release workflow, build commands, GitHub release creation, faux-test-release strategy, verification steps, historical pitfalls, and how the in-app updater consumes releases, read `RELEASE.md` first.**

## The Key
All release APKs (starting with the v1.0.0 first stable baseline and forever after) must be signed with the **exact same certificate**.

The files live in the project at:
- `scripts/android-signing/lift-tracker-release.keystore`
- `scripts/android-signing/keystore.properties`

These are gitignored on purpose.

## Master Backup Location (STORE THIS SECURELY)
The authoritative backup is here on this machine:

**~/lift-tracker-stable-signing/**

It contains:
- The two key files
- README.txt with the password and full instructions

**Password:** LT-Tracker-StableReleaseKey-v3-2026-!DoNotLose

**Fingerprint (SHA256):** 37:04:C3:16:01:76:C0:20:E5:2B:91:B9:4D:B7:1D:E0:EA:87:2C:8F:5A:8C:C3:1D:AB:2A:05:F3:D8:F7:34:96

## How to Restore in a New Session / Machine / After Git Clone
1. Copy the two files from your master backup into the project:
   ```
   cp ~/lift-tracker-stable-signing/lift-tracker-release.keystore scripts/android-signing/
   cp ~/lift-tracker-stable-signing/keystore.properties scripts/android-signing/
   ```
2. Run your normal release build. The setup script will see the files and reuse the key.

## Rules (Non-Negotiable)
- Never run `scripts/setup-android-signing.fish --force` (or `-f`) again. It will create a brand new key and all your existing users will be unable to auto-update (they will get "package conflicts with an existing package").
- If the files disappear from the project, restore them from the master backup in `~/lift-tracker-stable-signing/`. Do not let the script generate a new one.
- Back up `~/lift-tracker-stable-signing/` to at least one offline/encrypted location.
- After every release build, you can verify with the command in the backup README.

## Why This Matters
Android (and the in-app updater) will only accept an update if the new APK is signed with the identical certificate as the one the user already has installed.

This key was freshly generated on 2026-06-09 (after several key-rotation incidents during auto-update feature development). It is the permanent baseline going forward.

See:
- `RELEASE.md` — the complete, detailed release process and "what we did" record.
- `~/lift-tracker-stable-signing/README.txt` — master backup instructions + verification command.
- The home backup directory itself for the actual keystore files.
