import { emptyStore, gate } from "../store";

// SOLO PROTOTIPO, «Reset to empty instance» nel riquadro «Prototype only» del
// profilo (area 9a): l'istanza come appena installata, per provare il primo
// avvio. Resta solo Claude, ogni tabella è vuota e si è fuori; il primo
// avvio crea il primo full admin. «Reset prototype» (`resetApi`) riporta al
// seme. Nessun permesso: è un comando del prototipo, non del prodotto.

export async function resetToEmptyInstance(): Promise<{ ok: true }> {
  await gate("auth.resetToEmptyInstance");
  emptyStore();
  return { ok: true };
}
