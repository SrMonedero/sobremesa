#!/bin/bash
# Serves the Mac's build of the site with its functions (admin API and
# /fotos), photos kept on disk in place of R2.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:/opt/homebrew/bin:/usr/bin:/bin"
HOME_DIR="$HOME/.local/share/sobremesa"
cd "$HOME_DIR/repo"
# Who you are in the admin on localhost, and the GitHub access it saves with.
cat > .dev.vars <<VARS
ACCESS_DEV_EMAIL=quiquealvarezmonedero@gmail.com
ACCESS_TEAM=localhost
ACCESS_AUD=localhost
GITHUB_TOKEN=$(gh auth token)
GITHUB_REPO=SrMonedero/sobremesa
GITHUB_BRANCH=${SOBREMESA_BRANCH:-v2}
LOCAL_PUBLISH=1
VARS
exec npx wrangler pages dev "$HOME_DIR/site" --ip 127.0.0.1 --port 4380 --r2 PHOTOS --persist-to "$HOME_DIR/state" --show-interactive-dev-session=false
