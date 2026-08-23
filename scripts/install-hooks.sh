#!/usr/bin/env bash
# Ставит git-хуки проекта в .git/hooks (каталог не версионируется, поэтому
# после свежего clone хук нужно поставить заново):
#
#   bash scripts/install-hooks.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS="$(git -C "$ROOT" rev-parse --git-path hooks)"
mkdir -p "$HOOKS"

# Хук — тонкая обёртка: логика живёт в версионируемом scripts/pre-commit.sh,
# так что правки в нём подхватываются без переустановки.
cat > "$HOOKS/pre-commit" <<'HOOK'
#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/scripts/pre-commit.sh"
HOOK
chmod +x "$HOOKS/pre-commit"

echo "Установлен pre-commit → $HOOKS/pre-commit"
echo "Пропустить проверки разово: git commit --no-verify"
