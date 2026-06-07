#!/usr/bin/env fish

# scripts/setup-db.fish — reset Supabase schema or wipe user data
#
# Usage:
#   ./setup-db.fish                  # full reset (default setup.sql)
#   ./setup-db.fish --users-only     # delete auth users + app rows; keep schema
#   ./setup-db.fish --yes            # skip confirmation prompt
#   ./setup-db.fish --file path.sql  # custom SQL for full reset
#   ./setup-db.fish --help

set -l root (realpath (dirname (status filename)))/..
cd $root

set -l script_name scripts/setup-db.fish

function show_help --description 'Print usage'
    echo "$script_name — Supabase database maintenance"
    echo ""
    echo "Modes (pick one):"
    echo "  (default)       Full reset: drop & recreate schema, delete all auth users"
    echo "  --users-only    Wipe users only: delete auth.users + app data, keep schema"
    echo ""
    echo "Options:"
    echo "  -f, --file PATH   SQL file for full reset (default: supabase/setup.sql)"
    echo "  -y, --yes         Skip confirmation prompt"
    echo "  --no-notify       Skip PostgREST schema cache reload"
    echo "  -h, --help        Show this help"
    echo ""
    echo "Examples:"
    echo "  ./$script_name --yes"
    echo "  ./$script_name --users-only --yes"
    echo "  ./$script_name --file supabase/seed.sql"
end

if contains -- --help $argv; or contains -- -h $argv
    show_help
    exit 0
end

set -l sql_file supabase/setup.sql
set -l mode reset
set -l do_notify true
set -l yes false

argparse --name=$script_name \
    'f/file=' \
    'u/users-only' \
    'y/yes' \
    'no-notify' \
    -- $argv

if set -q _flag_file
    set sql_file $_flag_file
end

if set -q _flag_users_only
    set mode users-only
end

if set -q _flag_yes
    set yes true
end

if set -q _flag_no_notify
    set do_notify false
end

if test "$mode" = users-only
    if set -q _flag_file
        echo "❌ --file applies to full reset only. Omit it with --users-only."
        exit 1
    end
end

if test -z "$SUPABASE_DB_URL"
    echo "❌ SUPABASE_DB_URL is not set."
    echo "   set -Ux SUPABASE_DB_URL 'postgresql://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres'"
    exit 1
end

if not type -q psql
    echo "❌ psql not found. Install postgresql-client."
    exit 1
end

if test "$mode" = reset
    echo "🚨 Full reset: drops app schema, recreates tables, deletes all auth users."
else
    echo "🚨 Users only: deletes all auth users and app data. Schema is left intact."
end

if not $yes
    read -l -P "Continue? [y/N] " confirm
    if test "$confirm" != y -a "$confirm" != Y
        echo "Aborted."
        exit 0
    end
end

set -l success true

if test "$mode" = reset
    if not test -f $sql_file
        echo "❌ File not found: $sql_file"
        exit 1
    end

    echo ""
    echo "▶ Full reset: $sql_file"
    psql "$SUPABASE_DB_URL" -f $sql_file
    if test $status -ne 0
        set success false
        echo "❌ Reset failed."
    else
        echo "✅ Schema reset complete."
    end
else
    echo ""
    echo "▶ Wiping users and app data..."

    psql "$SUPABASE_DB_URL" -c "
CREATE OR REPLACE FUNCTION public.delete_all_accounts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS \$\$
BEGIN
  DELETE FROM public.exercise_personal_bests;
  DELETE FROM public.template_exercises;
  DELETE FROM public.exercises;
  DELETE FROM public.workout_history;
  DELETE FROM public.bodyweight_logs;
  DELETE FROM public.templates;
  DELETE FROM public.schedule;
  DELETE FROM public.usernames;
  DELETE FROM auth.users;
END;
\$\$;

REVOKE ALL ON FUNCTION public.delete_all_accounts() FROM public;
GRANT EXECUTE ON FUNCTION public.delete_all_accounts() TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_all_accounts() TO postgres;
" > /dev/null 2>&1

    psql "$SUPABASE_DB_URL" -c "SELECT public.delete_all_accounts();"
    if test $status -ne 0
        set success false
        echo "❌ User wipe failed."
    else
        echo "✅ All users and app data removed."
    end
end

if $do_notify
    echo ""
    echo "🔄 Reloading PostgREST schema cache..."
    psql "$SUPABASE_DB_URL" -c "NOTIFY pgrst, 'reload schema';"
    if test $status -eq 0
        echo "✅ Schema cache reloaded."
    end
end

echo ""
if $success
    echo "✅ Done!"
else
    echo "⚠️  Finished with errors."
end