#!/usr/bin/env fish

# scripts/dev-phone.fish — run the Vite dev server for phone testing
#
# Usage:
#   ./dev-phone.fish           # LAN / ZeroTier URLs, then start dev server
#   ./dev-phone.fish --tunnel  # also expose a public localtunnel URL (AP isolation workaround)

set -l root (realpath (dirname (status filename)))/..
cd $root

set -l script_name scripts/dev-phone.fish

function show_help --description 'Print usage'
    echo "$script_name — dev server reachable from your phone"
    echo ""
    echo "Usage:"
    echo "  ./$script_name           Print LAN URLs and run npm run dev"
    echo "  ./$script_name --tunnel  Run dev server + localtunnel (works if Wi‑Fi blocks device-to-device)"
    echo "  ./$script_name --help"
    echo ""
    echo "On your phone, use the printed http:// IP — never localhost."
end

if contains -- --help $argv; or contains -- -h $argv
    show_help
    exit 0
end

function lan_ip
    hostname -I | awk '{print $1}'
end

function zt_ip
    ip -4 -o addr show 2>/dev/null | awk '/\szt[0-9a-f]+\s/ { split($4,a,"/"); print a[1]; exit }'
end

function wifi_ssid
    nmcli -t -f active,ssid dev wifi 2>/dev/null | string match -r '^yes:(.+)$' | head -1
end

function print_urls
    set -l lan (lan_ip)
    set -l zt (zt_ip)
    set -l ssid (wifi_ssid)

    echo ""
    echo "📱 Open on your phone:"
    if test -n "$lan"
        echo "   Wi‑Fi:     http://$lan:5173"
    end
    if test -n "$zt"
        echo "   ZeroTier:  http://$zt:5173  (ZeroTier app on phone, same network)"
    end
    if test -n "$ssid"
        echo ""
        echo "   Phone must be on Wi‑Fi: $ssid (not mobile data)"
    end
    echo ""
    echo "   If Wi‑Fi URL fails, your router may block phone↔PC (AP isolation)."
    echo "   Try: ./$script_name --tunnel"
    echo ""
end

if contains -- --tunnel $argv
    print_urls
    echo "▶ Starting dev server + localtunnel…"
    echo ""

    npm run dev &
    set -l vite_pid $last_pid
    disown $vite_pid

    # Wait until Vite is accepting connections
    for i in (seq 1 30)
        if curl -sf -o /dev/null --connect-timeout 1 http://127.0.0.1:5173/
            break
        end
        sleep 0.5
    end

    echo "▶ Tunnel URL (works from any network — paste on your phone):"
    echo ""
    npx --yes localtunnel --port 5173

    echo ""
    echo "Stopping dev server…"
    kill $vite_pid 2>/dev/null
    exit 0
end

print_urls
exec npm run dev