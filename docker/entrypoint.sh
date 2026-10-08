#!/usr/bin/env bash
set -e

# Ollama itself only listens on loopback, on an internal port - all traffic
# (from the bundled UI and from other local projects alike) goes through
# proxy.py on 11434 instead, so every request gets attributed and logged.
export OLLAMA_HOST=127.0.0.1:11500

nginx -g 'daemon off;' &
/bin/ollama serve &
python3 /usr/local/bin/proxy.py &

# If any process dies, exit so Docker's restart policy brings all three back
# up together rather than leaving the container in a half-working state.
wait -n
exit $?
