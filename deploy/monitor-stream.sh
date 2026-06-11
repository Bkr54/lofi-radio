#!/bin/bash
# Optional health monitor for lofi-radio -> ntfy.sh push alerts.
# Detects: stream OK, voluntary stop (info), suspected abnormal stop (alarm),
#          service down, dashboard crash (NRestarts), disk almost full.
#
# Configure via environment (or an EnvironmentFile / /etc/default file), then run
# every minute from cron. All values have sane defaults:
#
#   SVC          systemd unit name           (default: lofi-radio.service)
#   SVC_USER     unix user the service runs   (default: lofiradio)  [scopes ffmpeg detection]
#   PORT         dashboard port               (default: 8080)
#   NTFY_CHANNEL ntfy.sh topic to publish to  (default: lofi-radio-CHANGEME)
#   APP_DIR      app directory                (default: /opt/lofi-radio)
#
# Example cron line (/etc/cron.d/lofi-radio-monitor):
#   * * * * * root SVC=lofi-radio.service NTFY_CHANNEL=my-secret-topic /opt/lofi-radio/deploy/monitor-stream.sh >> /opt/lofi-radio/run/monitor.log 2>&1
set -uo pipefail

SVC="${SVC:-lofi-radio.service}"
SVC_USER="${SVC_USER:-lofiradio}"
PORT="${PORT:-8080}"
NTFY_CHANNEL="${NTFY_CHANNEL:-lofi-radio-CHANGEME}"
APP_DIR="${APP_DIR:-/opt/lofi-radio}"

HEALTH_URL="http://127.0.0.1:${PORT}/healthz"
NTFY="https://ntfy.sh/${NTFY_CHANNEL}"
STATE_FILE="${APP_DIR}/run/monitor.state"
STALL_THRESHOLD=2
DISK_ALERT_PCT=90
HEARTBEAT_HOUR=9

mkdir -p "${APP_DIR}/run" 2>/dev/null

ntfy() { # $1=title $2=priority $3=tags $4=body
  curl -s -o /dev/null --max-time 10 \
    -H "Title: $1" -H "Priority: $2" -H "Tags: $3" -d "$4" "$NTFY"
}

PREV_STATE="INIT"; PREV_NRESTARTS=0; FAIL_COUNT=0; LAST_HEARTBEAT=""
[ -f "$STATE_FILE" ] && . "$STATE_FILE"

NOW=$(date '+%Y-%m-%d %H:%M:%S'); TODAY=$(date '+%Y-%m-%d'); HOUR=$(date '+%-H')

SVC_ACTIVE=$(systemctl is-active "$SVC" 2>/dev/null)
NRESTARTS=$(systemctl show -p NRestarts --value "$SVC" 2>/dev/null); NRESTARTS=${NRESTARTS:-0}

# ffmpeg of THIS service only (scoped by user), with debounce for the per-track engine.
FFMPEG_UP=0
for i in 1 2 3 4; do
  if pgrep -u "$SVC_USER" -x ffmpeg >/dev/null 2>&1; then FFMPEG_UP=1; break; fi
  [ $i -lt 4 ] && sleep 4
done

HEALTH_JSON=$(curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null)
INTENT_STREAM="unknown"
if echo "$HEALTH_JSON" | grep -q '"ok":true'; then
  if echo "$HEALTH_JSON" | grep -q '"isStreaming":true'; then INTENT_STREAM="yes"; else INTENT_STREAM="no"; fi
fi

DISK_PCT=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')

STATE="UP"
if [ "$SVC_ACTIVE" != "active" ]; then STATE="DOWN"
elif [ "$INTENT_STREAM" = "yes" ] && [ "$FFMPEG_UP" = "0" ]; then STATE="STALLED"
elif [ "$INTENT_STREAM" = "no" ]; then STATE="STOPPED"
else STATE="UP"; fi

if [ "$STATE" = "STALLED" ]; then FAIL_COUNT=$((FAIL_COUNT+1)); else FAIL_COUNT=0; fi

if [ "$NRESTARTS" -gt "$PREV_NRESTARTS" ] 2>/dev/null && [ "$PREV_STATE" != "INIT" ]; then
  ntfy "🔁 Dashboard restarted (crash?)" "high" "warning" \
    "$SVC restarted (NRestarts ${PREV_NRESTARTS}->${NRESTARTS}) at ${NOW}. Not user-initiated: check."
fi
if [ "$STATE" = "DOWN" ] && [ "$PREV_STATE" != "DOWN" ]; then
  ntfy "🔴 STREAM DOWN — service inactive" "urgent" "rotating_light" \
    "$SVC is '${SVC_ACTIVE}' at ${NOW}. Stream likely cut. Suspected non-user stop."
fi
if [ "$STATE" = "STALLED" ] && [ "$FAIL_COUNT" -ge "$STALL_THRESHOLD" ] && [ "$PREV_STATE" != "STALLED" ]; then
  ntfy "⚠️ Abnormal stop suspected" "urgent" "rotating_light,warning" \
    "Stream stalled at ${NOW}: app wants to broadcast but ffmpeg is gone. Probably not you."
fi
if [ "$STATE" = "STOPPED" ] && [ "$PREV_STATE" = "UP" ]; then
  ntfy "⏹️ Stream stopped (voluntary)" "low" "stop_button" \
    "Stream stopped cleanly via dashboard at ${NOW}. No anomaly."
fi
if [ "$STATE" = "UP" ] && { [ "$PREV_STATE" = "STALLED" ] || [ "$PREV_STATE" = "DOWN" ]; }; then
  ntfy "✅ Stream recovered" "default" "white_check_mark" "Stream is back to normal at ${NOW}."
fi
if [ -n "${DISK_PCT:-}" ] && [ "$DISK_PCT" -ge "$DISK_ALERT_PCT" ] 2>/dev/null; then
  ntfy "💽 Disk almost full (${DISK_PCT}%)" "high" "warning,floppy_disk" \
    "Root disk at ${DISK_PCT}% at ${NOW}. Risk for stream and logs."
fi
if [ "$STATE" = "UP" ] && [ "$HOUR" = "$HEARTBEAT_HOUR" ] && [ "$LAST_HEARTBEAT" != "$TODAY" ]; then
  LOAD=$(cut -d' ' -f1 /proc/loadavg)
  ntfy "✅ Radio OK — heartbeat" "min" "white_check_mark,satellite_antenna" \
    "Stream active at ${NOW}. load=${LOAD}, disk=${DISK_PCT}%."
  LAST_HEARTBEAT="$TODAY"
fi

cat > "$STATE_FILE" <<EOF
PREV_STATE="$STATE"
PREV_NRESTARTS=$NRESTARTS
FAIL_COUNT=$FAIL_COUNT
LAST_HEARTBEAT="$LAST_HEARTBEAT"
EOF
exit 0
