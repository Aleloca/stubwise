---
"@stubwise/shared": minor
---

Schemi delle sessioni degli agenti (elenco con filtri, dettaglio con interventi, eventi, stato ed esito derivati, interventi), nomi dei canali `NOTIFY` e `describeAgentActivity`. Le domande del dettaglio portano opzioni, `allowFreeText`, `canAnswer` e dove si risponde; gli interventi dicono se erano un «Ferma e scrivi» (`interrupt`). Esporta anche la trascrizione pura di una sessione (`buildTranscript`, `mergeEvents`, `applyPartial`, `clearPartialsFor`, `TranscriptItem`) ed `elapsedParts`, spostate dal web perché web e app ne usino una sola implementazione.
