# @stubwise/claude-plugin

## 0.10.0

### Minor Changes

- a48662e: Aggiornamento automatico del plugin e del server MCP. `npx -y @stubwise/mcp setup` accende ora l'aggiornamento automatico del marketplace `stubwise` nelle impostazioni utente di Claude Code (`autoUpdate: true` su `extraKnownMarketplaces.stubwise`, se `claude plugin marketplace add` l'ha già registrato; `--no-auto-update` salta il passo). Il plugin fissa la versione esatta di `@stubwise/mcp` che avvia (`npx -y @stubwise/mcp@<versione>`), così un aggiornamento del plugin porta con sé il server nuovo invece di una copia in cache; plugin e server escono sempre insieme, con la stessa versione. Poiché plugin e server hanno sempre la stessa versione, l'avviso «plugin vecchio» chiede al registro npm la versione `latest` di `@stubwise/mcp` (una volta per sessione, al massimo 1,5 s, in silenzio se npm non risponde) e ora dice di rifare il comando da Impostazioni → Claude Code, che accende anche l'aggiornamento automatico. `setup` riscrive `settings.json` in modo atomico, sul file vero anche se è un link.

## 0.2.0

### Minor Changes

- 861f7ef: Il server MCP si apre anche ai collaboratori non tecnici: nuovi tool `search_project_docs` e `read_doc_page` per fare domande sui Docs di un progetto, e `my_requests` per vedere le richieste aperte dall'utente. Il server ora porta le proprie istruzioni (domande sul prodotto, segnalazioni di bug e richieste di funzionalità) e la configurazione si può leggere da file, con il comando guidato `npx @stubwise/mcp setup`. La skill `stubwise` del plugin ora scatta solo per chi sviluppa in un repository collegato a Stubwise (`.stubwise.json`), non nelle conversazioni dei collaboratori.

## 0.1.1

### Patch Changes

- 59bb8e2: Skill `stubwise`: tolti i riferimenti a «Aggiorna documento» (refresh-document) e all'«analisi tecnica» nelle proposte del polso, dismessi insieme al deep dive e alla chat della voce di backlog (19 ott 2026).

## 0.1.0

### Minor Changes

- e73f04b: Plugin Claude Code «stubwise»: skill, comandi `/stubwise:*` e server MCP si installano e si aggiornano insieme dal marketplace del repository (`claude plugin marketplace add Aleloca/stubwise --sparse .claude-plugin plugins`, poi `claude plugin install stubwise@stubwise`). Il server MCP avvisa una volta per sessione, nella prima risposta di un tool, quando il plugin è più vecchio dell'ultimo rilasciato, quando gira senza plugin e quando restano copie a mano di skill o comandi in `~/.claude`. Una `${VAR}` non espansa in `STUBWISE_URL`/`STUBWISE_TOKEN` ora vale come assente.
