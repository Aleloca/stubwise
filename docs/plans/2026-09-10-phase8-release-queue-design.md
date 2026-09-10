---
title: Fase 8 — Ambienti e coda di rilascio
date: 2026-09-10
stubwise:
  project: stubwise
---

# Fase 8 — Ambienti e coda di rilascio

## 1. Cosa cambia rispetto al programma

Il programma (`2026-08-31-stubwise-nerve-center-program-design.md:216-227`)
prevedeva cinque cose. Due sono cadute, e vale la pena dire perché.

**Gli ambienti di anteprima per PR sul VPS: non si fanno.** Il worker esegue
già `install` e `test` dei repository dei clienti dentro il proprio container,
senza sandbox, come utente `worker` (`apps/worker/src/pipeline/fix.ts:175`,
`:203`, `:218`). Finché quel codice scrive solo in una directory temporanea il
danno è contenuto. Creare ambienti richiederebbe montare `/var/run/docker.sock`
nel worker — e a quel punto un `postinstall` ostile in un `package.json`
diventa **root sul VPS**, sulla stessa macchina che tiene il database di
Stubwise, le chiavi APNs del relay e i token Google delle caselle. Non è un
problema di dimensione della macchina: il perimetro di fiducia della pipeline
non è mai stato pensato per eseguire codice di terzi in modo persistente. Si
aggiungono 4,7 GB di RAM liberi per 21 repository, un Caddy senza wildcard né
TLS on-demand (`Caddyfile:113`, un sottodominio nuovo = un file in `caddy.d/` +
reload, e **nessun codice scrive lì**) e nessuna potatura su mirror e grafi.

**I livelli di autonomia con auto-merge: non si fanno** (decisione del
maintainer, 10 set 2026). Sarebbe stata l'unica delega di tutto il programma
non ancorata al contenuto di un artefatto: il gate del piano decade da sé
quando il piano cambia, perché è legato a un digest
(`apps/server/src/services/jobs.ts:155-167`); una politica per progetto no.

Al loro posto, una cosa che il programma non prevedeva e che il maintainer ha
proposto: **gli ambienti diventano un'entità di Stubwise, ma vivono altrove**.
Stubwise non li esegue e non li rilascia — li conosce.

## 2. Il punto di partenza, verificato

**Non esiste alcuna capacità di mergiare.** Le scritture cablate verso GitHub e
Bitbucket sono quattro in tutto: `openPullRequest`, `upsertPrComment`,
`ensureWebhook`, e l'header di autenticazione per il `git push`
(`packages/git/src/provider.ts:163-260`). Nessun merge, nessuna approvazione
formale. In lettura, `getPullRequestState` (`packages/git/src/github.ts:86`)
distingue solo aperta/chiusa e **non sa dire se una PR è stata mergiata**:
quel fatto arriva solo dal webhook.

Ne segue una cosa che la fase 7 aveva lasciato implicita: il secondo divieto —
«gli operatori non mandano niente in produzione» — oggi è vero **per assenza di
funzionalità**, non per un cancello. Questa fase costruisce la capacità di
rilasciare, e nel momento in cui esiste il divieto deve diventare un controllo
vero.

**L'esito dei test non è un dato.** Il fix esegue i test nel worktree e il
verde è la condizione per aprire la PR (`fix.ts:1628-1634`, `:1676-1681`), ma il
risultato finisce solo nel log del job come testo (`appendLog`, `:1653-1660`).
Non è interrogabile.

**Le PR esterne sono già analizzate.** Il webhook non filtra per origine
(`apps/server/src/routes/webhooks.ts:311-345`): l'unico cancello è
`instance_settings.pr_review_enabled`, oggi **acceso in produzione**. Una PR
aperta a mano riceve verdetto, riassunto, commento sticky e perfino un ticket di
tipo `review` (`apps/worker/src/review/run-review.ts:443`). Le manca solo il
test interno di Stubwise, che avviene solo dentro la pipeline di fix.

**L'agente di monitoraggio è già sugli host dei clienti**, con un canale **solo
in uscita** (`POST /monitor/ingest`, `GET /monitor/config`, chiave `sk_…` per
server), socket Docker montato `:ro` e usato **solo in GET**
(`Dockerfile.agent:17`, `packages/agent/src/collectors/docker.ts:55-70`),
nessuna esecuzione remota in tutto il package. E i server sono **già
associabili ai progetti** (`server_projects`, N:M, `schema.ts:1908-1927`).
Ma il collector tiene di `/containers/json` solo `Id`, `Names`, `State`
(`docker.ts:33-37`, `:162-169`): scarta `Image` e `Labels`, che quella stessa
risposta contiene già. Quindi oggi sa dire *se* un host è vivo, non *quale
versione* ci gira.

**Le variabili non sono del progetto, sono del repository.**
`project_env_files` è legata a `repositories.id` (`schema.ts:1240-1258`) — il
nome dell'indice dice `project_id` ma è un residuo storico. La chiave è
`(repository, percorso)`; nessuna nozione di ambiente.

## 3. Gli ambienti

Nuova tabella `project_environments`: progetto, nome, **tipo** (`test` |
`staging` | `production`), URL facoltativo, e il collegamento facoltativo a un
server già monitorato (`servers.id`).

Le variabili guadagnano la dimensione: la chiave di `project_env_files` diventa
`(repository, ambiente, percorso)`. **Migrazione**: ogni progetto riceve un
ambiente `test`, e tutte le righe esistenti ci finiscono dentro. Nessuna
configurazione da rifare a mano — sono 20 repository con `.env` già popolati in
produzione.

### L'invariante che protegge tutto il resto

**Solo l'ambiente `test` viene mai materializzato in un worktree.**

Non è una nota nella documentazione: `loadProjectEnvFiles`
(`apps/worker/src/pipeline/env-files.ts`) prende l'ambiente come parametro
obbligatorio e **rifiuta per costruzione** qualunque tipo diverso da `test`, con
un test che fallisce se la pipeline riesce a chiedere altro. Il motivo va
scritto nel codice: il giorno in cui una variabile di produzione entra in un
worktree, è entrata in un log, in un commit o nel prompt di un agente — e il
safeguard anti-leak esistente (`fix.ts:1441`, l'esclusione da ogni `git add`)
protegge dal commit, non dal resto.

Le variabili di `staging` e `production` esistono in Stubwise perché una
persona non tecnica possa leggerle, confrontarle e passarle a chi fa il deploy.
Non perché la pipeline le usi.

### Cosa c'è su adesso

Il collector Docker dell'agente impara a riportare `Image` e le label OCI
(`org.opencontainers.image.revision`), che Docker restituisce **nella stessa
risposta che l'agente legge già**: è una modifica al mapping, non una capacità
nuova né un permesso in più. Il socket resta `:ro` e in sole GET.

`discoveredServiceSchema` (`packages/shared/src/schemas/server.ts:55-63`)
guadagna due campi **opzionali** — invariante dell'app mobile: un agente vecchio
che non li manda non deve rompere niente, e gli host **non si auto-aggiornano**
(CLAUDE.md, sezione Deploy).

Da lì un ambiente collegato a un server sa dire «qui gira il commit `abc123`», e
la coda può dire se una modifica è già su staging.

## 4. La coda di rilascio

Una pagina sola, per il maintainer. Mostra **tutte le PR aperte** sui
repository collegati, di qualunque origine — la review le tratta già tutte allo
stesso modo (§2), e nasconderne metà renderebbe la pagina bugiarda.

Per ognuna:

| Colonna | Da dove viene |
|---|---|
| Verdetto della review | `pr_reviews.verdict`, esiste già |
| **Check del provider** | **Nuova lettura** su GitHub e Bitbucket |
| Test interno | **Nuovo dato**: l'esito del run del fix, oggi solo nel log |
| Rischio | **Nuovo campo**, calcolato da una regola (sotto) |
| Già su staging? | Dal commit riportato dall'agente (§3) |
| Riassunto | `pr_reviews.summary`, esiste già |

**I check del provider sono la colonna che conta.** Il test interno è ciò che
la pipeline ha eseguito nel proprio container prima di aprire la PR; ciò che
decide se una PR è mergiabile sono le GitHub Actions, le pipeline Bitbucket e i
ruleset. Le due cose si mostrano separate e con nomi diversi, mai fuse in un
semaforo solo.

### Il rischio è una regola, non un giudizio

- **Alto**: la PR tocca migrazioni, file d'ambiente o segreti, lockfile, o
  configurazione di CI/deploy.
- **Medio**: tocca più di un repository.
- **Basso**: tutto il resto.

Deve essere spiegabile in una riga e identico a ogni esecuzione. È la stessa
disciplina per cui il registro decisioni non è mai scritto dal modello
(CLAUDE.md): un numero di rischio generato da un'AI è narrativa travestita da
fatto, e verrebbe citato come se fosse un fatto.

### Rilasciare

`mergePullRequest` su entrambi i provider, e il permesso **verificato al
salvataggio delle credenziali**: `validateCredentials`
(`packages/git/src/github.ts:251-330`) controlla oggi push, PR e webhook, non il
merge — senza questo, lo scopriresti al primo tentativo.

**Il merge è riservato agli admin**, come approvare un piano. È il cancello che
rende vero il secondo divieto della fase 7, che finora lo era per assenza.

**Nessun auto-merge** (§1).

**Stubwise non fa deploy, mai.** Registra gli ambienti, le variabili e cosa ci
gira; il rilascio verso staging o produzione resta fuori dal prodotto. Il merge
è il confine, e va detto nella documentazione perché non lo si superi «tanto
manca poco».

### Nessun kind di notifica nuovo

Il merge fatto da Stubwise fa scattare il webhook, che chiude già il ticket e
pubblica `job.pr_closed` (`webhooks.ts:607-633`, `:679`). Non serve un kind
nuovo, e non se ne aggiungono: è la trappola documentata per le fasi 2, 5 e 6
(enum chiuso → `inboxPageSchema` fallisce → tutta `/api/inbox` a 500).

L'azione «Rilascia» sulla card d'inbox e sull'app è invece un valore nuovo in
`inboxActionTypeSchema` (`packages/shared/src/schemas/notification.ts:65-73`).
Va introdotta **dietro una lettura tollerante** (`safeParse` con degrado, come
`readGoogle` in `apps/server/src/services/inbox.ts:874-877`), verificando che un
binario precedente degradi la card invece di far saltare la rotta.

## 5. Migrazione e rollback

**Migrazione 0074**, additiva: tabella `project_environments`, colonna
`environment_id` su `project_env_files` con backfill verso l'ambiente `test` di
ogni progetto, colonne per l'esito dei test e il rischio. **Nessun `ALTER
TYPE`** — la trappola della transazione unica.

⚠️ Il backfill non è cosmetico: 20 repository hanno `.env` popolati in
produzione e la pipeline di fix li legge a ogni run. Una migrazione che li
lasciasse senza ambiente li renderebbe invisibili al fix, e i test dei fix
inizierebbero a fallire per variabili mancanti. Va scritta e provata come una
migrazione con dati, non come una colonna nuova.

**Rollback**: nessun kind di notifica nuovo (§4); le rotte nuove diventano 404 e
le colonne restano inerti. Il caddy va sceso insieme al server, come sempre.

## 6. Cosa NON entra

- **Eseguire o rilasciare ambienti** (§1). Stubwise conosce, non esegue.
- **L'auto-merge e i livelli di autonomia** (§1).
- **Comandare l'agente di monitoraggio**: il canale resta solo in uscita e il
  socket `:ro`. Nessun tipo di check «comando».
- **Le anteprime per PR**: se un giorno serviranno, vanno su una macchina
  separata e sono una fase a sé.
- **La potatura di mirror e grafi**, che crescono senza limite: è un problema
  vero ma di un'altra famiglia.
