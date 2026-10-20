#!/usr/bin/env bash
# Release, ultimo passo: porta su `main` il commit di versione e i tag creati
# da `changeset publish`. Gira SOLO dopo una pubblicazione riuscita: il plugin
# su `main` (che il marketplace serve così com'è) non deve mai fissare una
# versione di @stubwise/mcp che su npm non esiste.
#
#   VERSIONED=true|false NEW_TAGS="<tag> ..." bash .github/scripts/release-push.sh
#
# VERSIONED=true: HEAD è il commit di versione, da pushare su main insieme ai
# tag (push --atomic: o tutto o niente). Se main è andato avanti nel frattempo
# si ribasa e si riprova; i tag, creati sul commit di prima del rebase, vengono
# rispostati sul commit ribasato, così puntano a un commit che è davvero su
# main. VERSIONED=false: solo i tag (una ripubblicazione senza changeset), che
# puntano a un commit già su main.
set -euo pipefail

REMOTE="${REMOTE:-origin}"
ATTEMPTS="${ATTEMPTS:-3}"
read -r -a TAGS <<< "${NEW_TAGS:-}"
TAG_REFS=()
for t in ${TAGS[@]+"${TAGS[@]}"}; do TAG_REFS+=("refs/tags/$t"); done

if [ "${VERSIONED:-false}" != "true" ]; then
  if [ "${#TAG_REFS[@]}" -gt 0 ]; then
    git push "$REMOTE" ${TAG_REFS[@]+"${TAG_REFS[@]}"}
  fi
  echo "Nessun commit di versione da pushare."
  exit 0
fi

fail() {
  echo "::error::$1"
  echo "Le versioni nuove sono GIÀ su npm, ma il commit di versione NON è su main."
  echo "Rimedio: rilancia a mano il workflow Release su main (Actions → Release →"
  echo "Run workflow). Se nel frattempo non sono entrati changeset nuovi,"
  echo "\`pnpm version-packages\` ricalcola le STESSE versioni dai changeset ancora"
  echo "pendenti, \`changeset publish\` salta quelle già su npm, e il commit arriva su"
  echo "main. In alternativa, ripeti i passi in locale e pusha tu il commit di versione."
  exit 1
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  if git push --atomic "$REMOTE" HEAD:refs/heads/main ${TAG_REFS[@]+"${TAG_REFS[@]}"}; then
    echo "Commit di versione e tag su main (tentativo $attempt)."
    exit 0
  fi
  echo "Push rifiutato (tentativo $attempt): main è andato avanti, ribaso."
  git fetch "$REMOTE" main
  if ! git rebase "$REMOTE/main"; then
    git rebase --abort || true
    fail "Il commit di versione confligge con main: il rebase non passa."
  fi
  for t in ${TAGS[@]+"${TAGS[@]}"}; do git tag -f -a "$t" -m "$t" HEAD; done
done
fail "Push su main fallito dopo $ATTEMPTS tentativi."
