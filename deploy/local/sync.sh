#!/bin/bash
# Keeps the Mac's copy of the site at the latest commit of the branch the
# admin saves to: pulls it, rebuilds and swaps the new build in. Runs every
# 20 seconds from launchd; does nothing when there is nothing new.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:/opt/homebrew/bin:/usr/bin:/bin"
HOME_DIR="$HOME/.local/share/sobremesa"
REPO="$HOME_DIR/repo"
SITE="$HOME_DIR/site"
BRANCH="${SOBREMESA_BRANCH:-v2}"

if [ ! -d "$REPO/.git" ]; then
  git clone -q --branch "$BRANCH" git@github.com:SrMonedero/sobremesa.git "$REPO"
fi
cd "$REPO"
git fetch -q origin "$BRANCH"
target="$(git rev-parse "origin/$BRANCH")"
built="$(sed -n 's/.*"head": *"\([0-9a-f]*\)".*/\1/p' "$SITE/published.json" 2>/dev/null || true)"
[ "$target" = "$built" ] && exit 0

echo "$(date '+%F %T') building $target"
before="$(git rev-parse HEAD)"
git reset -q --hard "$target"
if [ ! -d node_modules ] || ! git diff --quiet "$before" "$target" -- package-lock.json; then npm ci --silent; fi
rm -rf .build
npx astro build --outDir .build > /dev/null
printf '{ "head": "%s" }\n' "$target" > .build/published.json
mkdir -p "$SITE"
rsync -a --delete .build/ "$SITE/"
echo "$(date '+%F %T') published $target"
