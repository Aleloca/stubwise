# B14 — Verifica manuale con chiamate vere

Guida per chi esegue a mano la sezione B14 del piano
`docs/plans/2026-09-30-pr-correction-loop.md`. Si fa **un test alla volta**:
esegui il comando, guarda cosa esce, annota il risultato nella tabella in
fondo, poi passa al successivo.

Regole che valgono per tutto il documento:

- **Solo repository e PR di prova.** Mai trion-webapp, mai una repository di un
  cliente. Ogni comando usa solo le variabili definite qui sotto: se una è
  vuota, fermati.
- **I token non si incollano in chat**, né in un documento, né in un issue.
  Stanno solo nel terminale, nelle variabili d'ambiente. I comandi di questa
  guida non li stampano mai (niente `curl -v`; gli errori degli script
  vengono redatti prima di essere mostrati).
- Esegui tutto **nello stesso terminale** (le variabili e la funzione
  `bbstate` definite in preparazione vivono lì).

---

## 1. Preparazione (una volta sola)

### 1.1 Cosa serve

**Bitbucket Cloud**

- Una repository di prova (`$WS/$REPO`) con una PR aperta (`$PR`) **aperta
  dall'account principale** (serve al T19: «l'autore chiede modifiche sulla
  propria PR»).
- **Account principale** (quello con cui Stubwise apre le PR) e **account
  revisore** (un altro utente, membro del workspace, con accesso in scrittura
  alla repository). Facoltativo ma richiesto dal testo di B14 §4: un **terzo
  utente** per mettere "Request changes" dalla UI.
- Una **seconda PR di prova già mergiata** (`$PR_MERGED`), per i test finali.
  Se non ce l'hai, creala solo quando arrivi al T35 (è l'unica operazione
  distruttiva, e resta dentro la repository di prova).
- Un **webhook di prova** sulla repository (Repository settings → Webhooks →
  Add webhook): trigger **Pull Request → "Changes request created"**; URL un
  endpoint che controlli tu (vale anche un URL che non risponde: la consegna
  viene comunque registrata). Attiva la cronologia delle richieste se
  Bitbucket la chiede, così *View requests* mostra i body. Crealo **prima**
  dei test di verdetto, così registra anche le chiamate API dei T21–T24.
- Per il T39 (emendamento E3): un **account Bitbucket esterno**, che non sia
  membro del workspace né abbia permessi sulla repository di prova, e il
  permesso di rendere **pubblica** la repository di prova per la durata del
  test (Repository settings → Repository details → togliere «This is a
  private repository»; rimetterla privata alla fine).
- API token (Atlassian → Account settings → Security → API tokens *with
  scopes*, app **Bitbucket**). Nel piano gli scope sono scritti abbreviati
  (`read:user`, `read:pullrequest`…); nella UI hanno il suffisso
  `:bitbucket`.

  | Variabile | Account | Scope |
  |---|---|---|
  | `BB_TOKEN` | principale | `read:user:bitbucket`, `read:repository:bitbucket`, `write:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket` |
  | `BB_REV_TOKEN` | revisore | `read:user:bitbucket`, `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket` |
  | `BB_TOKEN_NOUSER` | principale | come `BB_TOKEN` **ma SENZA** `read:user:bitbucket` |
  | `BB_TOKEN_RO` | principale | **solo** `read:repository:bitbucket` (nessuna scrittura) — per il T11/T12 |

**GitHub**

- Una repository di prova (`$O/$R`). Consigliato: **pubblica e di
  un'organizzazione di prova** in cui stanno sia l'autore sia il revisore. Due
  motivi: la protezione del branch (T31/T32) su una repo privata richiede un
  piano a pagamento, e un fine-grained PAT può non vedere una repo personale
  di un altro utente di cui si è solo collaboratori.
- Una PR aperta (`$N`) **aperta dall'account autore**, e una **PR di prova
  chiusa** (`$N_CLOSED`) per il T34 (chiudila solo quando ci arrivi, se non
  esiste già).
- **Account autore** e **account revisore** (un altro utente, con permesso di
  scrittura sulla repo: solo così la sua approvazione conta).
- Una **regola di protezione** sul branch base della PR: «Require a pull
  request before merging» con **1 approvazione richiesta**, **nessun** status
  check obbligatorio (altrimenti gli status di prova dei T13–T18 falsano
  `mergeable_state`). Serve ai T31/T32; puoi aggiungerla anche subito prima.
- Un **webhook di prova** sulla repository (Settings → Webhooks): evento
  **Pull request reviews**, content type `application/json`, URL come sopra.
  Crealo prima del T31: la consegna del T31 serve al T33 e al T37.
- Per il T38: il revisore scrive **un commento nella conversazione** della PR
  di prova e **un commento su una riga** del diff (dalla UI, quando ci arrivi).
  Meglio ancora se nell'organizzazione di prova il revisore è membro con
  appartenenza **privata** (Organization → People → la sua riga → «Private»):
  è il caso in cui GitHub potrebbe non dire `MEMBER`.
- Token:

  | Variabile | Account | Tipo e permessi |
  |---|---|---|
  | `GH_TOKEN_AUTHOR` | autore | fine-grained sulla repo di prova: Metadata read, Contents read, **Commit statuses: read & write**, **Pull requests: read & write** |
  | `GH_TOKEN_REV` | revisore | fine-grained sulla repo di prova: Metadata read, **Pull requests: read & write** |
  | `GH_TOKEN_REV_RO` | revisore | fine-grained sulla repo di prova: Metadata read, **Pull requests: read-only** (senza write) |
  | `GH_TOKEN_NOSTATUS` | autore | fine-grained sulla repo di prova: Metadata read, Contents read, **senza** Commit statuses |
  | `GH_TOKEN_NOPERM` | uno qualunque | fine-grained **senza alcun permesso** (Repository access: «Public repositories (read-only)», nessun permesso aggiunto) |
  | `GH_APP_TOKEN` | — | **facoltativo**: installation token di una GitHub App (per T7/T8) |

**Sulla macchina**

- `curl`, `jq`, Node ≥ 22.
- Il package `@stubwise/git` buildato dal worktree del ciclo di correzione
  (lo usa lo script dei test marcati «script»):

  ```bash
  cd /Users/aleloca/git/stubwise/.worktrees/pr-correction-loop && pnpm --filter @stubwise/git... build
  ```

  Lo script è
  `packages/git/scripts/b14-probe.mjs` (nel worktree del branch):
  chiama i metodi veri del package, riceve i token per **nome** di variabile
  e stampa solo esito, status HTTP, messaggio **redatto** e tre controlli
  («contiene il token», «contiene il suggerimento sui permessi della review»,
  «… dello status»). Se lo sposti altrove, aggiorna `PROBE` qui sotto.

### 1.2 Variabili d'ambiente

Prima i **token**, uno per uno, senza che finiscano nella cronologia della
shell: lancia la riga, incolla il token, premi Invio (non vedrai niente, è
voluto).

```bash
read -rs BB_TOKEN        && export BB_TOKEN
read -rs BB_REV_TOKEN    && export BB_REV_TOKEN
read -rs BB_TOKEN_NOUSER && export BB_TOKEN_NOUSER
read -rs BB_TOKEN_RO     && export BB_TOKEN_RO
read -rs GH_TOKEN_AUTHOR   && export GH_TOKEN_AUTHOR
read -rs GH_TOKEN_REV      && export GH_TOKEN_REV
read -rs GH_TOKEN_REV_RO   && export GH_TOKEN_REV_RO
read -rs GH_TOKEN_NOSTATUS && export GH_TOKEN_NOSTATUS
read -rs GH_TOKEN_NOPERM   && export GH_TOKEN_NOPERM
# facoltativo:
read -rs GH_APP_TOKEN      && export GH_APP_TOKEN
```

Poi il resto (sostituisci i segnaposto `<...>`):

```bash
# --- Bitbucket ---
export BB_EMAIL='<email Atlassian dell account principale>'
export BB_REV_EMAIL='<email Atlassian dell account revisore>'
export WS='<workspace di prova>'
export REPO='<repository di prova>'
export PR='<numero della PR di prova aperta dal principale>'
export PR_MERGED='<numero della PR di prova GIA mergiata>'   # serve solo al T35/T36

# --- GitHub ---
export O='<owner della repo di prova>'
export R='<nome della repo di prova>'
export N='<numero della PR di prova aperta dall autore>'
export N_CLOSED='<numero della PR di prova CHIUSA>'            # serve solo al T34

# --- comodità ---
export B="https://api.bitbucket.org/2.0/repositories/$WS/$REPO/pullrequests"
export V="https://api.github.com/repos/$O/$R/pulls"
export OUT=/tmp/b14-out.json
export PROBE=/Users/aleloca/git/stubwise/.worktrees/pr-correction-loop/packages/git/scripts/b14-probe.mjs

# stato dei partecipanti della PR Bitbucket di prova (usata dopo ogni passo dei T19-T24)
bbstate() { curl -sS -u "$BB_REV_EMAIL:$BB_REV_TOKEN" "$B/$PR" | jq -c '[.participants[] | {nick: .user.nickname, u: .user.uuid, state}]'; }
```

Infine il branch e lo **sha completo (40 caratteri)** della head di ciascuna
PR. Bitbucket e GitHub sono due repository diverse, quindi gli sha sono due
(nel testo di B14 c'è un solo `$SHA`: qui è `BB_SHA` per Bitbucket e `GH_SHA`
per GitHub).

```bash
export BB_BRANCH=$(curl -sS -u "$BB_EMAIL:$BB_TOKEN" "$B/$PR" | jq -r .source.branch.name)
export BB_SHA=$(curl -sS -u "$BB_EMAIL:$BB_TOKEN" "https://api.bitbucket.org/2.0/repositories/$WS/$REPO/refs/branches/$BB_BRANCH" | jq -r .target.hash)
export GH_SHA=$(curl -sS -H "Authorization: Bearer $GH_TOKEN_AUTHOR" -H 'Accept: application/vnd.github+json' "$V/$N" | jq -r .head.sha)
echo "BB_BRANCH=$BB_BRANCH  BB_SHA=$BB_SHA (${#BB_SHA} car.)  GH_SHA=$GH_SHA (${#GH_SHA} car.)"
```

Controlla che entrambi gli sha abbiano **40 caratteri** e che `BB_BRANCH` non
sia `null`. Non fare push sulle due PR durante i test: gli sha cambierebbero.

---

## 2. Test

Ordine: prima le letture (T1–T8), poi gli status di commit (T9–T18), poi i
verdetti sulle PR di prova (T19–T33), poi chi ha il permesso di chiedere
modifiche (T37–T39, emendamento E3: aggiunti dopo, hanno numeri più alti ma
vanno fatti qui), per ultimi i casi che richiedono una PR mergiata o chiusa
(T34–T36).

### Letture (nessuna modifica)

#### T1 — Bitbucket `/user` con il token principale (B14 §1)

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -u "$BB_EMAIL:$BB_TOKEN" https://api.bitbucket.org/2.0/user; jq -c '{uuid, nickname}' "$OUT"
```

- Atteso: `HTTP 200` e un `uuid` **tra graffe** (`{…}`).
- Se `HTTP 403`: i token esistenti vanno rigenerati con lo scope
  `read:user:bitbucket` (passo di deploy, non un bug). Annotalo.
- Da annotare: codice HTTP; copia il valore di `uuid` (è l'identità del
  principale: non è un segreto).

#### T2 — Bitbucket `/user` con il token del revisore (B14 §1a)

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -u "$BB_REV_EMAIL:$BB_REV_TOKEN" https://api.bitbucket.org/2.0/user; jq -c '{uuid, nickname}' "$OUT"
```

- Atteso: `HTTP 200` con un `uuid` **diverso** da quello del T1.
- Da annotare: codice; `uuid` del revisore, esattamente com'è (graffe e
  maiuscole comprese). Salvalo, serve al T26:
  `export BB_REV_UUID='<uuid copiato, graffe comprese>'`

#### T3 — Bitbucket `/user` con un token SENZA `read:user:bitbucket` (B14 §1b)

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -u "$BB_EMAIL:$BB_TOKEN_NOUSER" https://api.bitbucket.org/2.0/user; jq -c . "$OUT"
```

- Da annotare: **il codice è 403 o 401?** Se è **401**, il messaggio di B10
  (che nomina lo scope sul 403 e le credenziali sul 401) sta sul ramo
  sbagliato e va corretto prima del merge. Copia anche il campo
  `error.message` del JSON, se c'è.

#### T4 — Script: `getAuthenticatedUserId` Bitbucket con lo stesso token del T3 (B14 §1c)

```bash
node "$PROBE" bb-user BB_EMAIL BB_TOKEN_NOUSER
```

- Atteso: `ESITO: ERRORE`, uno `status HTTP` uguale al T3, un messaggio che
  dice il motivo, e `CONTIENE IL TOKEN O LA SUA FORMA BASE64: no`.
- Da annotare: il messaggio redatto; il valore della riga «CONTIENE IL
  TOKEN…». Se è `SI`, è un difetto da correggere prima del merge.

#### T5 — GitHub `/user` con un fine-grained PAT senza permessi (B14 §8 bis a)

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $GH_TOKEN_NOPERM" -H 'Accept: application/vnd.github+json' https://api.github.com/user; jq -c '{id, login}' "$OUT"
```

- Atteso: `HTTP 200` con `id` **numerico** (leggere la propria identità non
  chiede permessi).
- Da annotare: codice; `id` è un numero sì/no.

#### T6 — GitHub `/user` con il token del revisore (B14 §8 bis b, prima parte)

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $GH_TOKEN_REV" -H 'Accept: application/vnd.github+json' https://api.github.com/user; jq -c '{id, login}' "$OUT"
```

- Atteso: `HTTP 200`, `id` numerico.
- Da annotare: `id` del revisore. Salvalo, serve al T33:
  `export GH_REV_ID='<id>'`

#### T7 — (Facoltativo) GitHub `/user` con l'installation token di una App (B14 §8 bis c)

Salta T7 e T8 se non hai `GH_APP_TOKEN`.

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $GH_APP_TOKEN" -H 'Accept: application/vnd.github+json' https://api.github.com/user; jq -c '{message}' "$OUT"
```

- Atteso: `HTTP 403`.
- Da annotare: codice e `message`.

#### T8 — (Facoltativo) Script: `getAuthenticatedUserId` GitHub con l'installation token (B14 §8 bis c)

```bash
node "$PROBE" gh-user GH_APP_TOKEN
```

- Atteso: `ESITO: ERRORE`, `status HTTP: 403`, un messaggio che chiede un
  **utente con un personal access token** (non quello del rate limit, che
  parla di «limite di richieste»), `CONTIENE IL TOKEN…: no`.
- Da annotare: quale dei due messaggi è uscito; riga «CONTIENE IL TOKEN».

### Status di commit (scrivono uno status sul commit di prova, non toccano il codice)

#### T9 — Bitbucket: status di build SENZA `url` (B14 §2, prima parte)

**Modifica:** crea lo status `stubwise-review` (INPROGRESS) sul commit
`$BB_SHA` della PR di prova.

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -u "$BB_EMAIL:$BB_TOKEN" -H 'Content-Type: application/json' -X POST "https://api.bitbucket.org/2.0/repositories/$WS/$REPO/commit/$BB_SHA/statuses/build" -d '{"key":"stubwise-review","state":"INPROGRESS","name":"Stubwise review","description":"prova senza url"}'; jq -c '{key, state, url, error}' "$OUT"
```

- `HTTP 201` = `url` facoltativo; `HTTP 400` = obbligatorio (il ripiego di B6,
  che manda sempre un `url`, è già la risposta giusta).
- Da annotare: **201 o 400?** Se 400, copia `error.message`.

#### T10 — Bitbucket: status con `refname` e `url`, visibile nella PR (B14 §2, seconda parte)

**Modifica:** sovrascrive lo status `stubwise-review` dello stesso commit.

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -u "$BB_EMAIL:$BB_TOKEN" -H 'Content-Type: application/json' -X POST "https://api.bitbucket.org/2.0/repositories/$WS/$REPO/commit/$BB_SHA/statuses/build" -d "{\"key\":\"stubwise-review\",\"state\":\"INPROGRESS\",\"name\":\"Stubwise review\",\"description\":\"prova con refname\",\"url\":\"https://example.com/stubwise-b14\",\"refname\":\"$BB_BRANCH\"}"; jq -c '{key, state, refname, url}' "$OUT"
```

- Atteso: `HTTP 201` (o 200).
- Poi apri la PR di prova nel browser: lo status «Stubwise review» deve
  comparire nella pagina della PR (sezione build/checks).
- Da annotare: codice; **lo status si vede nella PR sì/no**.

#### T11 — Bitbucket: status con un token SENZA scrittura sulla repository (B14 §6c, curl)

Non modifica nulla se il rifiuto è quello atteso.

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -u "$BB_EMAIL:$BB_TOKEN_RO" -H 'Content-Type: application/json' -X POST "https://api.bitbucket.org/2.0/repositories/$WS/$REPO/commit/$BB_SHA/statuses/build" -d '{"key":"stubwise-review","state":"INPROGRESS","name":"Stubwise review","description":"prova token senza scrittura"}'; jq -c '{error}' "$OUT"
```

- Atteso: `HTTP 401` o `HTTP 403`.
- Da annotare: **401 o 403?**

#### T12 — Script: `setCommitStatus` Bitbucket con lo stesso token (B14 §6c, script)

```bash
node "$PROBE" bb-status BB_EMAIL BB_TOKEN_RO
```

- Atteso: `ESITO: ERRORE`, status 401/403, `contiene il suggerimento sui
  permessi dello status: SI` (il messaggio nomina la scrittura sulla
  repository), `CONTIENE IL TOKEN…: no`.
- Da annotare: le due righe di controllo.

#### T13 — GitHub: descrizione dello status di 141 caratteri (B14 §5, seconda parte)

**Modifica:** accoda uno status `stubwise-review` (pending) su `$GH_SHA`.

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $GH_TOKEN_AUTHOR" -H 'Accept: application/vnd.github+json' -X POST "https://api.github.com/repos/$O/$R/statuses/$GH_SHA" -d "{\"state\":\"pending\",\"context\":\"stubwise-review\",\"description\":\"$(printf 'x%.0s' $(seq 1 141))\"}"; jq -c '{message, errors, desc_len: (.description // "" | length)}' "$OUT"
```

- `HTTP 422` = 141 caratteri sono troppi (conferma il troncamento di B7);
  `HTTP 201` = accettato (il troncamento resta innocuo). Con 201, guarda
  `desc_len`: se è minore di 141, GitHub ha troncato da sé.
- Da annotare: **422 o 201?** e `desc_len`.

#### T14 — GitHub: `target_url` non https (B14 §6a)

**Modifica:** accoda fino a due status con context `stubwise-review-prova`.

```bash
for U in http://stubwise.example.com/tickets/t1 http://localhost:3000/tickets/t1; do printf '%s -> ' "$U"; curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $GH_TOKEN_AUTHOR" -H 'Accept: application/vnd.github+json' -X POST "https://api.github.com/repos/$O/$R/statuses/$GH_SHA" -d "{\"state\":\"pending\",\"context\":\"stubwise-review-prova\",\"description\":\"url http\",\"target_url\":\"$U\"}"; jq -c '{message, errors}' "$OUT"; done
```

- Da annotare: il codice di **ciascuno dei due** URL (201 o 422). Se anche uno
  è 422, va scritto anche nel PR: C10 dovrà omettere `url` quando
  `STUBWISE_URL` non è https.

#### T15 — GitHub: gli status si accodano, la vista combinata mostra l'ultimo (B14 §6b)

**Modifica:** accoda due status `stubwise-review` (pending, poi success).

```bash
for S in pending success; do curl -sS -o /dev/null -w "POST $S -> HTTP %{http_code}\n" -H "Authorization: Bearer $GH_TOKEN_AUTHOR" -H 'Accept: application/vnd.github+json' -X POST "https://api.github.com/repos/$O/$R/statuses/$GH_SHA" -d "{\"state\":\"$S\",\"context\":\"stubwise-review\",\"description\":\"prova accodamento\"}"; done; curl -sS -H "Authorization: Bearer $GH_TOKEN_AUTHOR" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$O/$R/commits/$GH_SHA/status" | jq -c '[.statuses[] | select(.context=="stubwise-review") | .state]'
```

- Atteso: due `HTTP 201`, poi `["success"]` (la vista combinata tiene solo
  l'ultimo per context).
- Da annotare: l'array stampato in fondo.

#### T16 — GitHub: status con un token senza «Commit statuses» (B14 §6c, curl)

Non modifica nulla se il rifiuto è quello atteso.

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $GH_TOKEN_NOSTATUS" -H 'Accept: application/vnd.github+json' -X POST "https://api.github.com/repos/$O/$R/statuses/$GH_SHA" -d '{"state":"pending","context":"stubwise-review","description":"prova token senza permesso"}'; jq -c '{message}' "$OUT"
```

- Atteso: `HTTP 403`. (Un 404 vorrebbe dire che il token non vede proprio la
  repo: rifallo dando al token accesso alla repo di prova con Contents read.)
- Da annotare: codice e `message`.

#### T17 — Script: `setCommitStatus` GitHub con lo stesso token (B14 §6c, script)

```bash
node "$PROBE" gh-status GH_TOKEN_NOSTATUS
```

- Atteso: `ESITO: ERRORE`, `status HTTP: 403`, `contiene il suggerimento sui
  permessi dello status: SI`, `CONTIENE IL TOKEN…: no`.
- Da annotare: le due righe di controllo.

#### T18 — Script: emoji al confine dei 140 caratteri (B14 §6d)

**Modifica:** se GitHub accetta, accoda uno status `stubwise-review` pending.

```bash
node "$PROBE" gh-status GH_TOKEN_AUTHOR emoji; curl -sS -H "Authorization: Bearer $GH_TOKEN_AUTHOR" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$O/$R/commits/$GH_SHA/statuses?per_page=5" | jq -c '[.[] | select(.context=="stubwise-review")][0] | {state, len: (.description | length), tail: (.description[-4:])}'
```

- Lo script stampa `descrizione passata: .length = 141` e poi l'esito. La
  riga finale mostra lo status più recente con quel context.
- Se `ESITO: OK`: guarda `tail` — se finisce con `�…` (carattere di
  sostituzione + ellissi) GitHub ha accettato la mezza coppia sostituendola.
- Se `ESITO: ERRORE` con `status HTTP: 422`: il troncamento va fatto per code
  point (`Array.from`), da correggere prima del merge.
- Da annotare: **OK o 422?**; se OK, il valore di `tail`.

### Verdetti Bitbucket (cambiano lo stato dei partecipanti della PR di prova)

Prima di iniziare, guarda lo stato di partenza:

```bash
bbstate
```

Il revisore (il suo `uuid` è quello del T2) dovrebbe avere `state: null`. Se
non è così, azzeralo con
`curl -sS -o /dev/null -w '%{http_code}\n' -u "$BB_REV_EMAIL:$BB_REV_TOKEN" -X DELETE "$B/$PR/approve"` e lo stesso con `request-changes`.

#### T19 — L'autore chiede modifiche sulla propria PR (B14 §3, prima chiamata)

**Modifica:** se riesce, mette il principale in `changes_requested`; la
seconda riga lo ripulisce.

```bash
curl -sS -o "$OUT" -w 'POST request-changes (autore) -> HTTP %{http_code}\n' -u "$BB_EMAIL:$BB_TOKEN" -X POST "$B/$PR/request-changes"; jq -c '{state, error}' "$OUT"; bbstate
```

- Da annotare: **il codice** (200 = uno stato vero sarebbe possibile anche
  senza account revisore; 400/403 = no). È solo un'informazione: il design
  non lo usa.
- Pulizia (se è 200):
  `curl -sS -o /dev/null -w '%{http_code}\n' -u "$BB_EMAIL:$BB_TOKEN" -X DELETE "$B/$PR/request-changes"; bbstate`

#### T20 — `DELETE approve` del revisore senza niente da ritirare (B14 §3, seconda chiamata)

(Il comando cancella prima il file di output, così il corpo stampato dopo il codice è sicuramente quello di questa risposta; con un 204 la riga resta vuota.) Il revisore deve avere `state: null` (vedi `bbstate`).

```bash
rm -f "$OUT"; curl -sS -o "$OUT" -w 'DELETE approve (niente da ritirare) -> HTTP %{http_code}\n' -u "$BB_REV_EMAIL:$BB_REV_TOKEN" -X DELETE "$B/$PR/approve"; cat "$OUT" 2>/dev/null; echo
```

- Da annotare: **il codice** (204? 404? 400?). Conferma che il `DELETE`
  best-effort di B8 non va trattato come errore, qualunque sia.

#### T21 — `approve` ripetuto due volte (B14 §7a)

**Modifica:** il revisore approva la PR di prova.

```bash
for i in 1 2; do curl -sS -o /dev/null -w "approve #$i -> HTTP %{http_code}\n" -u "$BB_REV_EMAIL:$BB_REV_TOKEN" -X POST "$B/$PR/approve"; done; bbstate
```

- Da annotare: **200 e 200, o 200 e 409 (o altro)?** Se il secondo è un
  errore, B8 lo trasforma in un `GitProviderError` e C10 ripiegherebbe sul
  commento anche con lo stato già giusto: va gestito prima del merge.
- Stato atteso del revisore alla fine: `approved`.

#### T22 — Portare il revisore in `changes_requested` (B14 §7b, preparazione)

**Modifica:** ritira l'approvazione del T21 e chiede modifiche.

```bash
curl -sS -o /dev/null -w 'DELETE approve -> HTTP %{http_code}\n' -u "$BB_REV_EMAIL:$BB_REV_TOKEN" -X DELETE "$B/$PR/approve"; curl -sS -o /dev/null -w 'POST request-changes -> HTTP %{http_code}\n' -u "$BB_REV_EMAIL:$BB_REV_TOKEN" -X POST "$B/$PR/request-changes"; bbstate
```

- Atteso: `204`, poi `200`, e il revisore in `changes_requested`.
- Da annotare: i due codici e lo stato finale.

#### T23 — Da `changes_requested` ad `approve` SENZA il DELETE (B14 §7b)

**Modifica:** tenta di approvare direttamente.

```bash
curl -sS -o "$OUT" -w 'POST approve (nudo) -> HTTP %{http_code}\n' -u "$BB_REV_EMAIL:$BB_REV_TOKEN" -X POST "$B/$PR/approve"; jq -c '{state, error}' "$OUT"; bbstate
```

- Da annotare: **codice** e **stato del revisore** risultante (`approved`
  = il DELETE di B8 è solo prudente; rifiuto o stato rimasto
  `changes_requested` = il DELETE è necessario).

#### T24 — `DELETE request-changes` da `changes_requested` (B14 §7c)

**Modifica:** riporta il revisore in `changes_requested` e poi lo ritira.

```bash
curl -sS -o /dev/null -u "$BB_REV_EMAIL:$BB_REV_TOKEN" -X DELETE "$B/$PR/approve"; curl -sS -o /dev/null -w 'preparazione: POST request-changes -> HTTP %{http_code}\n' -u "$BB_REV_EMAIL:$BB_REV_TOKEN" -X POST "$B/$PR/request-changes"; bbstate; curl -sS -o /dev/null -w 'TEST: DELETE request-changes -> HTTP %{http_code}\n' -u "$BB_REV_EMAIL:$BB_REV_TOKEN" -X DELETE "$B/$PR/request-changes"; bbstate
```

- Atteso: dopo la preparazione il revisore è `changes_requested`; poi
  `TEST: … HTTP 204` e stato `null`.
- Da annotare: il codice della riga `TEST` e lo stato finale.

#### T25 — Forma vera del payload `changes_request_created` (B14 §4)

**Modifica:** dalla UI si mette "Request changes" sulla PR di prova.

Nessun comando: nel browser, con il **terzo utente** (se non ce l'hai, usa il
revisore e annotalo), apri la PR di prova e premi **Request changes**. Poi,
come amministratore della repo: Repository settings → Webhooks → il webhook di
prova → *View requests* → apri l'ultima consegna `pullrequest:changes_request_created`.

- Verifica nel body: `changes_request.user.uuid` e `actor.uuid` **uguali**;
  `pullrequest.source.branch.name` presente (= `$BB_BRANCH`).
- Da annotare: uguali sì/no; branch presente sì/no. Se la forma diverge dal
  test di B2, salva il body come fixture (togliendo eventuali dati personali).
- Pulizia: con lo stesso utente, rimuovi la richiesta di modifiche dalla UI.

#### T26 — La catena dell'identità: webhook, commento e `/user` (B14 §4 bis)

**Modifica:** il revisore mette "Request changes" e scrive un commento sulla
PR di prova.

1. Nel browser, **con l'account revisore**: sulla PR di prova premi
   **Request changes** e scrivi un commento qualunque (es. «prova B14»).
2. Poi nel terminale:

```bash
curl -sS -u "$BB_REV_EMAIL:$BB_REV_TOKEN" "$B/$PR/comments?pagelen=100" | jq -r '.values[].user.uuid' | sort -u; echo "uuid da /user (T2): $BB_REV_UUID"
```

3. In *View requests* apri la consegna generata al punto 1 e copia `actor.uuid`.

- Atteso: l'`uuid` del revisore nell'elenco dei commenti, `actor.uuid` della
  consegna e `$BB_REV_UUID` sono **identici byte per byte** (graffe e
  maiuscole comprese).
- Da annotare: identici sì/no; se no, le tre forme esatte.
- Pulizia: dalla UI il revisore ritira la richiesta di modifiche (il
  commento può restare).

### Verdetti GitHub (creano review sulla PR di prova)

#### T27 — L'autore chiede modifiche sulla propria PR (B14 §5, prima parte)

Non modifica nulla se il rifiuto è quello atteso.

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $GH_TOKEN_AUTHOR" -H 'Accept: application/vnd.github+json' -X POST "$V/$N/reviews" -d '{"event":"REQUEST_CHANGES","body":"prova"}'; jq -c '{message, errors}' "$OUT"
```

- Atteso: `HTTP 422` con «Can not request changes on your own pull request»
  (in `message` o in `errors`).
- Da annotare: codice; testo esatto di `message` ed `errors` (serve a sapere
  se la regex «own pull request» di B9 lo riconosce).

#### T28 — Revisore con token senza «Pull requests: write» (B14 §8c, curl)

Non modifica nulla se il rifiuto è quello atteso.

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $GH_TOKEN_REV_RO" -H 'Accept: application/vnd.github+json' -X POST "$V/$N/reviews" -d '{"event":"APPROVE","body":"prova token read-only"}'; jq -c '{message}' "$OUT"
```

- Atteso: `HTTP 403`.
- Da annotare: codice e `message`.

#### T29 — Script: `submitPrReview` GitHub con lo stesso token (B14 §8c, script)

```bash
node "$PROBE" gh-review GH_TOKEN_REV_RO "$N" approve
```

- Atteso: `ESITO: ERRORE`, `status HTTP: 403`, `contiene il suggerimento sui
  permessi della review: SI`, `CONTIENE IL TOKEN…: no`.
- Da annotare: le due righe di controllo.

#### T30 — `REQUEST_CHANGES` senza `body` (B14 §8b, prima parte)

Non modifica nulla se il rifiuto è quello atteso.

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $GH_TOKEN_REV" -H 'Accept: application/vnd.github+json' -X POST "$V/$N/reviews" -d '{"event":"REQUEST_CHANGES"}'; jq -c '{message, errors}' "$OUT"
```

- Atteso: `HTTP 422`.
- Da annotare: codice, `message` ed `errors` completi. **Contengono «own pull
  request»?** (non devono: altrimenti il messaggio dedicato all'autore di B9
  scatterebbe a torto).

#### T31 — Il revisore chiede modifiche; la PR è bloccata? (B14 §8a, prima metà)

Prerequisito: la regola di protezione con 1 approvazione e il webhook
GitHub (vedi Preparazione). **Modifica:** crea una review REQUEST_CHANGES del
revisore.

```bash
curl -sS -o /dev/null -w 'REQUEST_CHANGES -> HTTP %{http_code}\n' -H "Authorization: Bearer $GH_TOKEN_REV" -H 'Accept: application/vnd.github+json' -X POST "$V/$N/reviews" -d '{"event":"REQUEST_CHANGES","body":"prova"}'; sleep 5; curl -sS -H "Authorization: Bearer $GH_TOKEN_REV" -H 'Accept: application/vnd.github+json' "$V/$N" | jq -c '{mergeable_state}'
```

- Atteso: `HTTP 200` e `mergeable_state` = `blocked`. Se esce `unknown`,
  rilancia solo la seconda metà (dal `curl` dopo `sleep 5`) dopo qualche
  secondo.
- Da annotare: codice e `mergeable_state`.

#### T32 — Lo stesso revisore approva: la PR si sblocca? (B14 §8a, seconda metà)

**Modifica:** crea una review APPROVE del revisore.

```bash
curl -sS -o /dev/null -w 'APPROVE -> HTTP %{http_code}\n' -H "Authorization: Bearer $GH_TOKEN_REV" -H 'Accept: application/vnd.github+json' -X POST "$V/$N/reviews" -d '{"event":"APPROVE","body":"ok"}'; sleep 5; curl -sS -H "Authorization: Bearer $GH_TOKEN_REV" -H 'Accept: application/vnd.github+json' "$V/$N" | jq -c '{mergeable_state}'
```

- `mergeable_state` = `clean` (o comunque non `blocked`) → la protezione
  considera solo l'ultima review del revisore. `blocked` → il
  REQUEST_CHANGES resta bloccante finché non è «dismissed».
- Da annotare: codice e `mergeable_state` (con `unknown` riprova come nel
  T31). Va poi scritto nei «Fatti verificati» del piano.

#### T33 — Stesso id nella consegna del webhook (B14 §8 bis b, seconda parte)

Nessun comando. Su GitHub: Settings → Webhooks → il webhook di prova →
*Recent Deliveries* → la consegna `pull_request_review` con action
`submitted` generata dal REQUEST_CHANGES del T31.

- Verifica nel payload: `review.user.id` e `sender.id` **uguali** a
  `$GH_REV_ID` (T6). Controlla anche `review.state` = `changes_requested`.
- Da annotare: uguali sì/no; il valore di `review.state`.

### Chi ha il permesso di chiedere modifiche (emendamento E3)

Il ciclo di correzione riparte solo per chi ha il permesso sulla piattaforma:
su GitHub `author_association` ∈ `OWNER`/`MEMBER`/`COLLABORATOR`, su Bitbucket
nessun filtro (il dato non esiste). Questi tre test dicono se le due ipotesi
reggono sulle piattaforme vere.

#### T37 — GitHub: `author_association` nella consegna `pull_request_review` (E3)

Nessun comando. Su GitHub: Settings → Webhooks → il webhook di prova →
*Recent Deliveries* → la stessa consegna del T33 (il REQUEST_CHANGES del
revisore, T31).

- Verifica nel payload: `review.author_association` c'è, ed è `COLLABORATOR`
  o `MEMBER` (il revisore ha scrittura sulla repo). Se è `CONTRIBUTOR` o
  `NONE`, il webhook scarterebbe la richiesta di una persona che il permesso
  ce l'ha: va detto prima del merge.
- Da annotare: il valore esatto; se il revisore è membro dell'organizzazione,
  se la sua appartenenza è pubblica o privata.

#### T38 — GitHub: `author_association` nei commenti letti (E3)

Prerequisito: i due commenti del revisore (vedi Preparazione). Non modifica
nulla. Si leggono con il token dell'**autore**, che fa la parte dell'account
principale di Stubwise (è lui che legge i commenti nella correzione):

```bash
for P in "issues/$N/comments" "pulls/$N/comments" "pulls/$N/reviews"; do curl -sS -H "Authorization: Bearer $GH_TOKEN_AUTHOR" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$O/$R/$P?per_page=100" | jq -c --arg p "$P" '[.[] | {fonte: $p, login: .user.login, a: .author_association}]'; done
```

- Atteso: su tutte e tre le fonti ogni voce ha `a` valorizzato; quelle del
  revisore `COLLABORATOR` o `MEMBER`, quelle dell'autore `OWNER`, `MEMBER` o
  `COLLABORATOR`.
- Da annotare: il valore per ciascuna fonte e ciascun autore. **In
  particolare**: se il revisore è membro con appartenenza privata, GitHub dice
  `MEMBER` anche a questo token, o `CONTRIBUTOR`/`NONE`? Nel secondo caso i
  suoi commenti verrebbero esclusi dalla fotografia: va detto prima del merge.

#### T39 — Bitbucket PUBBLICO: un account esterno può chiedere modifiche? (E3)

**Modifica:** la repository di prova diventa pubblica per la durata del test.

1. Rendi pubblica la repository di prova (vedi Preparazione).
2. Nel browser, **con l'account esterno**, apri la PR di prova: c'è il bottone
   **Request changes**? Se sì, premilo.
3. Come amministratore: Repository settings → Webhooks → il webhook di prova →
   *View requests*: è arrivata una consegna `pullrequest:changes_request_created`
   con `actor` = l'account esterno?

- Da annotare: bottone presente sì/no; premuto con successo sì/no; consegna
  arrivata sì/no. Se tutti e tre sono **sì**, su un repository Bitbucket
  pubblico un estraneo può far partire una correzione (Stubwise non ha un
  dato per fermarlo): è il rischio scritto in «Decisioni e rischi» del piano,
  e va rivisto prima di collegare un repository Bitbucket pubblico.
- Pulizia: con l'account esterno ritira la richiesta (se è riuscita), poi
  **rimetti privata** la repository di prova.

### Casi con PR mergiata o chiusa (ultimi)

#### T34 — `APPROVE` su una PR chiusa (B14 §8b, seconda parte)

Prerequisito: `$N_CLOSED`, una PR di prova **chiusa** (se non esiste,
aprine una nuova sulla repo di prova e chiudila senza mergiare). Non modifica
nulla se il rifiuto è quello atteso.

```bash
curl -sS -o "$OUT" -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $GH_TOKEN_REV" -H 'Accept: application/vnd.github+json' -X POST "$V/$N_CLOSED/reviews" -d '{"event":"APPROVE","body":"prova su PR chiusa"}'; jq -c '{message, errors}' "$OUT"
```

- Atteso: `HTTP 422`.
- Da annotare: codice, `message` ed `errors`. **Contengono «own pull
  request»?** (non devono).

#### T35 — Verdetto su una PR Bitbucket mergiata (B14 §7d, curl)

Prerequisito: `$PR_MERGED`, una PR di prova **già mergiata** nella repo di
prova (se non esiste: crea un branch con una modifica banale, apri la PR e
mergiala — è l'unica operazione distruttiva, resta nella repo di prova). Non
modifica nulla se il rifiuto è quello atteso.

```bash
for A in approve request-changes; do curl -sS -o "$OUT" -w "POST $A -> HTTP %{http_code}\n" -u "$BB_REV_EMAIL:$BB_REV_TOKEN" -X POST "$B/$PR_MERGED/$A"; jq -c '{error}' "$OUT"; done
```

- Atteso: `HTTP 400` per entrambi (la spec lo documenta solo per
  `request-changes`).
- Da annotare: **i due codici** e `error.message`.

#### T36 — Script: `submitPrReview` Bitbucket su PR mergiata (B14 §7d, script)

```bash
node "$PROBE" bb-review BB_REV_EMAIL BB_REV_TOKEN "$PR_MERGED" approve
```

- Atteso: `ESITO: ERRORE`, `status HTTP: 400`, **`contiene il suggerimento
  sui permessi della review: no`** (B8 aggiunge il suggerimento solo su
  401/403), `CONTIENE IL TOKEN…: no`.
- Da annotare: status e le due righe di controllo.

---

## 3. Da riportare

| Test | § B14 | Cosa annotare | Risultato |
|---|---|---|---|
| T1 | §1 | codice (200/403); `uuid` del principale | |
| T2 | §1a | codice; `uuid` del revisore (diverso dal T1?) | |
| T3 | §1b | **403 o 401?**; `error.message` | |
| T4 | §1c | messaggio redatto; contiene il token sì/no | |
| T5 | §8 bis a | codice; `id` numerico sì/no | |
| T6 | §8 bis b | `id` del revisore GitHub | |
| T7 | §8 bis c (facolt.) | codice; `message` | |
| T8 | §8 bis c (facolt.) | messaggio «utente con PAT» o «rate limit»; token sì/no | |
| T9 | §2 | **201 o 400** senza `url` | |
| T10 | §2 | codice; status visibile nella PR sì/no | |
| T11 | §6c (BB) | **401 o 403** | |
| T12 | §6c (BB) | suggerimento status sì/no; token sì/no | |
| T13 | §5 | **422 o 201** a 141 caratteri; `desc_len` | |
| T14 | §6a | codice per `stubwise.example.com` e per `localhost` | |
| T15 | §6b | array finale (atteso `["success"]`) | |
| T16 | §6c (GH) | codice (atteso 403); `message` | |
| T17 | §6c (GH) | suggerimento status sì/no; token sì/no | |
| T18 | §6d | **OK o 422**; `tail` se OK | |
| T19 | §3 | codice del request-changes dell'autore | |
| T20 | §3 | codice del DELETE approve senza niente da ritirare | |
| T21 | §7a | codici dei due approve (200/200 o 200/409…) | |
| T22 | §7b prep | codici; stato finale `changes_requested` sì/no | |
| T23 | §7b | codice; stato risultante del revisore | |
| T24 | §7c | codice del DELETE request-changes; stato finale | |
| T25 | §4 | `actor.uuid` = `changes_request.user.uuid` sì/no; branch presente sì/no; chi ha premuto (terzo utente o revisore) | |
| T26 | §4 bis | tre uuid identici byte per byte sì/no | |
| T27 | §5 | codice; testo di `message`/`errors` | |
| T28 | §8c | codice (atteso 403); `message` | |
| T29 | §8c | suggerimento review sì/no; token sì/no | |
| T30 | §8b | codice; `message`/`errors`; contiene «own pull request» sì/no | |
| T31 | §8a | codice; `mergeable_state` dopo REQUEST_CHANGES | |
| T32 | §8a | codice; `mergeable_state` dopo APPROVE | |
| T33 | §8 bis b | `review.user.id` = `sender.id` = id del T6 sì/no | |
| T34 | §8b | codice; `message`/`errors`; contiene «own pull request» sì/no | |
| T35 | §7d | codici di approve e request-changes su PR mergiata | |
| T36 | §7d | status; suggerimento review sì/no (atteso no); token sì/no | |
| T37 | §9a (E3) | `review.author_association` della consegna; appartenenza pubblica/privata | |
| T38 | §9b (E3) | `author_association` per fonte e autore; membro privato → `MEMBER` sì/no | |
| T39 | §9c (E3) | Bitbucket pubblico: bottone sì/no; premuto sì/no; consegna arrivata sì/no | |
