#!/usr/bin/env bash
# Start TeXlyre + SSH on macOS/Linux: runs the TeXlyre dev server and the
# SFTP bridge (skipping any that are already running), then opens TeXlyre in
# your browser with the bridge token, so there is nothing to paste.
# Keep this window open while you work; Ctrl+C (or closing it) stops both.
cd "$(dirname "$0")" || exit 1

TEXLYRE_PORT="${TEXLYRE_PORT:-5173}"
BRIDGE_PORT="${BRIDGE_PORT:-7050}"
URL="http://localhost:${TEXLYRE_PORT}/texlyre/"
LOG_DIR="${TMPDIR:-/tmp}/texlyre-ssh"
TOKEN_FILE="$HOME/.texlyre-sftp-bridge/token"
mkdir -p "$LOG_DIR"

if ! command -v node >/dev/null 2>&1; then
	echo "Node.js 20 or newer is required: https://nodejs.org/"
	exit 1
fi

if [ ! -d node_modules/vite ]; then
	echo "First run: installing TeXlyre dependencies, this takes a few minutes..."
	npm install --no-audit --no-fund || exit 1
fi
if [ ! -d sftp-bridge/node_modules/ssh2 ]; then
	echo "Installing SFTP bridge dependencies..."
	(cd sftp-bridge && npm install --no-audit --no-fund) || exit 1
fi

# Any HTTP answer (even the bridge's "upgrade required") means it's up.
listening() { curl -s -o /dev/null --max-time 2 "$1"; }

pids=()
cleanup() {
	for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; done
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if listening "$URL"; then
	echo "TeXlyre is already running."
else
	echo "Starting TeXlyre (log: $LOG_DIR/texlyre.log)..."
	node node_modules/vite/bin/vite.js --port "$TEXLYRE_PORT" --strictPort \
		>"$LOG_DIR/texlyre.log" 2>&1 &
	pids+=("$!")
fi

if listening "http://127.0.0.1:${BRIDGE_PORT}/"; then
	echo "The SFTP bridge is already running."
else
	echo "Starting the SFTP bridge (log: $LOG_DIR/bridge.log)..."
	WS_PORT="$BRIDGE_PORT" node sftp-bridge/bridge.cjs >"$LOG_DIR/bridge.log" 2>&1 &
	pids+=("$!")
fi

echo "Waiting for TeXlyre at $URL ..."
ready=""
for _ in $(seq 1 90); do
	if listening "$URL"; then ready=1; break; fi
	sleep 1
done
if [ -z "$ready" ]; then
	echo "TeXlyre did not respond within 90 seconds. See $LOG_DIR/texlyre.log"
	exit 1
fi

# The bridge writes its token file before it starts listening.
for _ in $(seq 1 30); do
	listening "http://127.0.0.1:${BRIDGE_PORT}/" && break
	sleep 1
done
OPEN_URL="$URL"
if [ -f "$TOKEN_FILE" ]; then
	TOKEN="$(head -n 1 "$TOKEN_FILE" | tr -d '\r\n')"
	[ -n "$TOKEN" ] && OPEN_URL="${URL}?sftp-bridge-token=${TOKEN}"
fi

if [ -z "$NO_BROWSER" ]; then
	if command -v open >/dev/null 2>&1 && [ "$(uname)" = "Darwin" ]; then
		open "$OPEN_URL"
	elif command -v xdg-open >/dev/null 2>&1; then
		xdg-open "$OPEN_URL" >/dev/null 2>&1 &
	else
		echo "Open this address in your browser: $URL"
	fi
fi

if [ "${#pids[@]}" -gt 0 ]; then
	echo ""
	echo "TeXlyre is running at $URL"
	echo "Keep this window open while you work. Press Ctrl+C to stop."
	wait "${pids[@]}"
else
	echo "Everything was already running."
fi
