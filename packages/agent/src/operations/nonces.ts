import { readFileSync, writeFileSync } from "node:fs";
import type { NonceStore } from "./verify.js";

/**
 * The nonces the agent has spent, persisted to a file so a restarted agent
 * still refuses a replay; entries are pruned once their command has expired
 * (an expired command is refused anyway).
 */
export function fileNonceStore(path: string, now: () => Date = () => new Date()): NonceStore {
  let seen: Record<string, string> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (raw && typeof raw === "object") seen = raw as Record<string, string>;
  } catch {
    seen = {};
  }
  const prune = () => {
    const t = now().getTime();
    for (const [id, exp] of Object.entries(seen)) if (Date.parse(exp) <= t) delete seen[id];
  };
  return {
    has: (id) => Object.prototype.hasOwnProperty.call(seen, id),
    add: (id, expiresAt) => {
      prune();
      seen[id] = expiresAt;
      try {
        writeFileSync(path, JSON.stringify(seen));
      } catch {
        // Not persisted: still refused for the life of this process.
      }
    },
  };
}
