#!/usr/bin/env fish
# Generate a release keystore for sideloadable APK builds (one-time setup).

set -l root (realpath (dirname (status filename)))/..
set -l signing_dir "$root/android-signing"
set -l keystore "$signing_dir/lift-tracker-release.keystore"
set -l props "$signing_dir/keystore.properties"

mkdir -p $signing_dir

if test -f $keystore -a -f $props
    echo "Release keystore already exists at $keystore"
    exit 0
end

set -l store_pass (openssl rand -base64 24 | tr -d '/+=' | string sub -l 24)
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