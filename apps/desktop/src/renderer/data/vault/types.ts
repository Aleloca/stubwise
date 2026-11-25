// La Cassaforte delle credenziali nel prototipo (lotto 10, shape
// `apps/desktop/.impeccable/shape/vault.md`, decisioni del maintainer del
// 24–25 nov 2026; invarianti `docs/invariants/vault.md`).
//
// Nel prototipo niente è cifrato: la password sta in chiaro nello stato,
// e «chi la legge» lo dicono le stesse regole del server (lettori diretti,
// ruoli, full admin, chi l'ha creata) più la propria chiave CONFERMATA con
// la sua copia. La chiave del Mac (associazione, Touch ID, sigillo) è
// finta: la simula `thisMac`, la stessa forma che nell'app dà il main.

/** Una credenziale del progetto. `password` esiste solo nel prototipo. */
export interface Credential {
  id: string;
  projectId: string;
  service: string;
  label: string | null;
  url: string | null;
  username: string | null;
  /** In chiaro anche sul server: mai segreti (lo dice il modulo). */
  notes: string | null;
  password: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

/** Un lettore diretto: una persona O un ruolo di progetto. */
export interface CredentialReaderRef {
  id: string;
  credentialId: string;
  personId: string | null;
  roleId: string | null;
  addedById: string;
  addedAt: string;
}

/** La chiave di persona della cassaforte (la crea il browser con la passkey). */
export interface VaultKey {
  personId: string;
  status: "pending" | "confirmed";
  createdAt: string;
  /** Dove l'ha creata («Chrome on macOS»). */
  device: string | null;
  /** L'impronta della pubblica: quattro gruppi di cifre esadecimali. */
  fingerprint: string;
  /** Le credenziali di cui ha la copia della chiave. */
  copies: string[];
}

/** Un Mac associato alla cassaforte di una persona (un sigillo vivo). */
export interface VaultMac {
  id: string;
  personId: string;
  name: string;
  pairedAt: string;
  lastUsedAt: string | null;
  /** L'impronta della chiave del dispositivo. */
  fingerprint: string;
}

/** Una riga del registro: chi ha mostrato o copiato una password, da dove. */
export interface CredentialAccessEntry {
  id: string;
  credentialId: string;
  projectId: string;
  /** Il servizio com'era: la riga resta se la credenziale sparisce. */
  service: string;
  personId: string;
  action: "shown" | "copied";
  via: "mac" | "browser";
  at: string;
}

/** Il Mac del prototipo per chi guarda: quello che nell'app sa il main. */
export interface ThisMac {
  /** Il Mac associato di chi guarda; null = da associare. */
  macId: string | null;
  open: boolean;
  /** Appena associato: la prossima apertura è senza tocco (D-1b). */
  freshlyPaired: boolean;
  /** Il sigillo tolto dal server (D-5): il login resta. */
  revoked: boolean;
  /** L'associazione in corso nel browser, con l'impronta da confrontare. */
  pairing: { fingerprint: string; until: string } | null;
  /** L'ultima apertura non ha raggiunto Stubwise (la barra lo dice finché non si riprova). */
  unreachable: boolean;
}

/** Cosa succede la prossima volta (riquadro «Prototype only»). */
export interface VaultSimulation {
  touchId: "works" | "cancelled" | "unavailable";
  opening: "works" | "revoked" | "unreachable";
}

export interface VaultState {
  active: boolean;
  credentials: Credential[];
  readers: CredentialReaderRef[];
  keys: VaultKey[];
  macs: VaultMac[];
  log: CredentialAccessEntry[];
  thisMac: Map<string, ThisMac>;
  simulation: VaultSimulation;
}

// --- le viste (le stesse nelle due build) -----------------------------------------

/** Lo stato della barra della cassaforte. */
export type VaultBarState =
  | "inactive"
  | "no_key"
  | "key_pending"
  | "unpaired"
  | "locked"
  | "open"
  | "revoked"
  | "unreachable"
  /** L'istanza ha la cassaforte dal desktop spenta (`VAULT_DESKTOP`): solo dal browser. Solo nell'app. */
  | "disabled"
  /** Un build o un Mac senza Secure Enclave: solo dal browser. Solo nell'app. */
  | "unsupported";

export interface VaultStatusView {
  state: VaultBarState;
  /** Il Mac ha Touch ID (D-1a: senza, si apre dal browser). */
  touchId: boolean;
  /** L'impronta della chiave del Mac (associato). */
  macFingerprint: string | null;
  /** L'impronta della propria chiave di persona (in attesa: da far confrontare). */
  ownFingerprint: string | null;
  /** C'è un'associazione in corso: il dialogo la mostra. */
  pairing: { fingerprint: string; until: string } | null;
}

/** Una credenziale come la vede chi guarda: mai la password. */
export interface CredentialView {
  id: string;
  projectId: string;
  service: string;
  label: string | null;
  url: string | null;
  username: string | null;
  notes: string | null;
  /** `reads`: la apre; `waiting`: la sua chiave aspetta una copia; `manages`: la gestisce senza leggerla. */
  access: "reads" | "waiting" | "manages";
  canEdit: boolean;
  canShare: boolean;
  updatedAt: string;
}

export interface ReadersView {
  direct: {
    readerId: string;
    kind: "person" | "role";
    id: string;
    name: string;
    addedAt: string;
  }[];
  effective: {
    personId: string;
    name: string;
    source: "full_admin" | "created" | "direct" | "role";
    roleName: string | null;
    state: "reads" | "no_key" | "key_pending" | "waiting_copy";
  }[];
  canShare: boolean;
}

export interface PendingPersonView {
  /** L'id della chiave da confermare (nell'app, `personKey.id`). */
  keyId: string;
  personId: string;
  name: string;
  email: string;
  createdAt: string;
  device: string | null;
  fingerprint: string;
  credentials: { id: string; service: string; projectId: string }[];
}

export interface MacView {
  id: string;
  name: string;
  pairedAt: string;
  lastUsedAt: string | null;
  fingerprint: string;
  current: boolean;
}

export interface AccessLogView {
  id: string;
  at: string;
  personId: string;
  name: string;
  credentialId: string;
  service: string;
  action: "shown" | "copied";
  via: "mac" | "browser";
}

export type VaultFailure = { ok: false; code: string };
export type ReaderTarget = { personId: string } | { roleId: string };
