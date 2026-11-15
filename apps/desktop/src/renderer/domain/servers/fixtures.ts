import type {
  ConversationEvent,
  EventDraft,
  ServerSshAccess,
  SshVerification,
  Task,
} from "../../data/model";
import { fakeSshPublicKey } from "../../data/seed/servers/access";
import { makeTask } from "../fixtures";

// Dati di prova condivisi dai test delle regole dei server.

export const NOW = "2026-10-29T12:00:00Z";
export const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

export const serverTask = (over: Partial<Task> = {}) =>
  makeTask({ source: "server", serverRef: { serverCode: "SRV-9", episodeId: "ep" }, ...over });

/** La chiave (pubblica) dell'unico accesso, della generazione `generation`. */
export const key = (generation: number) => fakeSshPublicKey("SRV-9", generation, hoursAgo(10));

/** Una verifica riuscita: login, niente `sudo` né `docker`, il journal col gruppo. */
export const verification = (over: Partial<SshVerification> = {}): SshVerification => ({
  at: hoursAgo(1),
  login: "ok",
  groups: ["stubwise-read", "systemd-journal"],
  sudo: false,
  docker: false,
  journal: true,
  ok: true,
  reason: null,
  ofPending: false,
  ...over,
});

export const DENIED = verification({
  login: "denied",
  groups: [],
  journal: false,
  ok: false,
  reason: "Permission denied (publickey)",
});

export const SUDO = verification({
  groups: ["stubwise-read", "sudo"],
  sudo: true,
  journal: false,
  ok: false,
  reason: "stubwise-read can run sudo.",
});

export const access = (over: Partial<ServerSshAccess> = {}): ServerSshAccess => ({
  serverCode: "SRV-9",
  key: key(1),
  pending: null,
  verification: verification(),
  keyVerification: null,
  lastUse: null,
  revokedAt: null,
  ...over,
});

/** Un accesso per ognuno dei sette stati. */
export const STATES = {
  not_linked: undefined,
  awaiting_command: access({ key: null, pending: key(1), verification: null }),
  verified: access(),
  verify_failed: access({ verification: DENIED }),
  privileged: access({ verification: SUDO }),
  revoked: access({ key: null, pending: null, verification: null, revokedAt: hoursAgo(1) }),
} as const;

let seq = 0;
export const ev = (e: EventDraft): ConversationEvent => ({
  id: `e${++seq}`,
  at: hoursAgo(1),
  ...e,
});
