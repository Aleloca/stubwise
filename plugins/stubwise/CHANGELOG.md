# @stubwise/claude-plugin

## 0.1.0

### Minor Changes

- e73f04b: Plugin Claude Code «stubwise»: skill, comandi `/stubwise:*` e server MCP si installano e si aggiornano insieme dal marketplace del repository (`claude plugin marketplace add Aleloca/stubwise --sparse .claude-plugin plugins`, poi `claude plugin install stubwise@stubwise`). Il server MCP avvisa una volta per sessione, nella prima risposta di un tool, quando il plugin è più vecchio dell'ultimo rilasciato, quando gira senza plugin e quando restano copie a mano di skill o comandi in `~/.claude`. Una `${VAR}` non espansa in `STUBWISE_URL`/`STUBWISE_TOKEN` ora vale come assente.
