#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.dev.yml"

case "${1:-up}" in
  up)
    # --build пересобирает только dev-стадию (npm ci); код подхватывается
    # через bind-mount без пересборки образа.
    $COMPOSE up -d --build
    ;;
  down)
    $COMPOSE down
    ;;
  restart)
    $COMPOSE restart
    ;;
  logs)
    $COMPOSE logs -f --tail=100
    ;;
  build)
    $COMPOSE build
    ;;
  *)
    echo "usage: $0 [up|down|restart|logs|build]" >&2
    exit 1
    ;;
esac
