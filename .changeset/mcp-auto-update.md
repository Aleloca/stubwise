---
"@stubwise/mcp": minor
"@stubwise/claude-plugin": minor
---

Aggiornamento automatico del plugin e del server MCP. `npx -y @stubwise/mcp setup` accende ora l'aggiornamento automatico del marketplace `stubwise` nelle impostazioni utente di Claude Code (`autoUpdate: true` su `extraKnownMarketplaces.stubwise`, se `claude plugin marketplace add` l'ha già registrato; `--no-auto-update` salta il passo). Il plugin fissa la versione esatta di `@stubwise/mcp` che avvia (`npx -y @stubwise/mcp@<versione>`), così un aggiornamento del plugin porta con sé il server nuovo invece di una copia in cache; plugin e server escono sempre insieme, con la stessa versione. Poiché plugin e server hanno sempre la stessa versione, l'avviso «plugin vecchio» chiede al registro npm la versione `latest` di `@stubwise/mcp` (una volta per sessione, al massimo 1,5 s, in silenzio se npm non risponde) e ora dice di rifare il comando da Impostazioni → Claude Code, che accende anche l'aggiornamento automatico. `setup` riscrive `settings.json` in modo atomico, sul file vero anche se è un link.
