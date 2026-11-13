// L'indirizzo intero di un webhook, col segreto, nella build app esce SOLO
// dalla creazione e dalla rigenerazione (F4-1): l'elenco non ce l'ha. Qui lo
// si tiene in memoria fra la scrittura e il pannello che lo mostra; chiuso il
// pannello si dimentica, e riaperta la sorgente l'indirizzo è nascosto.

const revealed = new Map<string, string>();

export function revealAddress(sourceId: string, address: string): void {
  revealed.set(sourceId, address);
}

export function peekRevealedAddress(sourceId: string): string | undefined {
  return revealed.get(sourceId);
}

export function forgetRevealedAddress(sourceId: string): void {
  revealed.delete(sourceId);
}
