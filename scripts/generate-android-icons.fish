#!/usr/bin/env fish
# Generate Android launcher icons from static/icon.svg (app favicon).

set -l root (builtin realpath (dirname (status filename))/..)
cd $root || exit 1

set -l icon_svg "$root/static/icon.svg"
set -l assets_dir "$root/assets"
set -l icon_png "$assets_dir/icon.png"

if not test -f $icon_svg
    echo "❌ Favicon not found: $icon_svg"
    exit 1
end

if not type -q convert
    echo "❌ ImageMagick convert not found."
    exit 1
end

mkdir -p $assets_dir

echo "▶ Rendering launcher icon from favicon..."
set -l fg_png (mktemp --suffix=-lift-icon-fg.png)
convert -background none -density 600 $icon_svg -resize 700x700 $fg_png
or exit 1
convert -size 1024x1024 xc:'#000000' $fg_png -gravity center -composite $icon_png
or exit 1
rm -f $fg_png

echo "▶ Generating Android mipmap assets..."
npx --yes @capacitor/assets generate \
    --android \
    --iconBackgroundColor '#000000' \
    --iconBackgroundColorDark '#000000'
or exit 1

echo "✅ Android icons updated from favicon."