#!/usr/bin/env bash
# Builds the first commit of menu-display-portrait's gh-pages branch from its main branch:
# main:public/ at the site root, plus data/ = main:output/data/*.json (what the
# deploy-pages workflow copied into public/data), plus .nojekyll.
#
# Usage: cloudrun/seed-portrait-gh-pages.sh <path to a menu-display-portrait clone>
#
# Only builds the branch locally and prints how it compares to the live site. It never
# pushes. Run it right before pushing, so the data is current. Once the jobs publish to
# gh-pages (deployed after the push), they keep data/ and promos/ fresh.
set -euo pipefail

repo=${1:?usage: $0 <menu-display-portrait clone>}
cd "$repo"
git remote get-url origin | grep -qi 'jwal7000/menu-display-portrait' || { echo "not a menu-display-portrait clone" >&2; exit 1; }
if git ls-remote --exit-code --heads origin gh-pages >/dev/null; then
  echo "origin already has a gh-pages branch; nothing to seed" >&2; exit 1
fi

git fetch --quiet origin main
src=$(git rev-parse --short origin/main)
work=$(mktemp -d)
trap 'rm -rf "$work"; git worktree prune' EXIT

git worktree add --quiet --detach "$work" origin/main
(
  cd "$work"
  git checkout --quiet --orphan gh-pages-seed
  git rm -rq --cached .
  find . -mindepth 1 -maxdepth 1 ! -name .git ! -name public ! -name output -exec rm -rf {} +
  mkdir -p public/data
  cp output/data/*.json public/data/
  rm -rf output
  # Move public/ to the root.
  shopt -s dotglob
  mv public/* .
  rmdir public
  touch .nojekyll
  git add -A
  git commit --quiet -m "chore: seed gh-pages from main@$src (public/ + output/data → data/)"
)
git branch -f gh-pages "$(git -C "$work" rev-parse HEAD)"
git worktree remove --force "$work"

echo "Built local branch gh-pages from main@$src:"
git ls-tree -r --name-only gh-pages | sed 's/^/  /'
echo
echo "Check it against the live site, then push (needs the go-ahead, see cloudrun/README.md):"
echo "  git -C $repo push origin gh-pages"
