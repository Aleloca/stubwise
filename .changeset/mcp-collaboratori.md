---
"@stubwise/mcp": minor
"@stubwise/claude-plugin": minor
---

Il server MCP si apre anche ai collaboratori non tecnici: nuovi tool `search_project_docs` e `read_doc_page` per fare domande sui Docs di un progetto, e `my_requests` per vedere le richieste aperte dall'utente. Il server ora porta le proprie istruzioni (domande sul prodotto, segnalazioni di bug e richieste di funzionalità) e la configurazione si può leggere da file, con il comando guidato `npx @stubwise/mcp setup`. La skill `stubwise` del plugin ora scatta solo per chi sviluppa in un repository collegato a Stubwise (`.stubwise.json`), non nelle conversazioni dei collaboratori.
