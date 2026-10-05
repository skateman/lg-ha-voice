#!/bin/sh
# HA Voice – one-time setup for the Magic Remote mic button.
#
# Run this ONCE on the TV as root (via SSH):
#   sh /media/developer/apps/usr/palm/applications/com.homebrew.havoice/services/setup.sh
#
# What it does:
#   1. Writes the inputhook handler script for mic key 428
#   2. Updates /home/root/.config/lginputhook/keybinds.json
#   3. inputhook hot-reloads keybinds every 2s — no restart needed
#
# Requires: root access (TV must be rooted via RootMyTV / Homebrew Channel)

set -e

KEYBIND_DIR="/home/root/.config/lginputhook"
KEYBINDS_JSON="$KEYBIND_DIR/keybinds.json"
HANDLER_SCRIPT="$KEYBIND_DIR/ha-voice-mic.sh"

echo "==> Writing mic button handler script..."
mkdir -p "$KEYBIND_DIR"

cat > "$HANDLER_SCRIPT" << 'HANDLER'
#!/bin/sh
# Legacy inputhook passes $1 as 1=press, 0=release. inputhookpp 1.5+
# executes only on key-down and passes no argument, which toggles recording.
# Calls the service directly (applicationManager/launch does not reliably fire
# webOSRelaunch in the WAM app on all TV models).
VALUE="$1"
if [ -z "$VALUE" ]; then
  luna-send -n 1 luna://com.homebrew.havoice.service/voice/toggle '{}'
elif [ "$VALUE" = "1" ]; then
  luna-send -n 1 luna://com.homebrew.havoice.service/voice/start '{}'
elif [ "$VALUE" = "0" ]; then
  luna-send -n 1 luna://com.homebrew.havoice.service/voice/stop '{}'
fi
HANDLER

chmod +x "$HANDLER_SCRIPT"
echo "    $HANDLER_SCRIPT"

echo "==> Updating keybinds.json..."
python3 - << PYEOF
import json, os

path = "$KEYBINDS_JSON"
try:
    with open(path) as f:
        kb = json.load(f)
except Exception:
    kb = {}

kb["428"] = {"action": "exec", "command": "$HANDLER_SCRIPT"}

with open(path, "w") as f:
    json.dump(kb, f, indent=2)

print("    " + path)
PYEOF

echo "==> Patching service definition to keep service alive (disable idle timeout)..."
SVC_DEF="/var/luna-service2-dev/services.d/com.homebrew.havoice.service.service"
if [ -f "$SVC_DEF" ]; then
    sed -i 's|run-js-service -n |run-js-service -k |' "$SVC_DEF"
    echo "    $SVC_DEF"
else
    echo "    (service definition not found – run elevate-service first)"
fi

echo ""
echo "Done! inputhook hot-reloads every 2s — press the mic button to test."
