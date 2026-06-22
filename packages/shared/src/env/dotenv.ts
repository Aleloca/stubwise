/**
 * Parser/serializer dotenv interno e condiviso (server, worker, web).
 *
 * Scelte di design (documentate qui perché il round-trip è il requisito chiave):
 *
 *  - PARSING BEST-EFFORT: input malformato NON lancia mai. Una riga che non è
 *    interpretabile come `KEY=value` con chiave valida viene semplicemente
 *    SCARTATA (non finisce nell'output).
 *
 *  - COMMENTO INLINE: su un valore NON quotato, un `#` inizia un commento solo
 *    se è preceduto da almeno uno spazio (`KEY=value # commento` → `value`).
 *    Un `#` attaccato al valore fa parte del valore (`KEY=a#b` → `a#b`). Questo
 *    è il comportamento dotenv "standard". Dentro apici (singoli o doppi) il `#`
 *    è sempre letterale.
 *
 *  - QUOTING IN SERIALIZZAZIONE: un valore è scritto "nudo" (`KEY=value`) solo
 *    se è "semplice", cioè ri-parsabile senza ambiguità: niente spazi (che
 *    verrebbero trimmati), niente newline/CR/tab, niente apici, niente `#` (che
 *    potrebbe attivare il commento inline), e niente `=` iniziale (per restare
 *    simmetrici e leggibili). Altrimenti il valore è racchiuso in apici DOPPI e
 *    si escapano `\` → `\\`, `"` → `\"`, newline → `\n`, CR → `\r`, tab → `\t`.
 *    Gli apici doppi sono scelti come unica forma di quoting perché supportano
 *    l'espansione degli escape, garantendo un round-trip esatto.
 *
 *  - MULTILINE BEST-EFFORT: un valore tra apici doppi può estendersi su più
 *    righe fisiche; il parser continua a consumare righe finché non trova
 *    l'apice doppio di chiusura. I newline fisici diventano newline reali nel
 *    valore. (La serializzazione invece non produce mai newline fisici: li
 *    codifica come `\n`, quindi il round-trip resta su una sola riga.)
 */

/** Una variabile d'ambiente: coppia chiave/valore già decodificata. */
export interface EnvVar {
  key: string;
  value: string;
}

/** Chiave d'ambiente valida: lettera/underscore iniziale, poi alfanumerici/underscore. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True se `key` è una chiave d'ambiente sintatticamente valida. */
export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_RE.test(key);
}

/**
 * Decodifica il corpo di un valore racchiuso in apici DOPPI, già privato degli
 * apici esterni. Espande gli escape supportati (`\n`, `\r`, `\t`, `\"`, `\\`).
 * Un backslash davanti a un carattere non riconosciuto è conservato letterale.
 */
function decodeDoubleQuoted(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) {
      const next = body[i + 1];
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        default:
          // Escape non riconosciuto: conserva backslash + carattere letterali.
          out += "\\" + next;
          break;
      }
      i++; // consuma il carattere escaped
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Estrae il valore non quotato da `rest` (la parte dopo `=`, già trimmata a
 * sinistra). Gestisce il commento inline: un `#` preceduto da spazio inizia un
 * commento. Ritorna il valore con gli spazi di coda (non commento) rimossi.
 */
function parseUnquotedValue(rest: string): string {
  // Cerca un `#` preceduto da spazio/tab: è l'inizio di un commento inline.
  let commentAt = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "#" && i > 0 && (rest[i - 1] === " " || rest[i - 1] === "\t")) {
      commentAt = i;
      break;
    }
  }
  const raw = commentAt === -1 ? rest : rest.slice(0, commentAt);
  // Trim degli spazi esterni del valore non quotato.
  return raw.trim();
}

/**
 * Parsa un testo dotenv in coppie chiave/valore.
 *
 * Best-effort: righe non valide (chiave non conforme, manca `=`, ecc.) sono
 * scartate senza lanciare.
 */
export function parseDotenv(text: string): EnvVar[] {
  const out: EnvVar[] = [];
  // Normalizza i CRLF per non lasciare `\r` di coda; i newline interni ai
  // valori multiline restano comunque `\n`.
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Rimuovi spazi iniziali per individuare commenti/righe vuote/export.
    const ltrimmed = line.replace(/^[ \t]+/, "");
    if (ltrimmed === "" || ltrimmed.startsWith("#")) continue;

    // Prefisso `export ` opzionale.
    const withoutExport = ltrimmed.startsWith("export ")
      ? ltrimmed.slice("export ".length).replace(/^[ \t]+/, "")
      : ltrimmed;

    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue; // riga senza `=` → scartata

    const key = withoutExport.slice(0, eq).trim();
    if (!isValidEnvKey(key)) continue; // chiave non valida → scartata

    // `rest` = tutto dopo il primo `=`, con eventuali spazi iniziali rimossi
    // (gli spazi attorno al `=` non fanno parte del valore).
    const rest = withoutExport.slice(eq + 1).replace(/^[ \t]+/, "");

    const first = rest[0];
    if (first === '"') {
      // Valore tra apici DOPPI: può essere multiline. Consuma caratteri (e
      // righe successive) finché non si trova un `"` di chiusura non escaped.
      let body = "";
      let j = 1; // salta l'apice di apertura
      let closed = false;
      let curLine = rest;
      let lineIdx = i;
      // Loop sui caratteri della riga corrente; se finisce senza chiusura,
      // passa alla riga fisica successiva aggiungendo un `\n`.
      while (true) {
        while (j < curLine.length) {
          const ch = curLine[j];
          if (ch === "\\" && j + 1 < curLine.length) {
            // Conserva la sequenza di escape grezza per decodeDoubleQuoted.
            body += ch + (curLine[j + 1] ?? "");
            j += 2;
            continue;
          }
          if (ch === '"') {
            closed = true;
            break;
          }
          body += ch;
          j++;
        }
        if (closed) break;
        // Apice non chiuso su questa riga: prova a continuare sulla successiva.
        if (lineIdx + 1 >= lines.length) break; // best-effort: nessuna chiusura
        lineIdx++;
        body += "\n";
        curLine = lines[lineIdx] ?? "";
        j = 0;
      }
      if (closed) {
        i = lineIdx; // salta le righe consumate dal valore multiline
        out.push({ key, value: decodeDoubleQuoted(body) });
      } else {
        // Apice di apertura senza chiusura: best-effort, scarta la riga.
        continue;
      }
    } else if (first === "'") {
      // Valore tra apici SINGOLI: letterale, nessuna espansione di escape.
      const end = rest.indexOf("'", 1);
      if (end === -1) continue; // non chiuso → scarta (best-effort)
      out.push({ key, value: rest.slice(1, end) });
    } else {
      // Valore non quotato: gestisci commento inline e trim.
      out.push({ key, value: parseUnquotedValue(rest) });
    }
  }

  return out;
}

/**
 * True se il valore può essere scritto "nudo" (senza apici) e ri-parsato senza
 * ambiguità. Vedi nota QUOTING in testa al file.
 */
function isSimpleValue(value: string): boolean {
  if (value === "") return true; // `KEY=` è valido e ri-parsa a ""
  // Spazi iniziali/finali verrebbero trimmati: non semplice.
  if (value !== value.trim()) return false;
  // Caratteri che attivano quoting/escape o commenti inline.
  if (/[\s"'#\\]/.test(value)) return false;
  // Un `=` iniziale è ambiguo da leggere: forza il quoting.
  if (value.startsWith("=")) return false;
  return true;
}

/** Escapa un valore per inserirlo tra apici doppi. */
function escapeDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Serializza coppie chiave/valore in testo dotenv. Garantisce il round-trip:
 * `parseDotenv(serializeDotenv(vars))` è deep-equal a `vars` (stesso ordine).
 */
export function serializeDotenv(vars: EnvVar[]): string {
  return vars
    .map(({ key, value }) => {
      if (isSimpleValue(value)) return `${key}=${value}`;
      return `${key}="${escapeDoubleQuoted(value)}"`;
    })
    .join("\n");
}

/**
 * True SOLO se `p` è un path relativo "sicuro": non vuoto, non assoluto (né
 * POSIX `/...` né Windows `C:\...`), senza segmenti `..` o `.`, e che resta
 * dentro l'albero. Logica esplicita su `/` per evitare dipendenze e ambiguità
 * di piattaforma.
 *
 * INVARIANTE: assume input NON URL-encoded. Le sequenze percent (es. `%2e%2e`,
 * `%2f`) sono trattate come nomi di file LETTERALI, non decodificate: chi chiama
 * NON deve passare path già decodificati da URL prima della validazione,
 * altrimenti la garanzia anti-traversal va rivalutata (un `%2e%2e` decodificato
 * a posteriori diventerebbe un `..`).
 */
export function isSafeRelPath(p: string): boolean {
  if (p === "") return false;
  // Assoluto POSIX.
  if (p.startsWith("/")) return false;
  // Assoluto Windows (`C:\` o `C:/`) o backslash ovunque (li trattiamo come
  // separatori non supportati / sospetti).
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  if (p.includes("\\")) return false;

  const segments = p.split("/");
  for (const seg of segments) {
    // Segmento vuoto (doppio slash / slash di coda) o whitespace-only (nomi
    // file bizzarri, input malformato): rifiutati.
    if (seg.trim() === "") return false;
    // `.` e `..` non sono ammessi (no traversal, no rumore). `...`/`....` invece
    // sono nomi file POSIX validi e restano ammessi.
    if (seg === "." || seg === "..") return false;
  }
  return true;
}
