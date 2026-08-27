#!/usr/bin/env bash
set -Eeuo pipefail

APP_USER="intraday-compass"
APP_HOME="/var/lib/intraday-compass"
DEPLOY_DIR="/opt/intraday-compass"
SOURCE_SNAPSHOT="${DEPLOY_DIR}/public/data/bond-radar.json"

cd "${DEPLOY_DIR}"
backup="$(mktemp)"
cp -- "${SOURCE_SNAPSHOT}" "${backup}"
trap 'cp -- "${backup}" "${SOURCE_SNAPSHOT}"; rm -f -- "${backup}"' EXIT

result="$(runuser -u "${APP_USER}" -- env HOME="${APP_HOME}" BOND_RADAR_PUBLISH_MODE=midday /usr/bin/node tools/update-bond-radar.mjs)"
printf '%s\n' "${result}"

if grep -q '"published": false' <<<"${result}"; then
  exit 0
fi

runuser -u "${APP_USER}" -- env HOME="${APP_HOME}" /usr/bin/pnpm --dir "${DEPLOY_DIR}" build
systemctl restart intraday-compass-web.service
curl -fsS --retry 20 --retry-delay 1 --retry-connrefused --max-time 30 http://127.0.0.1:4173/data/bond-radar.json >/dev/null
