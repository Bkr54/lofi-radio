#!/usr/bin/env bash
#
# lofi-radio installer for Debian/Ubuntu VPS.
# Run from the repo root as root:   sudo bash deploy/install.sh
#
# It is idempotent-ish and interactive. It will:
#   - check dependencies (node >= 18, npm, ffmpeg)
#   - create an unprivileged service user
#   - install npm dependencies
#   - create .env (generating SESSION_SECRET + the scrypt password hash for you)
#   - seed config/ from the .example files
#   - install + enable the systemd service
#
# nginx + HTTPS (certbot) are left as a documented manual step (see README).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lofi-radio}"
SERVICE_USER="${SERVICE_USER:-lofiradio}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root (sudo)."

# --- 1. Dependencies ---
say "Checking dependencies..."
command -v node >/dev/null || die "Node.js not found. Install Node >= 18 first."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node >= 18 required (found $(node -v))."
command -v npm  >/dev/null || die "npm not found."
command -v ffmpeg >/dev/null || die "ffmpeg not found. Install it (apt install ffmpeg)."
command -v ffprobe >/dev/null || die "ffprobe not found (comes with ffmpeg)."
say "Node $(node -v), ffmpeg present. OK."

# --- 2. Place the app in APP_DIR ---
if [ "$REPO_DIR" != "$APP_DIR" ]; then
  say "Copying project to $APP_DIR ..."
  mkdir -p "$APP_DIR"
  cp -a "$REPO_DIR"/. "$APP_DIR"/
fi
cd "$APP_DIR"

# --- 3. Service user ---
if ! getent passwd "$SERVICE_USER" >/dev/null; then
  say "Creating service user '$SERVICE_USER'..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# --- 4. npm install ---
say "Installing npm dependencies..."
npm install --omit=dev --no-audit --no-fund

# --- 5. config files ---
[ -f config/stream.json ]   || cp config/stream.example.json config/stream.json
[ -f config/schedule.json ] || cp config/schedule.example.json config/schedule.json

# --- 6. .env ---
if [ -f .env ]; then
  say ".env already exists, leaving it untouched."
else
  say "Creating .env ..."
  read -rp "Dashboard password: " DASH_PW
  [ -n "$DASH_PW" ] || die "Password cannot be empty."
  read -rp "YouTube (RTMP) stream key: " STREAM_KEY
  read -rp "Local port [8080]: " PORT; PORT="${PORT:-8080}"
  read -rp "Public domain (for nginx, optional) [example.com]: " DOMAIN; DOMAIN="${DOMAIN:-example.com}"

  SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
  PWHASH="$(node -e '
    const c=require("crypto"); const s=c.randomBytes(16).toString("hex");
    console.log("scrypt$"+s+"$"+c.scryptSync(process.argv[1],s,64).toString("hex"));
  ' "$DASH_PW")"

  cat > .env <<EOF
PORT=${PORT}
STREAM_URL=rtmp://a.rtmp.youtube.com/live2
STREAM_KEY=${STREAM_KEY}
SESSION_SECRET=${SESSION_SECRET}
DASHBOARD_PASSWORD_HASH=${PWHASH}
COOKIE_SECURE=1
DOMAIN=${DOMAIN}
EOF
  chmod 600 .env
  say ".env created (password stored as a scrypt hash; secret generated)."
fi

# --- 7. Ownership ---
say "Setting ownership to $SERVICE_USER ..."
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"

# --- 8. systemd ---
say "Installing systemd service..."
UNIT=/etc/systemd/system/lofi-radio.service
sed -e "s#__USER__#${SERVICE_USER}#g" -e "s#__APP_DIR__#${APP_DIR}#g" \
    deploy/lofi-radio.service.example > "$UNIT"
systemctl daemon-reload
systemctl enable lofi-radio.service >/dev/null 2>&1 || true

cat <<EOF

\033[1;32mInstall complete.\033[0m

Next steps:
  1) Add your music + a background video (see media/README.md):
       $APP_DIR/media/mp3/<playlist>/*.mp3
       $APP_DIR/media/mp4/bg/*.mp4
     then:  chown -R $SERVICE_USER:$SERVICE_USER $APP_DIR/media
  2) Start it:           sudo systemctl start lofi-radio
                         sudo journalctl -u lofi-radio -f
  3) (Recommended) Put nginx + HTTPS in front:
       sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/<domain>
       sudo sed -i 's/__DOMAIN__/<domain>/; s/__PORT__/<port>/' /etc/nginx/sites-available/<domain>
       sudo ln -s /etc/nginx/sites-available/<domain> /etc/nginx/sites-enabled/
       sudo certbot --nginx -d <domain>
  4) Open the dashboard, log in, pick a playlist + background, click Start.

EOF
