# Piano — Hub del progetto, TAPPA 2 (22 set 2026)

Design: `docs/plans/2026-09-22-project-hub-design.md`.

Perimetro (design §9.2): **di cosa è fatto il progetto** — repository,
documentazione, roadmap. Monitor e impostazioni sono la tappa 3 e **non si
iniziano qui**.

## ⚠️ Una correzione al design, prima di cominciare

Il §5 dice che documentazione e roadmap «hanno già dove atterrare (il tab DOC
e le milestone)». **È falso**, e il §2 dello stesso design — la tabella
verificata sul codice — dice il contrario: nell'app non esiste nessuna
schermata di milestone, e la documentazione ha sì un tab, ma raggiungerlo da
qui sarebbe **il salto fra tab che la tappa 1 ha appena chiuso**.

Vale quindi il §2, e la regola del §5 senza la sua eccezione sbagliata:
**tutto resta dentro lo stack Projects**. Chi legge il design dopo questo
piano lo sappia: quella frase è l'unico punto in cui si contraddice.

---

## Task 1 — I repository nel client

`packages/api-client/src/endpoints/repositories.ts` (nuovo) — `get(slug)`
verso `GET /api/repositories/:slug`.

Nessun lavoro server e **nessuno schema nuovo**: `repositorySchema` è già in
`packages/shared/src/schemas/project.ts` (verificato: id, projectId, name,
slug, provider, repoUrl, defaultBranch, gitAccountId/Name, testCommand,
installCommand, webhookConfiguredAt, graphEnabled). Manca solo il metodo.

---

## Task 2 — Sezione REPOSITORY e le sue due schermate

L'elenco sintetico è **già** in `projects.get` (`repositories: [{id, name,
slug, provider}]`): la sezione dell'hub non costa nessuna richiesta in più.

Schermate: l'elenco del progetto e il **dettaglio di un repository** — nome,
indirizzo, branch di default, account git, se il webhook è configurato, i
comandi di installazione e test, e se il grafo è attivo.

⚠️ **I file d'ambiente NON entrano** (design §8): sono segreti, e portarli su
un telefono è una decisione di prodotto a sé. I comandi di test e
installazione invece sì, in **sola lettura**: dicono cosa fa la pipeline su
quel repo e non sono segreti — è una precisazione a questo piano, non una
deviazione dal design, che su di loro taceva.

Niente modifica: il dettaglio è una lettura. Chi configura un repository lo fa
da un computer.

---

## Task 3 — Sezione DOCUMENTAZIONE e la pagina

`docs.projectSpaces(projectId)` esiste già. La sezione mostra gli spazi con il
numero di pagine; la schermata li elenca; il tap apre una pagina.

⚠️ La pagina di documentazione (`DocsStackParamList.Page`, che vuole
`repositoryId` + `slug`) vive nello stack DOC. Vale la decisione della tappa
1: **registrala anche nello stack Projects**, con lo stesso meccanismo dei
frammenti di param list già introdotto (`BacklogDetailParamList`,
`ProposalParamList`) — un frammento nuovo, una sola copia della schermata,
nessun ramo «in quale stack sto».

Per arrivare a una pagina serve l'albero dello spazio (`docs.tree`): se la
schermata dell'albero è già estraibile da `DocsScreen`, riusala; se non lo è,
**fermati e dillo** prima di scriverne una seconda.

La chat «Chiedi al progetto» **resta dov'è**, nel tab DOC: è una
conversazione, non un pezzo di anagrafica del progetto, e questa tappa non la
sposta.

---

## Task 4 — Sezione ROADMAP e l'elenco delle milestone

`projects.milestones(projectId)` esiste già e porta i conteggi
(`MilestoneWithCounts`).

Sezione: quante milestone e quante aperte. Schermata: l'elenco con nome,
scadenza e avanzamento (i conteggi ci sono già, non si ricalcolano).

**Sola lettura**: creare o chiudere una milestone resta sul web. Una milestone
la si guarda per sapere dove si è, non la si amministra dal telefono.

⚠️ Una milestone può non avere scadenza (`dueDate` nullable): l'assenza si
mostra come assenza, mai «scaduta» né una data inventata.

---

## Task 5 — Le sezioni nell'hub

Sotto le tre della tappa 1, nell'ordine del design §3: repository,
documentazione, roadmap.

⚠️ **Le chiavi di query stanno sotto i prefissi esistenti**, mai sotto un
namespace nuovo: è la lezione della tappa 1 (`ticketKeys`, e il docblock che
la spiega). Una chiave in un namespace proprio non viene invalidata da niente,
e la vista resta stantia sotto lo stack nativo senza che nessun test lo
mostri.

Ogni sezione carica per conto suo, `useQuery` non suspense, degrado
indipendente: design §4.

---

## Task 6 — Verifica

`pnpm --filter @stubwise/shared... build` prima di credere a un rosso locale;
poi typecheck, test e lint dalla radice — **il typecheck dopo l'ultimo file di
test scritto**, non prima (è il rosso che la tappa 1 ha preso dalla CI).

Il metodo nuovo del client va aggiunto al doppio **prima** del test che lo usa.

Il maintainer verifica: aprire un progetto e vedere le tre sezioni nuove coi
loro numeri; entrare in un repository e leggerne i dati; aprire una pagina di
documentazione e tornare indietro restando dentro il progetto.
