# @stubwise/claude-plugin

## 0.2.0

### Minor Changes

- 861f7ef: Il server MCP si apre anche ai collaboratori non tecnici: nuovi tool `search_project_docs` e `read_doc_page` per fare domande sui Docs di un progetto, e `my_requests` per vedere le richieste aperte dall'utente. Il server ora porta le proprie istruzioni (domande sul prodotto, segnalazioni di bug e richieste di funzionalità) e la configurazione si può leggere da file, con il comando guidato `npx @stubwise/mcp setup`. La skill `stubwise` del plugin ora scatta solo per chi sviluppa in un repository collegato a Stubwise (`.stubwise.json`), non nelle conversazioni dei collaboratori.

## 0.1.1

### Patch Changes

- 59bb8e2: Skill `stubwise`: tolti i riferimenti a «Aggiorna documento» (refresh-document) e all'«analisi tecnica» nelle proposte del polso, dismessi insieme al deep dive e alla chat della voce di backlog (19 ott 2026).

## 0.1.0

### Minor Changes

- e73f04b: Plugin Claude Code «stubwise»: skill, comandi `/stubwise:*` e server MCP si installano e si aggiornano insieme dal marketplace del repository (`claude plugin marketplace add Aleloca/stubwise --sparse .claude-plugin plugins`, poi `claude plugin install stubwise@stubwise`). Il server MCP avvisa una volta per sessione, nella prima risposta di un tool, quando il plugin è più vecchio dell'ultimo rilasciato, quando gira senza plugin e quando restano copie a mano di skill o comandi in `~/.claude`. Una `${VAR}` non espansa in `STUBWISE_URL`/`STUBWISE_TOKEN` ora vale come assente.
