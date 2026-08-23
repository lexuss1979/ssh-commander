#!/usr/bin/env bash
# Проверки перед коммитом: то же, что гоняется вручную перед сдачей эпика.
#
# Устанавливается в .git/hooks/pre-commit скриптом scripts/install-hooks.sh
# (каталог .git/hooks не версионируется, поэтому источник лежит здесь).
#
# Пропустить разово:  git commit --no-verify
#
# Шаги идут ПАРАЛЛЕЛЬНО и независимы друг от друга: на медленной ФС (проект
# на /mnt/c под WSL) последовательный прогон занимал ~2,5 мин против ~1 мин
# параллельного — время диктует самый долгий шаг, а не сумма. Вывод при этом
# детерминированный: результаты печатаются в фиксированном порядке после
# завершения всех шагов.
#
# Отдельного `typecheck web` нет намеренно: `npm run build` в web/ — это
# `tsc && vite build`, то есть проверка типов уже внутри сборки.
#
# ВАЖНО: проверяется рабочее дерево, а не индекс. Если часть правок не
# добавлена в коммит, проверяется всё равно текущее состояние файлов — как
# при ручном прогоне. Чистая проверка только staged-состояния требовала бы
# stash непроверенного, а он умеет терять работу, поэтому не делается.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[1m'; N=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; N=''
fi

for d in server web; do
  if [ ! -d "$ROOT/$d/node_modules" ]; then
    printf '%spre-commit: нет %s/node_modules — выполните `npm install` в %s/%s\n' "$R" "$d" "$d" "$N"
    exit 1
  fi
done

# label | каталог | команда
STEPS=(
  'lint web|web|npx eslint src --quiet --cache --cache-location .eslintcache'
  'typecheck server|server|npx tsc --noEmit -p tsconfig.json'
  'tests server|server|npx vitest run'
  'build web|web|npm run build'
)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

printf '%spre-commit:%s %d проверки параллельно (пропустить — git commit --no-verify)\n' \
  "$B" "$N" "${#STEPS[@]}"

for i in "${!STEPS[@]}"; do
  IFS='|' read -r label dir cmd <<< "${STEPS[$i]}"
  (
    start=$(date +%s)
    out=$(cd "$ROOT/$dir" && eval "$cmd" 2>&1); status=$?
    printf '%s' "$out" > "$TMP/$i.out"
    printf '%s' "$(( $(date +%s) - start ))" > "$TMP/$i.time"
    printf '%s' "$status" > "$TMP/$i.status"
  ) &
done
wait

failed=0
declare -a FAILED_STEPS=()

for i in "${!STEPS[@]}"; do
  IFS='|' read -r label dir cmd <<< "${STEPS[$i]}"
  status=$(cat "$TMP/$i.status" 2>/dev/null || echo 1)
  elapsed=$(cat "$TMP/$i.time" 2>/dev/null || echo '?')
  printf '  %-18s' "$label"
  if [ "$status" = "0" ]; then
    printf '%sOK%s (%ss)\n' "$G" "$N" "$elapsed"
  else
    printf '%sОШИБКА%s (%ss)\n' "$R" "$N" "$elapsed"
    tail -30 "$TMP/$i.out" 2>/dev/null | sed 's/^/      /'
    printf '\n'
    failed=1
    FAILED_STEPS+=("$label")
    # Нативные бинарники rollup/esbuild ставятся под платформу: node_modules,
    # установленные из-под Windows, не работают в WSL и наоборот.
    if grep -q "MODULE_NOT_FOUND.*rollup\|Cannot find module.*rollup\|@rollup/rollup-" "$TMP/$i.out" 2>/dev/null; then
      printf '      %sПодсказка:%s node_modules собраны под другую платформу — `npm install` в %s/\n' "$Y" "$N" "$dir"
    fi
  fi
done

if [ $failed -ne 0 ]; then
  printf '\n%sКоммит отменён.%s Не прошло: %s\n' "$R" "$N" "${FAILED_STEPS[*]}"
  printf 'Исправьте и повторите, либо закоммитьте с --no-verify.\n'
  exit 1
fi

printf '%sВсе проверки пройдены.%s\n' "$G" "$N"
exit 0
