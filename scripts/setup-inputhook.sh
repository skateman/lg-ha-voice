#!/bin/sh
# Configure org.webosbrew.inputhook to intercept the Magic Remote mic button
# (keycode 428) and drive hold-to-talk in the HA Voice app.
#
# Must be run ON THE TV (via SSH).
#
# How it works:
#   - Legacy inputhook passes an event value on press and release.
#   - inputhookpp 1.5+ executes only on key-down and passes no argument.
#   - The wrapper treats a missing argument as a press. VAD ends recording
#     automatically when inputhookpp cannot signal button release.
#
# After running this script:
#   1. App receives {"action":"start"} on press  → begin recording
#   2. App receives {"action":"stop"}  on release → stop recording, send to HA

set -e

SCRIPT_PATH="/home/root/.config/lginputhook/ha-voice-mic.sh"
KEYBINDS_PATH="/home/root/.config/lginputhook/keybinds.json"

# ── Write the mic button handler script ────────────────────────────────────────
cat > "$SCRIPT_PATH" << 'HANDLER'
#!/bin/sh
# Legacy inputhook: $1 is 1=press, 0=release, 2=repeat.
# inputhookpp 1.5+: no argument, key-down only.

VALUE="${1:-1}"

if [ "$VALUE" = "1" ]; then
  # Button pressed → tell app to start listening
  luna-send -n 1 luna://com.webos.applicationManager/launch \
    '{"id":"com.homebrew.havoice","params":{"action":"start"}}'
elif [ "$VALUE" = "0" ]; then
  # Button released → tell app to stop listening and send to HA
  luna-send -n 1 luna://com.webos.applicationManager/launch \
    '{"id":"com.homebrew.havoice","params":{"action":"stop"}}'
fi
# value=2 (key repeat) is intentionally ignored
HANDLER

chmod +x "$SCRIPT_PATH"
echo "==> Handler script written: $SCRIPT_PATH"

# ── Update keybinds.json ───────────────────────────────────────────────────────
# Read existing keybinds, replace/add entry for key 428.
# We use a Python one-liner so we don't need jq on the TV.
python3 - "$KEYBINDS_PATH" "$SCRIPT_PATH" << 'PY'
import sys, json

path = sys.argv[1]
script = sys.argv[2]

try:
    with open(path) as f:
        kb = json.load(f)
except Exception:
    kb = {}

kb["428"] = {
    "action": "exec",
    "command": script
}

with open(path, "w") as f:
    json.dump(kb, f, indent=2)

print("==> keybinds.json updated")
PY

echo ""
echo "Done! inputhook hot-reloads keybinds every 2 seconds — no restart needed."
echo "Press and hold the mic button to test."
