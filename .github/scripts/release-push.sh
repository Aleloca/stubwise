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
#
# ⚠️ `main` ha il ruleset «protect-main» (niente push diretti senza PR). Il
# push passa solo con la deploy key RELEASE_DEPLOY_KEY e «Deploy keys» fra i
# bypass actor del ruleset; se no GitHub lo rifiuta con «GH013 … repository rule violations», e riprovare non
# serve: lo si riconosce e si fallisce subito, lasciando il commit di
# versione su un branch a parte da cui aprire la PR.
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

# Un giro successivo NON ricrea questi tag: `changeset publish` salta le
# versioni già su npm, e tagga solo ciò che pubblica. Vanno quindi detti qui.
tags_note() {
  if [ "${#TAGS[@]}" -gt 0 ]; then
    echo "Tag di questa pubblicazione, NON pushati e che nessun giro successivo ricrea:"
    echo "  ${TAGS[*]}"
    echo "Ricreali sul commit di versione, una volta su main:"
    echo "  git tag -a <tag> -m <tag> <sha> && git push origin <tag>"
  fi
}

fail() {
  echo "::error::$1"
  echo "Le versioni nuove sono GIÀ su npm, ma il commit di versione NON è su main."
  echo "Rimedio: rilancia a mano il workflow Release su main (Actions → Release →"
  echo "Run workflow). Se nel frattempo non sono entrati changeset nuovi,"
  echo "\`pnpm version-packages\` ricalcola le STESSE versioni dai changeset ancora"
  echo "pendenti, \`changeset publish\` salta quelle già su npm, e il commit arriva su"
  echo "main. In alternativa, ripeti i passi in locale e pusha tu il commit di versione."
  tags_note
  exit 1
}

fail_ruleset() {
  local branch
  branch="release/versione-$(git rev-parse --short HEAD)"
  echo "::error::Push su main rifiutato dal ruleset «protect-main» (GH013): le versioni sono GIÀ su npm, il commit di versione NON è su main."
  if git push "$REMOTE" "HEAD:refs/heads/$branch"; then
    echo "Il commit di versione è sul branch $branch: aprine una PR verso main e mergiala."
  else
    echo "Non è stato possibile nemmeno pushare il branch $branch: ripeti i passi in locale."
  fi
  echo "Perché il giro arrivi da solo su main servono la deploy key con scrittura"
  echo "(secret RELEASE_DEPLOY_KEY) e «Deploy keys» fra i bypass actor del ruleset"
  echo "protect-main (Settings → Rules → Rulesets)."
  tags_note
  exit 1
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  if OUT=$(git push --atomic "$REMOTE" HEAD:refs/heads/main ${TAG_REFS[@]+"${TAG_REFS[@]}"} 2>&1); then
    echo "$OUT"
    echo "Commit di versione e tag su main (tentativo $attempt)."
    exit 0
  fi
  echo "$OUT"
  if echo "$OUT" | grep -qE 'GH013|repository rule violations'; then
    fail_ruleset
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
