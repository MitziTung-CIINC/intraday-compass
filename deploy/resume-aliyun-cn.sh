#!/usr/bin/env bash
set -Eeuo pipefail

APP_USER="intraday-compass"
APP_HOME="/var/lib/intraday-compass"
DEPLOY_DIR="/opt/intraday-compass"
LOG_FILE="/var/log/intraday-compass-deploy.log"
REGISTRY="https://registry.npmmirror.com"

if [[ "${DEPLOY_DIR}" != "/opt/intraday-compass" || ! -d "${DEPLOY_DIR}/.git" ]]; then
  echo "Deployment directory is not ready" >&2
  exit 1
fi

run_logged() {
  if ! "$@" >>"${LOG_FILE}" 2>&1; then
    echo "Command failed: $*" >&2
    tail -n 100 "${LOG_FILE}" >&2
    exit 1
  fi
}

pnpm_binary="$(command -v pnpm)"
run_logged chown -R "${APP_USER}:${APP_USER}" "${DEPLOY_DIR}" "${APP_HOME}"
run_logged runuser -u "${APP_USER}" -- env HOME="${APP_HOME}" npm_config_registry="${REGISTRY}" "${pnpm_binary}" --dir "${DEPLOY_DIR}" install --frozen-lockfile --fetch-retries=5 --fetch-timeout=120000 --network-concurrency=4
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
run_logged systemctl enable intraday-compass-quote.service
run_logged systemctl enable intraday-compass-web.service
run_logged systemctl restart intraday-compass-quote.service
run_logged systemctl restart intraday-compass-web.service
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
