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

set -l store_pass "LiftTrackerDevSigningKey2026!"
set -l key_pass $store_pass
set -l alias lift-tracker

# === BULLETPROOF REUSE LOGIC (MUST BE FIRST THING) ===
# If not forcing, and the key files exist and are loadable, we *always* reuse.
# This must be at the absolute top to survive multiple invocations during a build
# (cap sync, icons, gradle, etc.) and fish quirks.
if test $force_regen -eq 0
    if test -f $keystore -a -f $props
        if keytool -list -keystore $keystore -storepass $store_pass -alias $alias >/dev/null 2>&1
            echo "Release keystore already exists at $keystore"
            echo "Using existing key (same signature for app updates)."
            exit 0
        end
    end
end

# Special env var escape hatch (for agents/sessions building multiple versions).
if test "$LIFT_TRACKER_REUSE_SIGNING_KEY" = "1" -a $force_regen -eq 0
    if test -f $keystore -a -f $props
        echo "Release keystore already exists at $keystore (LIFT_TRACKER_REUSE_SIGNING_KEY=1)"
        echo "Using existing key (same signature for app updates)."
        exit 0
    end
end

# From here on: only reached if we are forcing or no usable key exists.
if test $force_regen -eq 1
    echo "Forcing new signing key (deleting existing)..."
    rm -f $keystore $props
else
    echo "No existing usable release keystore found — this should only happen on first-ever setup."
    echo "See SIGNING.md for how to restore the stable key instead of generating a new one."
    # Do NOT auto-generate for normal builds. Fail explicitly so the problem is obvious.
    echo "ERROR: Refusing to generate a new key. Restore the files from backup or run with --force only if you intend to rotate (and break updates for existing installs)."
    exit 1
end

# Only here if --force was used (intentional key (re)generation).
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
echo "See SIGNING.md at the repo root for the rules and location of the stable key."