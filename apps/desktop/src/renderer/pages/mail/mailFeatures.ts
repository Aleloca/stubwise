import { featureIntegrated } from "../../data/integration";

// Cosa la Posta fa oltre a leggere, in questa build. Nel prototipo tutto;
// nella build app (area 6, fetta 1) leggere, le proposte della casella e
// letto/non letto. Scrivere è della F3, l'importanza e i campi modificabili
// di una proposta della F2. Nascosti, come le altre parti non integrate.
// «Salva nel Drive» su un allegato non compare da sé: vuole il progetto unico
// della conversazione, che viene dalla classificazione (F2).

/** Scrivere: nuova email, rispondi, inoltra, bozze, la bozza di Claude (F3). */
export const mailWrites = (): boolean => featureIntegrated("mail-write");

/** L'importanza e la scadenza di una conversazione, e «Importanti» (F2). */
export const mailImportance = (): boolean => featureIntegrated("mail-importance");

/** Modificare i campi di una proposta prima di confermarla (F2). */
export const mailProposalEdits = (): boolean => featureIntegrated("mail-proposal-edit");

/** Apre la conversazione su Gmail, fuori dall'app (build app). */
export function openInGmail(url: string): void {
  window.open(url, "_blank", "noopener");
}
