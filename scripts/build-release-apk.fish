#!/usr/bin/env fish
# Build a signed release APK for sideloading (not Play Store).
#
# See RELEASE.md (in the repo root) for the full documented process,
# why the stable key must never be rotated, how to do real vs. faux
# test releases, the exact gh CLI commands, verification steps, etc.
# This script is deliberately kept simple and always calls setup
# without --force so the reuse guard can protect the signing key.

set -l root (builtin realpath (dirname (status filename))/..)
cd $root || exit 1

# Always request reuse of the stable key (see SIGNING.md). The setup script
# will now refuse to generate unless --force is passed.
set -x LIFT_TRACKER_REUSE_SIGNING_KEY 1
./scripts/setup-android-signing.fish
or exit 1

set -l app_version (node -p "require('$root/package.json').version")
set -l version_code (node -p "const v=require('$root/package.json').version.split('.').map(Number); v[0]*10000+v[1]*100+v[2]")
echo "Building release APK for v$app_version (versionCode $version_code)..."

./scripts/generate-android-icons.fish
or exit 1

set -l gradle "$root/android/app/build.gradle"
if test -f $gradle
    sed -i "s/versionCode [0-9]\\+/versionCode $version_code/" $gradle
    sed -i "s/versionName \"[^\"]*\"/versionName \"$app_version\"/" $gradle
end

npm run cap:sync
or exit 1

if test -z "$ANDROID_HOME" -a -f "$root/android/local.properties"
    set -l sdk_dir (string replace 'sdk.dir=' '' (grep '^sdk.dir=' "$root/android/local.properties"))
    if test -n "$sdk_dir"
        set -gx ANDROID_HOME $sdk_dir
    end
end

cd android
./gradlew assembleRelease
if test $status -ne 0
    exit 1
end

set -l apk "app/build/outputs/apk/release/app-release.apk"
set -l out "app/build/outputs/apk/release/lift-tracker-v$app_version.apk"

if not test -f $apk
    echo "Release APK not found at $apk"
    exit 1
end

cp $apk $out
echo ""
echo "Release APK:"
echo "  $root/android/$out"