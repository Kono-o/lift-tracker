#!/usr/bin/env fish
# Build a signed release APK for sideloading (not Play Store).

set -l root (realpath (dirname (status filename)))/..
cd $root

./scripts/setup-android-signing.fish
or exit 1

set -l version (node -p "require('./package.json').version")
echo "Building release APK for v$version..."

npm run cap:sync
or exit 1

cd android
./gradlew assembleRelease
or exit 1

set -l apk "app/build/outputs/apk/release/app-release.apk"
set -l out "app/build/outputs/apk/release/lift-tracker-v$version.apk"

if not test -f $apk
    echo "Release APK not found at $apk"
    exit 1
end

cp $apk $out
echo ""
echo "Release APK:"
echo "  $root/android/$out"