# @stubwise/mcp

## 0.1.2

### Patch Changes

- d7169ae: Il server MCP rilegge `.stubwise.json` a ogni chiamata dei tool invece che solo all'avvio del processo. Così il flusso `/stubwise:init` → uso immediato risolve il progetto senza dover riavviare Claude Code (prima, se il file veniva creato dopo l'avvio del server, i tool non risolvevano il progetto e bisognava passare `project` esplicito).
