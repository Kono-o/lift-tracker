#!/usr/bin/env fish
# Generate a release keystore for sideloadable APK builds (one-time setup).

set -l root (builtin realpath (dirname (status filename))/..)
set -l signing_dir "$root/scripts/android-signing"
set -l keystore "$signing_dir/lift-tracker-release.keystore"
set -l props "$signing_dir/keystore.properties"

mkdir -p $signing_dir

set -l force_regen 0
if contains -- --force $argv; or contains -- -f $argv
    set force_regen 1
end

# Ultra-defensive early reuse for release builds.
# If the files exist and we are not forcing, exit immediately.
# This protects against multiple invocations / fish sourcing quirks during a single build.
if test $force_regen -eq 0
    if test -f $keystore -a -f $props
        echo "Release keystore already exists at $keystore"
        echo "Using existing key (same signature for app updates)."
        exit 0
    end
end

# Special escape hatch for producing multiple versioned release APKs
# (e.g. 1.0.0 then 1.0.1) that must be signed with *exactly* the same key.
if test "$LIFT_TRACKER_REUSE_SIGNING_KEY" = "1" -a $force_regen -eq 0
    if test -f $keystore -a -f $props
        echo "Release keystore already exists at $keystore (LIFT_TRACKER_REUSE_SIGNING_KEY=1)"
        echo "Using existing key (same signature for app updates)."
        exit 0
    end
end

set -l store_pass "LiftTrackerDevSigningKey2026!"
set -l key_pass $store_pass
set -l alias lift-tracker

# Strong existence check: if the keystore file exists and the alias is present
# with our fixed password, we have a usable stable key. Never regenerate unless --force.
if test $force_regen -eq 0
    if test -f $keystore -a -f $props
        # Verify the key is actually loadable (catches corrupted or partial files)
        if keytool -list -keystore $keystore -storepass $store_pass -alias $alias >/dev/null 2>&1
            echo "Release keystore already exists at $keystore"
            echo "Using existing key (same signature for app updates)."
            exit 0
        end
    end
end

if test $force_regen -eq 1
    echo "Forcing new signing key (deleting existing)..."
    rm -f $keystore $props
else
    echo "No existing release keystore found — generating a new one."
end

# Clean before generation
rm -f $keystore $props

keytool -genkeypair -v \
    -keystore $keystore \
    -alias $alias \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass $store_pass \
    -keypass $key_pass \
    -dname "CN=Lift Tracker, OU=Mobile, O=Lift Tracker, L=Unknown, ST=Unknown, C=XX"

or begin
    echo "ERROR: keytool failed to generate the keystore."
    exit 1
end

printf '%s\n' \
    "storeFile=lift-tracker-release.keystore" \
    "storePassword=$store_pass" \
    "keyAlias=$alias" \
    "keyPassword=$key_pass" \
    > $props

echo "Created release keystore:"
echo "  $keystore"
echo "  $props"
echo ""
echo "Back up the keystore and keystore.properties — Android requires the same signing key for app updates."

# --- TEMP HACK FOR CONSISTENT 1.0.0 / 1.0.1 TEST RELEASES ---
# To ensure both APKs are signed with exactly the same key despite multiple
# invocations of this script during a build, we provide an escape hatch.
# If the env var LIFT_TRACKER_REUSE_SIGNING_KEY=1 is set, we force reuse
# of whatever keystore + props are on disk right now and never generate.
if test "$LIFT_TRACKER_REUSE_SIGNING_KEY" = "1"
    echo "[reuse-hack] LIFT_TRACKER_REUSE_SIGNING_KEY=1 — forcing reuse of current key and exiting early"
    exit 0
end