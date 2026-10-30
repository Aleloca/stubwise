import type { AdminRefusal } from "../admin/types";

// I tipi delle Preferenze personali e dell'Ingresso (area 9a, Task 5): ciò
// che sta nello stato (sessioni, passkey, token, Workspace Google,
// l'ingresso) e ciò che le letture restituiscono. Nessuno contiene un
// segreto: il valore di un token, la chiave TOTP e i codici di backup stanno
// solo in `admin/secrets.ts`, e un token qui ha solo l'id del suo segreto.

/** Una sessione aperta di una persona. `current` = quella di questo dispositivo (l'app desktop). */
export interface PersonalSession {
  id: string;
  personId: string;
  /** Il dispositivo in parole: «Stubwise for macOS», «Stubwise mobile · iPhone», «Browser · Chrome on Windows». */
  device: { kind: "desktop" | "mobile" | "browser"; detail: string };
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

export interface Passkey {
  id: string;
  personId: string;
  name: string;
  addedAt: string;
  lastUsedAt: string | null;
}

/** Un token personale (PAT). Il valore no: è il segreto `secretId`, visto una volta. */
export interface PersonalToken {
  id: string;
  personId: string;
  name: string;
  createdAt: string;
  /** `null` = non scade. */
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** `null` per i token del seme, il cui valore nessuno ha più. */
  secretId: string | null;
}

/** Un'app OAuth Google Workspace dell'istanza (la registra 9b; qui si sceglie). */
export interface GoogleWorkspace {
  id: string;
  name: string;
  domains: string[];
}

/**
 * Lo stato dell'ingresso: fuori (login), a metà (password giusta, manca il
 * secondo fattore: una sessione parziale di 10 minuti, come il server) o
 * dentro. Il seme parte dentro, come Giulia.
 */
export interface EntryState {
  signedIn: boolean;
  /** Il login a metà: di chi e da quando. */
  partial: { personId: string; at: string } | null;
}

// --- le letture ---------------------------------------------------------------

export interface MyMailbox {
  /** L'indirizzo della casella: è anche il suo id (una casella per persona, come nell'area 6). */
  id: string;
  email: string;
  workspaceName: string | null;
  /** `needs_reconnect`: l'accesso è stato revocato su Google («Reconnect» sulla riga). */
  status: "connected" | "needs_reconnect";
  sync: "ok" | "syncing" | "failed";
  syncedAt: string;
  proposalsEnabled: boolean;
}

export interface MyMailboxes {
  mailboxes: MyMailbox[];
  /** I Workspace fra cui scegliere; vuoto = «Google isn't set up on this instance yet». */
  workspaces: { id: string; name: string }[];
}

/** Gli esiti di Google al collegamento, come sul web (scelti nel riquadro «Prototype only»). */
export type GoogleConnectOutcome =
  | "connected"
  | "wrong_domain"
  | "scopes_missing"
  | "owned_by_other"
  | "failed";

export type MySessionView = Omit<PersonalSession, "personId">;

export interface MySecurity {
  /** Acceso = ha l'app di autenticazione (il TOTP è obbligatorio e non si spegne). */
  on: boolean;
  totp: boolean;
  /** Da quando l'app è configurata, se il registro lo sa. */
  totpSince: string | null;
  /** `removable`: la passkey si toglie (non è l'ultimo metodo, `lastMethodBlocks`). */
  passkeys: (Omit<Passkey, "personId"> & { removable: boolean })[];
  backupCodesLeft: number;
  /** Quanti codici fa ogni giro: «7 of 10 left». */
  backupCodesTotal: number;
  sessions: MySessionView[];
  /** Il registro della sicurezza personale, ultimi 90 giorni, più recenti prima. */
  events: { id: string; kind: string; at: string; byId: string | null; byName: string | null }[];
}

export interface TokenView {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
  lastUsedAt: string | null;
}

/** I rifiuti delle Preferenze: gli stessi dell'Amministrazione (dati, mai eccezioni). */
export type MeResult<T extends object = object> = ({ ok: true } & T) | AdminRefusal;
