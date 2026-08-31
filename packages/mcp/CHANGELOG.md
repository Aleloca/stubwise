# @stubwise/mcp

## 0.4.0

### Minor Changes

- 606f4c1: Nuovo tool `run_ticket`: avvia l'esecuzione di un ticket sul worker Stubwise (run-ai). Con piano salvato esegue direttamente quel piano; per gli operatori il job attende l'approvazione del piano da parte di un maintainer. Inoltre `SERVER_VERSION` ora è letto dal package.json reale (prima dichiarava un literal disallineato).

## 0.3.0

### Minor Changes

- 5905238: Nuovo tool create_backlog_from_design: crea una voce di backlog da un design doc già completo (salva il design verbatim, stima solo i metadati), invece di sintetizzarlo come create_backlog_item. Descrizioni di create_backlog_item e set_design chiarite.

## 0.2.0

### Minor Changes

- fde81e1: Nuovi tool set_design/delete_design/set_plan/delete_plan (backlog e ticket) per salvare/rimuovere design doc e piano di implementazione; get_backlog_item/get_ticket ora espongono implementationPlan e originContent.

## 0.1.2

### Patch Changes

- d7169ae: Il server MCP rilegge `.stubwise.json` a ogni chiamata dei tool invece che solo all'avvio del processo. Così il flusso `/stubwise:init` → uso immediato risolve il progetto senza dover riavviare Claude Code (prima, se il file veniva creato dopo l'avvio del server, i tool non risolvevano il progetto e bisognava passare `project` esplicito).
