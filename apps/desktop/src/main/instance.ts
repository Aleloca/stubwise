import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

// L'indirizzo dell'istanza Stubwise a cui parla l'app desktop (integrazione
// area 2, fetta 1): lo si sceglie al primo avvio, come nell'app mobile, e sta
// in `instance.json` nella cartella dei dati dell'app. Non è un segreto; il
// token sta a parte, cifrato (`session.ts`).

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * L'indirizzo normalizzato (senza slash finale), o `null` se non si accetta:
 * solo `https:`, o `http:` su localhost (sviluppo); niente credenziali,
 * query o frammento.
 */
export function normalizeInstanceUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const secure = url.protocol === "https:";
  const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (!secure && !local) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (raw.includes("?") || raw.includes("#")) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

const file = () => join(app.getPath("userData"), "instance.json");

export function readInstanceUrl(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as { url?: unknown };
    return normalizeInstanceUrl(parsed.url);
  } catch {
    return null;
  }
}

/** Scrive l'indirizzo; lancia se non è accettabile (`normalizeInstanceUrl`). */
export function writeInstanceUrl(url: string): string {
  const normalized = normalizeInstanceUrl(url);
  if (!normalized) throw new Error("invalid instance url");
  writeFileSync(file(), JSON.stringify({ url: normalized }));
  return normalized;
}
