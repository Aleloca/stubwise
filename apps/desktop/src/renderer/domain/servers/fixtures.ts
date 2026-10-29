import type { ConversationEvent, EventDraft, ServerSshAccess, Task } from "../../data/model";
import { fakeSshPublicKey } from "../../data/seed/servers/access";
import { makeTask } from "../fixtures";

// Dati di prova condivisi dai test delle regole dei server.

export const NOW = "2026-10-29T12:00:00Z";
export const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

export const serverTask = (over: Partial<Task> = {}) =>
  makeTask({ source: "server", serverRef: { serverCode: "SRV-9", episodeId: "ep" }, ...over });

export const pair = (generation: number) => ({
  read: fakeSshPublicKey("SRV-9", "read", generation, hoursAgo(10)),
  fix: fakeSshPublicKey("SRV-9", "fix", generation, hoursAgo(10)),
});

export const access = (over: Partial<ServerSshAccess> = {}): ServerSshAccess => ({
  serverCode: "SRV-9",
  keys: pair(1),
  pending: null,
  verification: { at: hoursAgo(1), read: "ok", fix: "ok", reason: null, ofPending: false },
  keysVerification: null,
  lastUse: {},
  revokedAt: null,
  ...over,
});

/** Un accesso per ognuno dei sette stati. */
export const STATES = {
  not_linked: undefined,
  awaiting_command: access({ keys: null, pending: pair(1), verification: null }),
  verified: access(),
  verify_failed: access({
    verification: {
      at: hoursAgo(1),
      read: "ok",
      fix: "failed",
      reason: "Permission denied (publickey)",
      ofPending: false,
    },
  }),
  read_writes: access({
    verification: {
      at: hoursAgo(1),
      read: "writes",
      fix: "ok",
      reason: "sudo -n true succeeded",
      ofPending: false,
    },
  }),
  regenerating: access({ pending: pair(2) }),
  revoked: access({ keys: null, pending: null, verification: null, revokedAt: hoursAgo(1) }),
} as const;

let seq = 0;
export const ev = (e: EventDraft): ConversationEvent => ({
  id: `e${++seq}`,
  at: hoursAgo(1),
  ...e,
});
