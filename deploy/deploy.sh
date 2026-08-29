#!/bin/sh
# Deploy Tandem to the production server (idempotent).
# Usage: ./deploy/deploy.sh   (run from the repo root after `npm run build`)
set -eu

HOST=root@147.93.116.146
NODE_VERSION=v22.23.2

echo "==> preparing directories + Node 22 runtime"
ssh -o BatchMode=yes "$HOST" "
  set -eu
  mkdir -p /srv/tandem/app/server /srv/tandem/app/web /srv/tandem/data /srv/tandem/projects
  if [ ! -x /opt/node22/bin/node ]; then
    cd /tmp
    curl -fsSLO https://nodejs.org/dist/latest-v22.x/node-$NODE_VERSION-linux-x64.tar.gz
    tar xzf node-$NODE_VERSION-linux-x64.tar.gz -C /opt
    rm -f /opt/node22 node-$NODE_VERSION-linux-x64.tar.gz 2>/dev/null || true
    [ -d /opt/node22 ] || ln -s /opt/node-$NODE_VERSION-linux-x64 /opt/node22
  fi
  /opt/node22/bin/node --version
"

echo "==> syncing build artifacts"
rsync -az --delete -e "ssh -o BatchMode=yes" server/dist/ "$HOST":/srv/tandem/app/server/dist/
rsync -az -e "ssh -o BatchMode=yes" server/package.json "$HOST":/srv/tandem/app/server/package.json
rsync -az --delete -e "ssh -o BatchMode=yes" web/dist/ "$HOST":/srv/tandem/app/web/dist/
rsync -az -e "ssh -o BatchMode=yes" deploy/tandem.service "$HOST":/etc/systemd/system/tandem.service

echo "==> installing server dependencies + (re)starting service"
ssh -o BatchMode=yes "$HOST" "
  set -eu
  chown -R aiaccounting:aiaccounting /srv/tandem
  cd /srv/tandem/app/server
  sudo -u aiaccounting env PATH=/opt/node22/bin:/usr/bin:/bin npm install --omit=dev --no-audit --no-fund --loglevel=error
  # headless Chromium for the internal browser tool (idempotent: no-op when the
  # exact browser build playwright wants is already present)
  sudo -u aiaccounting env PATH=/opt/node22/bin:/usr/bin:/bin bash -c 'cd /srv/tandem/app/server && npx playwright install chromium' 2>&1 | tail -2
  env PATH=/opt/node22/bin:/usr/bin:/bin bash -c 'cd /srv/tandem/app/server && npx playwright install-deps chromium' >/dev/null 2>&1 || true
  chown -R aiaccounting:aiaccounting /srv/tandem
  systemctl daemon-reload
  systemctl enable --now tandem
  systemctl restart tandem
  sleep 2
  curl -fsS http://172.17.0.1:7810/api/health && echo ' <- health OK'
"

echo "==> done"
