#!/usr/bin/env fish

# scripts/migrate-db.fish — apply pending SQL migrations in filename order
#
# Usage:
#   ./migrate-db.fish
#   ./migrate-db.fish --yes
#   ./migrate-db.fish --help

set -l root (builtin realpath (dirname (status filename))/..)
set -l migrations_dir "$root/supabase/migrations"
cd $root || exit 1

set -l script_name scripts/migrate-db.fish

function show_help --description 'Print usage'
    echo "$script_name — apply Supabase migrations"
    echo ""
    echo "Runs every .sql file in $migrations_dir in lexicographic order."
    echo "Requires SUPABASE_DB_URL (direct Postgres connection string)."
    echo ""
    echo "Options:"
    echo "  -y, --yes   Skip confirmation prompt"
    echo "  -h, --help  Show this help"
end

if contains -- --help $argv; or contains -- -h $argv
    show_help
    exit 0
end

set -l yes false

argparse --name=$script_name 'y/yes' -- $argv

if set -q _flag_yes
    set yes true
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

if not test -d $migrations_dir
    echo "❌ Migrations directory not found: $migrations_dir"
    exit 1
end

set -l files (find "$migrations_dir" -maxdepth 1 -name '*.sql' | sort)
if test (count $files) -eq 0
    echo "ℹ️  No migration files in $migrations_dir"
    exit 0
end

echo "▶ Will apply "(count $files)" migration(s) from $migrations_dir"
for f in $files
    echo "   • $f"
end

if not $yes
    read -l -P "Continue? [y/N] " confirm
    if test "$confirm" != y -a "$confirm" != Y
        echo "Aborted."
        exit 0
    end
end

set -l success true

for f in $files
    echo ""
    echo "▶ $f"
    psql "$SUPABASE_DB_URL" -f $f
    if test $status -ne 0
        set success false
        echo "❌ Migration failed: $f"
        break
    end
end

if $success
    echo ""
    echo "🔄 Reloading PostgREST schema cache..."
    psql "$SUPABASE_DB_URL" -c "NOTIFY pgrst, 'reload schema';"
    echo ""
    echo "✅ Migrations complete."
else
    echo ""
    echo "⚠️  Finished with errors."
    exit 1
end