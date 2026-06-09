#!/usr/bin/env fish
# Generate a release keystore for sideloadable APK builds (one-time setup).
#
# This script contains the critical early-exit reuse logic that prevents
# accidental key rotation. See RELEASE.md and SIGNING.md for the full story
# and the "never run with --force" rule.

set -l root (builtin realpath (dirname (status filename))/..)
set -l signing_dir "$root/scripts/android-signing"
set -l keystore "$signing_dir/lift-tracker-release.keystore"
set -l props "$signing_dir/keystore.properties"

mkdir -p $signing_dir

set -l force_regen 0
if contains -- --force $argv; or contains -- -f $argv
    set force_regen 1
end

if test $force_regen -eq 0; and test -f $keystore -a -f $props
    echo "Release keystore already exists at $keystore"
    echo "Using existing key (same signature for app updates)."
    exit 0
end

if test $force_regen -eq 1
    echo "Forcing new signing key (deleting existing)..."
    rm -f $keystore $props
else
    echo "No existing release keystore found — generating a new one."
end

# Use a fixed, stable password for the development/sideload signing key.
# This ensures the generated keystore + properties are always in sync
# (the random password approach was causing "password incorrect" errors on this system).
set -l store_pass "LT-Tracker-StableReleaseKey-v3-2026-!DoNotLose"
set -l key_pass $store_pass
set -l alias lift-tracker

keytool -genkeypair -v \
    -keystore $keystore \
    -alias $alias \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass $store_pass \
    -keypass $key_pass \
    -dname "CN=Lift Tracker, OU=Mobile, O=Lift Tracker, L=Unknown, ST=Unknown, C=XX"

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