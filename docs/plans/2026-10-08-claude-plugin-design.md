# Il plugin Claude Code «stubwise»: skill, comandi e MCP che si aggiornano da soli

Data: 8 ott 2026. Stato: approvata dal maintainer la strada (A, plugin + marketplace); il resto di questo documento è il design.

## 1. Il problema

L'integrazione con Claude Code ha tre pezzi che oggi si aggiornano in tre modi diversi:

| Pezzo | Dove sta oggi | Come si aggiorna |
|---|---|---|
| Server MCP `@stubwise/mcp` | npm, avviato con `npx -y @stubwise/mcp` da `.mcp.json` | da solo: `npx` prende l'ultima versione |
| Skill `stubwise` | `.claude/skills/stubwise/SKILL.md` nel repo, copiata a mano in `~/.claude/skills/stubwise/` | a mano, e nessuno sa quando |
| Comandi `/stubwise:init`, `/stubwise:run`, `/stubwise:start` | `.claude/commands/stubwise/*.md` nel repo | solo dentro questo repo; altrove a mano |

Ogni fase degli ultimi due mesi chiude con «ricopiare la skill sulle macchine degli altri sviluppatori» (CLAUDE.md, fasi 1, 2, 5 e correzioni post-PR). È un passo che si dimentica, e una skill vecchia è peggio di nessuna: l'ultima volta mancava la guardia che vieta di rilanciare `run_ticket` su un job fermo su una domanda.

## 2. La prova fatta prima di scrivere (8 ott 2026, Claude Code 2.1.294)

Un plugin finto (`stubwise-probe`) in un marketplace locale, installato, aggiornato e poi rimosso su questa macchina:

- **Un plugin contiene tutti e tre i pezzi.** `claude plugin details` ha riconosciuto la skill (`skills/<nome>/SKILL.md`), il comando (`commands/<nome>.md`, che compare come skill) e il server MCP (`.mcp.json` nella radice del plugin, con le `${VAR}` d'ambiente come oggi).
- **Installazione:** `claude plugin marketplace add <sorgente>` poi `claude plugin install <plugin>@<marketplace>` (scope `user` di default). Da Claude Code interattivo, lo stesso con `/plugin`.
- **Aggiornamento:** alzata la `version` in `plugin.json` e fatto un commit, **non succede niente da solo** finché non si aggiorna il marketplace: `claude plugin marketplace update <marketplace>` legge il catalogo nuovo (l'elenco mostra `folderVersion` 0.2.0 accanto all'installata 0.1.0), `claude plugin update <plugin>@<marketplace>` installa la 0.2.0 («Restart to apply changes»). Il contenuto della skill nella cache era quello nuovo.
- **Non verificato:** se e come Claude Code aggiorni un marketplace di terze parti all'avvio, senza comandi. Il file `known_marketplaces.json` non ha un campo `autoUpdate` per nessun marketplace. Va verificato dalla UI `/plugin` (Task 1 del piano) e la guida dirà solo ciò che è stato provato.

Conseguenza per il design: **non possiamo contare sull'aggiornamento automatico** finché non è provato. Serve un modo nostro per dire all'utente «c'è una versione nuova» — vedi §4.

## 3. La forma

- **Marketplace nel repo Stubwise** (pubblico): `.claude-plugin/marketplace.json` nella radice, un solo plugin `stubwise` in `plugins/stubwise/`. Installazione: `/plugin marketplace add Aleloca/stubwise` (con `--sparse .claude-plugin plugins` da CLI, per non scaricare il monorepo intero — da verificare che funzioni anche dalla UI) e `/plugin install stubwise@stubwise`.
- **Nome del plugin `stubwise`**: i comandi restano `/stubwise:init`, `/stubwise:run`, `/stubwise:start` (namespace del plugin + nome del file), quindi guida, skill e abitudini non cambiano.
- **Una sola fonte**: skill e comandi si SPOSTANO da `.claude/` del repo dentro `plugins/stubwise/` (non si copiano: due copie divergono). Gli sviluppatori di questo repo installano il plugin come tutti.
- **Il server MCP passa nel plugin** (`plugins/stubwise/.mcp.json`, stesso `npx -y @stubwise/mcp` e stesse `STUBWISE_TOKEN`/`STUBWISE_URL`). La voce `stubwise` esce dal `.mcp.json` del repo (resta `graphify`), altrimenti chi ha il plugin avrebbe due server identici.

## 4. Come l'utente sa che c'è una versione nuova

Il server MCP è l'unico pezzo sempre aggiornato (`npx -y` prende l'ultima), quindi è lui a dirlo:

- Il plugin passa la propria versione al server: `"STUBWISE_PLUGIN_VERSION": "<versione>"` nell'`env` del suo `.mcp.json`, scritta dallo stesso passo che alza la versione del plugin (§5).
- Il pacchetto `@stubwise/mcp` porta, compilata dentro, l'ultima versione del plugin rilasciata insieme a lui.
- Se la versione passata è più vecchia, la **prima risposta di un tool** nella sessione aggiunge una riga: «È disponibile una versione nuova del plugin Stubwise (x → y): esegui `/plugin marketplace update stubwise` e `/plugin update stubwise@stubwise`, poi riavvia Claude Code.» Una volta per sessione, mai un errore: il tool risponde comunque.
- **Chi non ha il plugin** (server avviato da un `.mcp.json` a mano, senza la variabile): la stessa riga dice come installare il plugin, una volta per sessione.
- **Chi ha ancora la copia a mano** della skill (`~/.claude/skills/stubwise/SKILL.md` esiste) riceve una riga che dice di cancellarla: altrimenti avrebbe due skill `stubwise` diverse.

## 5. Versioni e rilascio

- Il plugin diventa un pacchetto del workspace (privato, mai pubblicato su npm) così **Changesets** ne alza la versione come per `@stubwise/mcp`; uno script nel passo di versioning copia la versione in `plugin.json` e in `STUBWISE_PLUGIN_VERSION`, e un test fallisce se le tre divergono. Da verificare che Changesets gestisca un pacchetto privato senza pubblicarlo (`privatePackages`).
- Il rilascio è il merge della PR di versioning, come oggi: nessun passo in più per il maintainer.
- Una modifica a skill o comandi senza changeset va fermata in CI (un controllo che chiede un changeset quando cambiano file in `plugins/stubwise/`), altrimenti il contenuto cambia ma la versione no e nessuno aggiorna.

## 6. Cosa cambia per chi c'è già

- Guida utente (Integrations → Claude Code / MCP): l'installazione diventa il plugin; la vecchia (`.mcp.json` a mano + copia della skill) sparisce, con una sezione «Se usavi la configurazione manuale» (togliere la voce `stubwise` dal proprio `.mcp.json` e cancellare `~/.claude/skills/stubwise/`).
- CLAUDE.md: le voci «ricopiare la skill sulle macchine degli sviluppatori» diventano «mergiare la PR di versioning: il plugin arriva con quella». La sezione «Integrazione Claude Code (MCP)» descrive il plugin.
- Nessun deploy dell'istanza: tutto passa da GitHub e npm.

## 7. Fuori da questo lavoro

- L'aggiornamento senza comandi, se la verifica del Task 1 dice che Claude Code non lo fa per un marketplace di terze parti.
- Il plugin `stubwise-base` del worker (`apps/worker/plugins/`) è un'altra cosa (il contratto dei run sul worker) e non si tocca.
