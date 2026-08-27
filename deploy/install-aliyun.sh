#!/usr/bin/env bash
set -Eeuo pipefail

APP_USER="intraday-compass"
APP_HOME="/var/lib/intraday-compass"
DEPLOY_DIR="/opt/intraday-compass"
REPOSITORY="https://github.com/MitziTung-CIINC/intraday-compass.git"
LOG_FILE="/var/log/intraday-compass-deploy.log"

if [[ "${DEPLOY_DIR}" != "/opt/intraday-compass" ]]; then
  echo "Unexpected deployment path" >&2
  exit 1
fi

touch "${LOG_FILE}"
chmod 0600 "${LOG_FILE}"

run_logged() {
  if ! "$@" >>"${LOG_FILE}" 2>&1; then
    echo "Command failed: $*" >&2
    tail -n 80 "${LOG_FILE}" >&2
    exit 1
  fi
}

export DEBIAN_FRONTEND=noninteractive
run_logged apt-get update
run_logged apt-get install -y ca-certificates curl git

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
fi

if (( node_major < 22 )); then
  run_logged curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource-setup-22.sh
  run_logged bash /tmp/nodesource-setup-22.sh
  run_logged apt-get install -y nodejs
fi

run_logged npm install --global pnpm@11.9.0

if ! id "${APP_USER}" >/dev/null 2>&1; then
  run_logged useradd --system --create-home --home-dir "${APP_HOME}" --shell /usr/sbin/nologin "${APP_USER}"
fi

if [[ -d "${DEPLOY_DIR}/.git" ]]; then
  run_logged git -C "${DEPLOY_DIR}" pull --ff-only origin main
else
  if [[ -e "${DEPLOY_DIR}" ]]; then
    backup_path="${DEPLOY_DIR}.backup.$(date +%Y%m%d%H%M%S)"
    run_logged mv -- "${DEPLOY_DIR}" "${backup_path}"
  fi
  run_logged git clone --depth 1 --branch main "${REPOSITORY}" "${DEPLOY_DIR}"
fi

run_logged chown -R "${APP_USER}:${APP_USER}" "${DEPLOY_DIR}" "${APP_HOME}"
pnpm_binary="$(command -v pnpm)"
run_logged runuser -u "${APP_USER}" -- env HOME="${APP_HOME}" "${pnpm_binary}" --dir "${DEPLOY_DIR}" install --frozen-lockfile
run_logged runuser -u "${APP_USER}" -- env HOME="${APP_HOME}" "${pnpm_binary}" --dir "${DEPLOY_DIR}" build

run_logged install -m 0644 "${DEPLOY_DIR}/deploy/intraday-compass-quote.service" /etc/systemd/system/intraday-compass-quote.service
run_logged install -m 0644 "${DEPLOY_DIR}/deploy/intraday-compass-web.service" /etc/systemd/system/intraday-compass-web.service
run_logged install -m 0644 "${DEPLOY_DIR}/deploy/intraday-compass-bond-radar.service" /etc/systemd/system/intraday-compass-bond-radar.service
run_logged install -m 0644 "${DEPLOY_DIR}/deploy/intraday-compass-bond-radar.timer" /etc/systemd/system/intraday-compass-bond-radar.timer

if [[ -f /etc/nginx/sites-available/00t00.com ]]; then
  run_logged cp -a /etc/nginx/sites-available/00t00.com "/etc/nginx/sites-available/00t00.com.backup.$(date +%Y%m%d%H%M%S)"
fi
run_logged install -m 0644 "${DEPLOY_DIR}/deploy/nginx-00t00.conf" /etc/nginx/sites-available/00t00.com
run_logged ln -sfn /etc/nginx/sites-available/00t00.com /etc/nginx/sites-enabled/00t00.com

run_logged systemctl daemon-reload
run_logged systemctl enable --now intraday-compass-quote.service
run_logged systemctl enable --now intraday-compass-web.service
run_logged systemctl enable --now intraday-compass-bond-radar.timer
run_logged nginx -t
run_logged systemctl reload nginx

sleep 3
run_logged curl -fsS http://127.0.0.1:8765/health
run_logged curl -fsS "http://127.0.0.1:4173/quote?symbol=600519&market=SH"
run_logged curl -fsS -H "Host: 00t00.com" http://127.0.0.1/

echo "DEPLOYMENT_OK"
echo "node=$(node --version)"
echo "pnpm=$(pnpm --version)"
echo "web=$(systemctl is-active intraday-compass-web.service)"
echo "quote=$(systemctl is-active intraday-compass-quote.service)"
echo "nginx=$(systemctl is-active nginx)"
echo "commit=$(git -C "${DEPLOY_DIR}" rev-parse --short HEAD)"
