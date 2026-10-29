# Area 9: inventario dell'amministrazione del web (29 ott 2026)

Questo file elenca tutto ciò che il web permette di amministrare e
impostare: rotte in `apps/web/src/routes/settings/*`, `team.tsx`, le
impostazioni di progetto, `monitor`, `repositories`, con i permessi presi da
`config.access` in `apps/server/src/routes`. È il perimetro di «tutto quello
che fa il sito» del design
`docs/plans/2026-10-29-desktop-area9-admin-design.md`.

In `area9-parity.md` ogni voce ha una riga, scritta dal task finale di 9a,
9b e 9c. «REAUTH» vuol dire che sul web la voce chiede la riconferma col
secondo fattore.

## A. Personale → Preferenze (9a)

| Voce | Cosa | Permesso | Stato prima dell'area 9 |
|---|---|---|---|
| Lingua | lingua dell'interfaccia | utente | menu profilo (ossatura) |
| Progetti seguiti | segui/smetti, guida le notifiche | utente | fatto (area 2, stella) |
| Cambio password | disconnette le altre sessioni | utente | assente |
| Caselle Google personali | collega, riconnetti, scollega, «Proposals» | utente | solo stato (area 6) |
| DM Slack | interruttore | utente | **fuori** (Slack sostituito, area 4) |
| Push mobile | interruttore | utente | fatto (area 8a, Telefono) |
| TOTP | QR e conferma | utente + REAUTH | assente |
| Passkey | aggiungi, rinomina, rimuovi | utente + REAUTH (non la rinomina) | assente |
| Codici di backup | quanti ne restano, rigenera | utente + REAUTH | assente |
| Registro sicurezza personale | eventi | utente | assente |
| Riconferma | dialogo di step-up, iscrizione al volo | utente | assente |
| Token (PAT) | crea (visto una volta), revoca | utente; crea + REAUTH | assente |
| Claude Code | comando d'installazione monouso, prompt | utente | assente |
| Notifiche | per progetto, tipo, canale | utente | fatto (area 8a) |
| Tema | — | utente | menu profilo |

## B. Persone e accessi → Amministrazione e Members (9a)

| Voce | Cosa | Permesso | Stato prima dell'area 9 |
|---|---|---|---|
| Elenco membri | email, ruolo, ingresso, identità | utente | assente |
| Ruolo d'istanza | Admin/User/ruolo creato a mano | `users.manage` + REAUTH, non su sé | assente |
| Reset password | link monouso | `users.manage` + REAUTH | assente |
| Reset 2FA | azzera, avvisa | `users.manage` + REAUTH | assente |
| Registro sicurezza di un membro | eventi | `users.manage` | assente |
| Identità git/Bitbucket | collega, scollega, autori osservati | `users.manage` (+ REAUTH email git) | parziale (Activity, area 3) |
| Identità Slack | — | `integrations.manage` | **fuori** (area 4) |
| Inviti: crea | email, ruolo, progetti iniziali, link | `users.invite` (+ `project.members.manage` per i progetti) | assente |
| Inviti: elenco e revoca | in sospeso, scadenza | `users.invite` | assente |
| Invita da Slack | — | — | **fuori** (area 4) |
| Registrazione su invito | schermata pubblica | pubblica | assente |
| Ruoli: elenco | preset, numero di permessi e di persone | utente (menu: `roles.manage`) | assente |
| Ruoli: crea, modifica, duplica, elimina | 11 gruppi di permessi | `roles.manage` + REAUTH | assente |
| Membri di progetto | elenca, aggiungi, ruolo, rimuovi | lettura membri; `project.members.manage` + REAUTH | assente |
| Reparti | — | — | **nuovo** (ossatura) |

## C. Istanza → Amministrazione (9b)

| Voce | Cosa | Permesso | Stato prima dell'area 9 |
|---|---|---|---|
| Automazione AI | auto-fix, soglie, costo massimo, PR review | `settings.manage` | assente |
| Modelli per operazione | modello per ogni operazione | `settings.manage` | assente |
| Provider AI | catena di riserva, crea, riordina, prova, quota | `ai_providers.manage` | assente |
| Budget mensile e lingua dei contenuti | — | `settings.manage` | assente |
| Consumi | costi, token, run; per giorno/modello/progetto/provider | `usage.view` / `project.usage.view` | parziale (per task, area 3) |
| Account git | crea, valida, elimina, revisore predefinito | `git_accounts.manage` (lettura `.view`) | assente |
| Plugin | registra, aggiorna, smoke, rimuovi, inventario | `plugins.manage` | assente |
| Google Workspace | app OAuth | `integrations.manage` | assente |
| Posta ammessa | — | `settings.manage` | **fuori** (area 6) |
| Slack | — | `settings.manage` | **fuori** (area 4) |
| Webhook in uscita | formato, URL, eventi, prova | `settings.manage` | rimandato all'area 9 (aree 4, 7, 8) |
| Archiviazione | S3, allegati | `settings.manage` | assente |
| Setup iniziale | primo admin | pubblica (istanza vuota) | assente |
| Sorgenti e webhook in arrivo | — | `integrations.manage` | fatto (area 7) |

## D. Progetto → Progetto → Settings (9c)

| Voce | Cosa | Permesso | Stato prima dell'area 9 |
|---|---|---|---|
| Creare un progetto | — | `projects.create` | fatto (area 2) |
| Nome e descrizione | — | `project.settings.manage` | assente |
| Account AI preferito | Automatico o un account, «solo questo» | `project.settings.manage` | assente |
| Interruttori | Docs notturni, report, backlog discovery, pulse, brief | `project.settings.manage` | assente |
| Correzioni massime sulle PR | 0 = spento | `project.settings.manage` | solo nel modello (8a) |
| Stati e soglia «ferma» | — | — | fatto (area 2) |
| Repository: creazione guidata | 4 passi | `repos.manage` | assente |
| Repository: modifica e webhook | campi, rami protetti, configura webhook | `repos.manage` | parziale (modo per repository, 8a) |
| File d'ambiente | per ambiente, a sola scrittura | `repos.manage` | assente |
| Membri | vedi B | — | rimandato all'area 9 (8b) |
| Integrazione | chiave d'ingestione, DSN, snippet, webhook in arrivo e git, guida SDK | visibile ai membri | assente |
| Widget e conversazioni | — | `widget.manage` | fatto (area 8a) |
| Regole della posta del progetto | — | `project.settings.manage` | **fuori** (area 6) |
| Server del progetto, ambienti | — | — | fatto (aree 8a, 8b) |
| Plugin del progetto | per sottrazione, preset consigliato | `project.settings.manage` | assente |
| Traguardi | — | — | fatto (area 2) |
| Rigenera il brief | — | — | **fuori** (aree 2, 3) |
| Elimina il progetto | a cascata | `project.settings.manage` | assente (diventa archivia + elimina) |
| Consumi del progetto | — | `project.usage.view` | assente |

## E. Server e repository d'istanza → Amministrazione (9b)

| Voce | Cosa | Permesso | Stato prima dell'area 9 |
|---|---|---|---|
| Tutti i server | stato, CPU, servizi, versione; nuovo server | `monitor.manage` | rimandato all'area 9 (8b) |
| Dettaglio server, grafici 30d e 90d | — | `monitor.manage` | fatto fino a 7d (8b) |
| Tutti i repository | per progetto | `repos.manage` | assente |
| Accessi SSH | — | `servers.ssh.manage` | fatto (8b, nuovo) |
