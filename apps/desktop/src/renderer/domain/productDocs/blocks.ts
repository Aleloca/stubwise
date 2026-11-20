// Il documento a blocchi della doc di prodotto (area 11a, decisione 4): le
// operazioni sui blocchi, le ancore dei commenti e il testo per ricerca e
// chat. Dall'integrazione dell'area 11 (F1) la regola sta in
// `@stubwise/shared` (`product-docs/blocks.ts`), la stessa per il server (che
// salva) e per il client (che anticipa): qui solo la ri-esportazione.
export {
  CODE_TOKEN_RE,
  anchorIdsOf,
  anchorText,
  applyBlockOps,
  blockChanges,
  excerptOfBlocks,
  isTextBlock,
  makeBlockId,
  mergeBlocks,
  plainTextOf,
  splitBlock,
} from "@stubwise/shared";
