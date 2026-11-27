import { isIP } from "node:net";

// Le immagini delle email passano dal nostro server (design
// `docs/plans/2026-11-28-proxy-immagini-posta-design.md`, §3): gli URL e gli
// indirizzi che il proxy non chiede MAI. Funzioni pure, testate in
// `address.test.ts`. La risoluzione DNS e la connessione stanno in `fetch.ts`,
// che passa di qui ogni indirizzo e ogni salto di redirect.

/** Un intervallo IPv4 come [base, bit del prefisso]. */
const V4_BLOCKED: readonly [string, number][] = [
  ["0.0.0.0", 8], // «questa rete»
  ["10.0.0.0", 8], // privati
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, compreso il metadata 169.254.169.254
  ["172.16.0.0", 12], // privati
  ["192.0.0.0", 24], // assegnazioni IETF
  ["192.0.2.0", 24], // documentazione
  ["192.168.0.0", 16], // privati
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // documentazione
  ["203.0.113.0", 24], // documentazione
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // riservati, broadcast compreso
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = v4ToInt(base);
    return n >= start && n < start + size;
  });
}

/** Le 8 parole di 16 bit di un IPv6 (anche con `::` e un IPv4 in coda), o null. */
function v6Words(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // Un IPv4 in coda (`::ffff:1.2.3.4`) diventa due parole.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const n = v4ToInt(dotted[1]!);
    text = `${text.slice(0, dotted.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((w) => parseInt(w, 16)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const words = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

const wordsToV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

function v6Blocked(ip: string): boolean {
  const w = v6Words(ip);
  if (!w) return true;
  const first = w[0]!;
  // `::` e `::1`.
  if (w.slice(0, 7).every((x) => x === 0) && (w[7] === 0 || w[7] === 1)) return true;
  // IPv4 mappato (`::ffff:a.b.c.d`) e NAT64 (`64:ff9b::a.b.c.d`): si guarda l'IPv4 dentro.
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return v4Blocked(wordsToV4(w[6]!, w[7]!));
  if (first === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return v4Blocked(wordsToV4(w[6]!, w[7]!));
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7, compreso fd00:ec2::254
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8
  if (first === 0x2001 && w[1] === 0x0db8) return true; // 2001:db8::/32
  return false;
}

/**
 * Un indirizzo che il proxy non raggiunge mai: privati, loopback,
 * link-local e metadata, CGNAT, multicast, documentazione, riservati; per
 * gli IPv6 mappati e NAT64, l'IPv4 che contengono. Tutto ciò che non è un IP
 * leggibile è vietato: un errore non diventa mai un'ammissione.
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) return v6Blocked(ip);
  return true;
}

/** I nomi che non sono mai Internet, anche se un DNS li risolvesse. */
const BLOCKED_NAME = /(^|\.)(localhost|local|internal)$/;

export type ImageUrlCheck =
  | {
      ok: true;
      url: URL;
      /** L'host normalizzato (minuscolo, IDN in punycode, senza il punto finale). */
      host: string;
      /** Un IP letterale già controllato (a cui connettersi senza DNS), o null per un nome. */
      literal: string | null;
    }
  | { ok: false; reason: "invalid" | "scheme" | "port" | "credentials" | "host" | "address" };

/**
 * Il controllo di un URL PRIMA di ogni richiesta (anche dopo ogni redirect):
 * solo `https:` sulla 443, nessuna credenziale, host normalizzato dal
 * parser WHATWG. Il parser riscrive gli IPv4 in decimale, ottale ed
 * esadecimale (`2130706433`, `0177.0.0.1`, `0x7f.1`) e gli IPv6 fra
 * parentesi nella forma canonica, quindi il controllo vede l'indirizzo vero.
 */
export function checkImageUrl(raw: string): ImageUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.port !== "" && url.port !== "443") return { ok: false, reason: "port" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return { ok: false, reason: "invalid" };
  if (host.startsWith("[") && host.endsWith("]")) {
    const ip = host.slice(1, -1);
    return isBlockedAddress(ip) ? { ok: false, reason: "address" } : { ok: true, url, host, literal: ip };
  }
  if (isIP(host) === 4) return isBlockedAddress(host) ? { ok: false, reason: "address" } : { ok: true, url, host, literal: host };
  if (BLOCKED_NAME.test(host)) return { ok: false, reason: "host" };
  return { ok: true, url, host, literal: null };
}
