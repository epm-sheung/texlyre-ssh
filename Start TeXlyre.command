#!/usr/bin/env bash
# macOS: double-click in Finder to start TeXlyre + SSH (opens a Terminal
# window; keep it open while you work, Ctrl+C or closing it stops everything).
exec "$(dirname "$0")/start-texlyre.sh"
