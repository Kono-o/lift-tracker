# Lift Tracker Android Release Process

**This document exists so that future releases (real or test) can be performed safely, repeatably, and without ever accidentally rotating the signing key or breaking auto-updates for existing users.**

It captures the exact process used for the first stable pair of releases (v1.0.0 + the immediate v1.0.1 faux test release) in June 2026, plus all the hard-won lessons from the development of the in-app auto-update feature.

## Core Philosophy & Non-Negotiables

- **One signing key for life (or until a deliberate, announced key rotation).**  
  Android (and our in-app updater) will refuse to install an update APK if it is not signed with the *exact same certificate* as the currently installed app. A new key = every existing user must uninstall + reinstall (data loss risk, bad UX, support nightmare).

- **package.json is the single source of truth for version.**  
  The build script reads `version` from it, computes `versionCode` (major*10000 + minor*100 + patch), does a surgical `sed` into `android/app/build.gradle`, then runs the full Capacitor + Gradle pipeline.

- **The build script + hardened setup script are the *only* approved way to produce a signed release APK.**  
  Never run Gradle manually for releases. Never pass `--force` to the setup script except in the most extreme documented key-rotation scenario.

- **GitHub Releases are the distribution + update source.**  
  The in-app updater (`src/lib/updater.ts` + the native `UpdaterPlugin.java`) fetches `/repos/Kono-o/lift-tracker/releases/latest`, prefers an asset named `lift-tracker-vX.Y.Z.apk`, streams it (with retries, UA, size + magic-byte verification), writes to app cache, then hands off to the system installer via the custom Capacitor plugin.

- **"Faux" / test releases are a deliberate and recommended pattern.**  
  After a real baseline (e.g. v1.0.0), immediately ship one or more near-identical APKs with only the version bumped (v1.0.1, possibly v1.0.2, etc.). This lets real users on real phones exercise the entire "UPDATE AVAILABLE" → download progress → system install → post-update "UPDATED + confetti" flow without waiting for a feature release. The release notes for faux releases explicitly say what they are for.

## The Stable Signing Key (The Most Important Asset)

**Master location (never commit, never lose):**  
`~/lift-tracker-stable-signing/`

Contains:
- `lift-tracker-release.keystore` (RSA 2048, 10000 days validity)
- `keystore.properties` (alias + the fixed password)
- `README.txt` (password + verification command + restore instructions)

**Current password (as of the v1.0.0 baseline):**  
`LT-Tracker-StableReleaseKey-v3-2026-!DoNotLose`

**Current fingerprint (SHA256):**  
`37:04:C3:16:01:76:C0:20:E5:2B:91:B9:4D:B7:1D:E0:EA:87:2C:8F:5A:8C:C3:1D:AB:2A:05:F3:D8:F7:34:96`

**Project working copy (gitignored):**  
`scripts/android-signing/lift-tracker-release.keystore`  
`scripts/android-signing/keystore.properties`

See also `SIGNING.md` (shorter version) and the `README.txt` inside the home backup directory.

### How the Protection Works (setup-android-signing.fish)

```fish
if test $force_regen -eq 0; and test -f $keystore -a -f $props
    echo "Release keystore already exists..."
    echo "Using existing key (same signature for app updates)."
    exit 0          # <--- critical early exit
end
# only then does it consider generating
...
keytool -genkeypair ...
```

- If the two files exist, it **always** reuses them and exits before any keytool command.
- `--force` / `-f` is the only way to delete + regenerate.
- The build script (`build-release-apk.fish`) calls the setup script with **no arguments**, so it can never accidentally force.
- If the project copy is ever missing (fresh clone, disk loss, etc.), the operator is instructed to copy the two files from the `~/` master backup *before* running the build. The script will then see them and reuse.

**Golden rule:** After the key was generated on 2026-06-09 (post several painful key-rotation incidents during auto-update development), we treat `--force` as radioactive.

## Full End-to-End Release Procedure (Real or Faux)

### 1. Preparation

- Make sure the two key files are present in `scripts/android-signing/` (restore from `~/lift-tracker-stable-signing/` if needed).
- Decide on the version.
  - Real feature release: bump according to semver (usually patch or minor).
  - Test / faux release: just bump the last component (e.g. 1.0.0 → 1.0.1) with **no other code changes**.
- Edit `package.json` → `"version": "X.Y.Z"`
  - (You can also let the build script + manual sed do it, but editing package.json first is clearest.)
- Optionally update `CHANGELOG.md` (real releases only; faux releases usually do not need changelog entries beyond the release notes).
- Commit or note the exact HEAD that will be tagged (the GH release will create a tag at the target you specify).

### 2. Build the APK

```sh
npm run build:apk:release
# or directly
./scripts/build-release-apk.fish
```

What it does (in order):
1. Calls `./scripts/setup-android-signing.fish` (must print "Using existing key..." and exit 0).
2. Reads version + computes versionCode from `package.json`.
3. Runs `./scripts/generate-android-icons.fish` (adaptive icons + splash).
4. `sed`s the two version lines in `android/app/build.gradle`.
5. `npm run cap:sync` (which does `CAPACITOR=1 vite build` + `npx cap sync` — this is when the web bundle with the injected `__APP_VERSION__` is produced).
6. Ensures `ANDROID_HOME`, `cd android`, `./gradlew assembleRelease`.
7. Copies `app/build/outputs/apk/release/app-release.apk` → `lift-tracker-vX.Y.Z.apk` in the same directory.
8. Prints the final path.

**Expected output (abridged):**
```
Release keystore already exists at .../lift-tracker-release.keystore
Using existing key (same signature for app updates).
Building release APK for v1.0.1 (versionCode 10001)...
... (icon generation) ...
BUILD SUCCESSFUL in ...
Release APK:
  /media/kono/HDD/dev/lift-tracker/android/app/build/outputs/apk/release/lift-tracker-v1.0.1.apk
```

**Note on noisy output:** Your personal fish config may print "🐟 went back ⮝ ..." on every `cd` inside scripts, and the "No existing release keystore found — generating..." message + keytool "alias already exists" error may appear. These are **harmless** — they come from shell hooks or re-execution artifacts. The important line is the early "Using existing key" + the fact that Gradle later runs `validateSigningRelease` and succeeds. The script's logic still took the reuse path.

### 3. Verify the Local APK (optional but recommended)

- Check the filename matches the version you intended.
- Size is typically ~3.5–3.7 MB for this app.
- To confirm the signature (best done against the *keystore*, not the APK, because modern APKs use v2/v3 signing blocks):

```sh
keytool -list -v \
  -keystore scripts/android-signing/lift-tracker-release.keystore \
  -storepass LT-Tracker-StableReleaseKey-v3-2026-!DoNotLose \
  -alias lift-tracker | grep -E 'Owner|SHA256'
```

You can also try (if `apksigner` is on PATH via `$ANDROID_HOME/build-tools/...`):

```sh
apksigner verify --print-certs android/app/build/outputs/apk/release/lift-tracker-vX.Y.Z.apk
```

The signer certificate must match the fingerprint above.

### 4. Create / Replace the GitHub Release

We use the `gh` CLI (assumes you are authenticated with a token that has `repo` scope).

**To publish a new release (or replace one with better notes / correct asset):**

```sh
# 1. (If replacing) Remove the old release + its tag so we can recreate cleanly
gh release delete v1.0.0 --yes --cleanup-tag || true
git tag -d v1.0.0 || true

# 2. Create the release, attaching the exact named APK as a positional argument
gh release create v1.0.0 \
  android/app/build/outputs/apk/release/lift-tracker-v1.0.0.apk \
  --target master \
  --title "v1.0.0 — First stable release" \
  -F /tmp/my-release-notes.md \
  --latest
```

- Positional asset path (after the tag) is how `gh release create` accepts files. Do **not** use `--attach`.
- `-F` (or `--notes-file`) is essential for long/verbose notes.
- `--target master` (or a specific SHA) pins the tag to the commit that contains the code you just built.
- `--latest` forces it (useful when you have just published a higher-numbered faux right after the baseline).
- After creation, the release page will have a direct "Source code" + the APK asset(s). The API `/releases/latest` will return it (non-draft, non-prerelease).

**For the immediate faux follow-up (v1.0.1 example):**

- Edit `package.json` to the next patch.
- Re-run the build script (it will be fast — most tasks UP-TO-DATE).
- `gh release delete v1.0.1 --yes --cleanup-tag || true`
- `gh release create v1.0.1 ...lift-tracker-v1.0.1.apk ... -F /tmp/faux-notes.md --latest`

The release body for a faux release should clearly state:
- It is functionally identical to the previous version.
- Its sole purpose is to let people who installed the baseline test the full in-app update flow (detection, download with progress + %, permission handling, system installer handoff, post-update "UPDATED" screen with confetti, last-seen-version recording so it doesn't nag again).
- Same stable key was used, so the update will be accepted cleanly.

### 5. Post-Release Verification

- Visit the release pages. Confirm the APK asset is present and has the expected byte size.
- On a phone with the previous version installed: cold-start the app (after being logged in + data loaded). You should see the centered update prompt.
- The prompt pulls `release.body` for the "WHAT'S NEW" box and the asset's `browser_download_url` + `size`.
- After a successful in-app update + reopen, you should see the post-update screen (only once, thanks to `LAST_SEEN_VERSION_KEY` localStorage + the `checkForPostUpdateChangelog` logic).

### 6. (Optional but nice) Update Local State & Commit

After the releases are published, the working tree will usually have:
- `package.json` (and possibly `package-lock.json`) at the final version you shipped.
- `android/app/build.gradle` with the last `sed`ed versionCode/Name.

You can leave it like this (next `npm run build:apk:release` will just work), or commit a "chore(release): vX.Y.Z" message. Do **not** commit the keystore files.

If you want both `lift-tracker-v1.0.0.apk` and `...-v1.0.1.apk` present on disk simultaneously for side-by-side testing, just run the build script twice (once at each version). Only the current version's named copy + the generic `app-release.apk` survive each individual build.

## Exact Commands Used for the v1.0.0 + v1.0.1 Baseline (June 2026)

(Recorded so the pattern can be copied verbatim.)

```sh
# Set baseline
node -e 'let p=require("./package.json"); p.version="1.0.0"; require("fs").writeFileSync("package.json", JSON.stringify(p,null,"\t")+"\n")'

./scripts/build-release-apk.fish

# (At this point the v1.0.0 named APK exists and is signed with the stable key)

# Prepare verbose notes (see the actual long markdown used for v1.0.0 in the release)
cat > /tmp/lift-tracker-v1.0.0-release-notes.md << 'EOF'
... (full holistic description of the app, features, sideloading story, update flow, minSdk rationale, install instructions, etc.)
EOF

gh release delete v1.0.0 --yes --cleanup-tag || true
git tag -d v1.0.0 || true

gh release create v1.0.0 \
  android/app/build/outputs/apk/release/lift-tracker-v1.0.0.apk \
  --target master \
  --title "v1.0.0 — First stable release" \
  -F /tmp/lift-tracker-v1.0.0-release-notes.md \
  --latest

# Now the faux test release
node -e '... set to "1.0.1" ...'

./scripts/build-release-apk.fish

# Short explanatory notes for the faux
cat > /tmp/lift-tracker-v1.0.1-release-notes.md << 'EOF'
This is a special test release. It is functionally 100% identical to v1.0.0...
( purpose: validate the entire in-app auto-update pipeline on real devices )
EOF

gh release delete v1.0.1 --yes --cleanup-tag || true
git tag -d v1.0.1 || true

gh release create v1.0.1 \
  android/app/build/outputs/apk/release/lift-tracker-v1.0.1.apk \
  --target master \
  --title "v1.0.1 — Faux test release (auto-update verification)" \
  -F /tmp/lift-tracker-v1.0.1-release-notes.md \
  --latest
```

At the end of this sequence:
- GitHub showed v1.0.1 as Latest and v1.0.0 below it.
- Both assets were present with identical sizes (~3.62 MiB).
- The in-app updater on a v1.0.0 device would see the newer version via `/releases/latest`.

## minSdk Choice (Android 8+ / API 26)

Set in `android/variables.gradle`:

```gradle
minSdkVersion = 26
compileSdkVersion = 36
targetSdkVersion = 36
```

Rationale (as of 2026):
- Covers the vast majority of active Android devices.
- Gives us modern security requirements, FileProvider, `REQUEST_INSTALL_PACKAGES`, decent `HttpURLConnection` behavior, etc.
- Avoids the very oldest devices that would require painful workarounds for the streaming download + installer handoff we do in the Updater plugin.
- Still "not too modern" — many apps target 24/26/28 as the practical floor.

If you ever need to raise it, do so deliberately, note it in the release notes, and consider the impact on the unknown-sources permission flow (which is already required on Android 8+ for our sideloading model).

## How the Auto-Updater Consumes Releases

Key files:
- `src/lib/updater.ts`
- `src/lib/version.ts` (injected at build time from package.json)
- `android/app/src/main/java/com/lifttracker/app/UpdaterPlugin.java` (native streaming download + `installApk` via FileProvider + `canInstallFromUnknownSources`)
- `src/routes/+page.svelte` (the UI for the centered blur-backed prompt, progress bar with live %, "UPDATED" screen + confetti)

Important behaviors:
- Only on native Android (`isNativeApp()`).
- Only after the user is logged in **and** their initial data has loaded (the prompt is gated in the main page logic).
- Only on fresh process starts (in-memory `hasCheckedThisLaunch` guard + the X button only dismisses until next cold start).
- `fetchLatestRelease` uses a proper User-Agent + GitHub API version headers + one retry.
- Prefers the `lift-tracker-v*.apk` asset name (exactly what our build script produces).
- Download does content-type guards, small-payload rejection, 3× retry with backoff, post-write size match + "PK" ZIP magic check, then cleanup on failure.
- Progress is emitted to the UI (and the native plugin also supports progress listeners).
- After successful system install + reopen, `checkForPostUpdateChangelog` compares `APP_VERSION` against `last-seen-version` in localStorage and shows the "UPDATED" modal (with the release notes) only if we are newer.
- The release `body` (markdown) is shown verbatim in both the pre- and post-update boxes.

This is why we need the faux releases: the whole chain (detection → notes → size → download → verify → promptInstall → post-update UX) must be proven on real hardware with real GitHub assets before we trust it for future real updates.

## Common Historical Pitfalls (and How Current Process Prevents Them)

1. **Key rotation** → "package conflicts with an existing package" on update.  
   Prevented by: early-exit reuse logic + master backup in `~/` + `SIGNING.md` + never passing `--force` from the build script + explicit "restore from home backup" instructions.

2. **Version desync** (package.json says 1.0.1 but gradle still has 1.0.0 or old versionCode).  
   Prevented by: the build script always does the `sed` right before `cap:sync` + `assembleRelease`, using the live `package.json` value.

3. **Tag already exists** when trying to recreate a release.  
   Pattern: `gh release delete TAG --yes --cleanup-tag; git tag -d TAG || true; gh release create ...`

4. **Bad downloads / "corrupted" or "parse error" on install.**  
   (Mostly fixed in the updater code itself before these releases.) The build process just has to produce a valid APK; the downloader now has multiple layers of verification + the direct `browser_download_url` + realistic mobile UA.

5. **Fish shell hook pollution in build logs.**  
   Harmless but confusing. The script still works. Documented here so future readers don't panic when they see duplicate "generating a new one" messages.

6. **Releasing from the wrong commit / dirty tree.**  
   The `gh release create --target master` (or a SHA) makes the tag point to a known good commit. The build itself only cares about the files present at build time.

7. **Forgetting that /releases/latest must be a non-prerelease with an APK asset.**  
   Our `gh` commands create normal releases. The updater explicitly skips drafts and prereleases.

## Maintaining the Documentation & Backup

- When you change the password or regenerate the key (rare), update:
  - `~/lift-tracker-stable-signing/README.txt`
  - `SIGNING.md`
  - `RELEASE.md` (this file)
  - The home backup directory itself (copy the new keystore + props).
- After every release, consider adding a one-line entry to `CHANGELOG.md` under the version (real releases).
- Keep this `RELEASE.md` up to date with any new gotchas or improved commands.
- The home backup should itself be copied to at least one more offline/encrypted location (password manager as secure note + attached files, VeraCrypt volume, etc.).

## Quick Reference Commands

```sh
# Normal build (current package.json version)
npm run build:apk:release

# Force a specific version for a one-off (temp)
node -e 'let p=require("./package.json"); p.version="1.2.3"; require("fs").writeFileSync("package.json", JSON.stringify(p,null,"\t")+"\n")'
./scripts/build-release-apk.fish
# (then revert package.json or bump for real)

# Verify key is the stable one
keytool -list -v -keystore scripts/android-signing/lift-tracker-release.keystore \
  -storepass LT-Tracker-StableReleaseKey-v3-2026-!DoNotLose -alias lift-tracker

# Clean recreate of a release
gh release delete vX.Y.Z --yes --cleanup-tag || true
git tag -d vX.Y.Z || true
gh release create vX.Y.Z \
  android/app/build/outputs/apk/release/lift-tracker-vX.Y.Z.apk \
  --target master \
  --title "..." \
  -F /tmp/notes.md \
  --latest
```

## Future Improvements (Nice to Have)

- A small `scripts/release.fish` wrapper that takes a version (or reads package), does the temp edit if needed, builds, opens an editor for notes, runs the gh commands, etc.
- Automated verification step after build that prints the signer fingerprint and aborts if it doesn't match the documented one.
- A `make latest` or similar that ensures the highest semantic version is marked `--latest`.

---

**Remember:** The goal is that installing v1.0.0 (or whatever the current baseline is) from the GitHub Releases page, then letting the in-app updater take you to the next version (real or faux), should feel as seamless and trustworthy as a Play Store update — without ever having distributed the app through the Play Store.

If you follow the steps in this document and respect the "never --force the key" rule, future releases will be boring and safe. Boring is good.

(Last updated after the v1.0.0 + v1.0.1 stable baseline pair — June 2026.)
