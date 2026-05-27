#!/usr/bin/env bash
# cron-fallback.sh — Phase 5 OS cron fallback (scheduled-tasks MCP 미가용 시)
#
# Plan reference: plan-daily-evolve-pipeline.md §Phase 5.3
#   - scheduler_status=MCP_UNAVAILABLE 또는 사용자 결정 #2 cron primary 승격 시
#
# 등록: bash cron-fallback.sh install
# 제거: bash cron-fallback.sh uninstall
# 상태: bash cron-fallback.sh status
#
# Default: morning 9 KST = UTC 00:00 (DST 없음).
# Plan §사용자 default #6 (Claude reasoning 자동 routine) 와 다름 — cron 은 단순 batch.
# Phase 5.0 env probe 가 UNKNOWN/MCP_UNAVAILABLE 일 때 fallback.

set -u

ACTION="${1:-status}"
CRON_MARKER="# daily-evolve-pipeline (managed by cron-fallback.sh)"
DEFAULT_CRON_LINE="0 0 * * * cd $(pwd) && claude --print '/opnd-codex:daily-evolve --phase 4' > /dev/null 2>&1"
OPT_OUT_GUARD='[ "$CODEX_PLUGIN_DAILY_EVOLVE_DISABLED" = "1" ] && exit 0;'

install_cron() {
  if ! command -v crontab >/dev/null 2>&1; then
    echo "[cron-fallback] crontab not found — manual cron registration required" >&2
    return 2
  fi
  local current
  current="$(crontab -l 2>/dev/null || true)"
  if echo "$current" | grep -qF "$CRON_MARKER"; then
    echo "[cron-fallback] already installed — re-install with uninstall first" >&2
    return 1
  fi
  printf '%s\n%s\n%s %s\n' "$current" "$CRON_MARKER" "$OPT_OUT_GUARD" "$DEFAULT_CRON_LINE" | crontab -
  echo "[cron-fallback] installed: $DEFAULT_CRON_LINE"
}

uninstall_cron() {
  if ! command -v crontab >/dev/null 2>&1; then
    echo "[cron-fallback] crontab not found" >&2
    return 2
  fi
  crontab -l 2>/dev/null | sed "/$(printf '%s' "$CRON_MARKER" | sed 's:[][\\/.^$*]:\\&:g')/,+1d" | crontab -
  echo "[cron-fallback] uninstalled"
}

status_cron() {
  if ! command -v crontab >/dev/null 2>&1; then
    echo "[cron-fallback] crontab not found"
    return 0
  fi
  if crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
    echo "[cron-fallback] installed"
    crontab -l | grep -A1 -F "$CRON_MARKER"
  else
    echo "[cron-fallback] not installed"
  fi
}

case "$ACTION" in
  install)   install_cron ;;
  uninstall) uninstall_cron ;;
  status)    status_cron ;;
  *)
    echo "usage: $0 install|uninstall|status" >&2
    exit 1
    ;;
esac
