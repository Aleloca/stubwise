import type { Mailbox } from "../../types";
import { at, person } from "./helpers";

// Le caselle: una per account Google (area 5). Giulia aggiornata da due
// minuti; Matteo da dodici, quindi segnata come vecchia (oltre 5 minuti);
// Laura col collegamento scaduto, ferma al giorno della scadenza e con le
// proposte spente (la sua posta non va al modello). Marco, Sara e Roberta
// non hanno l'account, quindi niente casella.
export const MAILBOXES: Mailbox[] = [
  {
    personId: "p-giulia",
    email: person("p-giulia").email,
    proposalsEnabled: true,
    syncedAt: at(0, "11:58"),
    sync: "ok",
  },
  {
    personId: "p-matteo",
    email: person("p-matteo").email,
    proposalsEnabled: true,
    syncedAt: at(0, "11:48"),
    sync: "ok",
  },
  {
    personId: "p-laura",
    email: person("p-laura").email,
    proposalsEnabled: false,
    // Lo stesso momento in cui è scaduto l'account.
    syncedAt: at(5, "08:00"),
    sync: "failed",
  },
];
