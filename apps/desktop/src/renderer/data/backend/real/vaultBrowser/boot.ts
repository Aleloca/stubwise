// `@backend/vault-boot` nella build web: il PRIMO import di `main.tsx`
// (design della cassaforte nel browser §2.4, revisione I-1). Cattura le
// primitive, avvia il worker della cassaforte e collega SUBITO i segnali
// della scheda (attività, ritorno, `pagehide`, il canale fra le schede):
// niente di pigro che uno script arrivato dopo possa intercettare.
import { harden } from "./primitives";
import { startVaultWorker } from "./client";
import { wireVault } from "./key";

// I-A: i prototipi della cerimonia non si toccano più dopo di qui.
harden();
startVaultWorker();
wireVault();
