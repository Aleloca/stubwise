/**
 * Separa, nel corpo di un messaggio mostrato DENTRO una conversazione, il
 * testo del messaggio dalla catena citata in stile Outlook (29 set 2026).
 *
 * L'estratto (`text_excerpt`) toglie già la citazione quando si apre con
 * «On … wrote:» / «Il … ha scritto:» (`stripQuotedAndSignature`,
 * `packages/google/src/gmail.ts`), ma Outlook non scrive quella riga: apre la
 * citazione con un blocco d'intestazione —
 *
 *     ________________________________
 *     Da: Ufficio IT <it@farmakom.it>
 *     Inviato: martedì 28 luglio 2026 12:11
 *     A: RD Panestetic <RD@panestetic.it>
 *     Oggetto: Re: APP 4.0 gestione trattamenti
 *
 * — e da lì in giù arriva tutta la conversazione precedente, che nella vista
 * per conversazione è già sotto, messaggio per messaggio. In produzione, al
 * 29 set 2026, 16 messaggi su 278.
 *
 * Esiste una SECONDA forma, da una webmail che mette l'intestazione in una
 * tabella: le celle arrivano come righe SENZA i due punti —
 *
 *     Da "Leonardo Locatelli" l.locatelli@farmakom.it
 *     A s.trimboli@rotopubblicita.com
 *     Cc it@farmakom.it
 *     Data Tue, 29 Sep 2026 12:21:16 +0200
 *     Oggetto Re: Integrazione software
 *
 * Senza due punti «Da …» è anche una frase qualunque («Da lunedì siamo
 * operativi»), quindi qui la regola è più stretta: servono `A`, `Data` e
 * `Oggetto`, tutte senza due punti, nelle righe subito sotto.
 *
 * ⚠️ **È una regola di LETTURA, non di ingestione.** L'estratto resta com'è:
 * è ciò che la classificazione ha letto, e non si riscrive (CLAUDE.md, «Il
 * corpo HTML di un'email»). Per questo vale anche sulle righe già in
 * database, senza toccarle; e per questo NON si usa dove si mostra «cosa ha
 * letto il modello» (il dettaglio di una proposta), ma solo nella
 * conversazione.
 *
 * ⚠️ **Un INOLTRO non si taglia**: il testo sotto l'intestazione è il
 * contenuto vero, e la mail inoltrata non sta nel thread. Si riconosce in due
 * modi — la riga «Forwarded message» / «Messaggio inoltrato», o un
 * blocco Outlook il cui oggetto comincia con `I:`/`Fw:`/`Fwd:`/`Tr:`. E un
 * blocco `Da:` seguito da `Date:` (non `Inviato:`/`Sent:`) è la forma di
 * Gmail, che è sempre un inoltro: la regola chiede `Inviato:`/`Sent:` apposta.
 *
 * Il chiamante non cancella mai `quoted`: lo comprime dietro un «Mostra
 * testo citato». Se la regola sbaglia su una mail strana, non si perde
 * niente.
 */

/** Il corpo diviso: `quoted` è `null` quando non c'è niente da comprimere. */
export interface QuotedReplySplit {
  body: string;
  quoted: string | null;
}

const FROM_LINE = /^\s*\*?(?:Da|From)\s*:\*?(?:\s|$)/i;
const SENT_LINE = /^\s*\*?(?:Inviato|Sent)\s*:/i;
/** Le righe della forma a tabella: etichetta, spazio, valore — nessun due punti. */
const TABLE_FROM_LINE = /^\s*(?:Da|From)\s+[^:\s]/;
const TABLE_TO_LINE = /^\s*(?:A|To)\s+[^:\s]/;
const TABLE_DATE_LINE = /^\s*(?:Data|Date)\s+[^:\s]/;
const TABLE_SUBJECT_LINE = /^\s*(?:Oggetto|Subject)(?:\s|$)/;
const SUBJECT_LINE = /^\s*\*?(?:Oggetto|Subject)\s*:?\*?\s*(.*)$/i;
const FORWARD_SUBJECT = /^(?:I|Fw|Fwd|Tr|Inoltro)\s*:/i;
// Gmail («---------- Forwarded message ---------») e Apple Mail («Begin forwarded message:», «Inizio messaggio inoltrato:»).
const FORWARD_MARKER = /forwarded message|messaggio inoltrato/i;
const SEPARATOR = /^\s*(?:_{10,}|-{5,}\s*(?:Original Message|Messaggio originale)\s*-*)\s*$/i;

/**
 * Quante righe dopo `Da` si cerca il resto dell'intestazione: la forma a
 * tabella lascia una riga vuota fra una cella e l'altra.
 */
const HEADER_WINDOW = 10;

function isOutlookHeader(line: string, header: string[]): boolean {
  return FROM_LINE.test(line) && header.some((l) => SENT_LINE.test(l));
}

function isTableHeader(line: string, header: string[]): boolean {
  return (
    TABLE_FROM_LINE.test(line) &&
    header.some((l) => TABLE_TO_LINE.test(l)) &&
    header.some((l) => TABLE_DATE_LINE.test(l)) &&
    header.some((l) => TABLE_SUBJECT_LINE.test(l))
  );
}

export function splitQuotedReply(text: string): QuotedReplySplit {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    // Un inoltro PRIMA di qualunque intestazione di risposta: tutto ciò che
    // segue è contenuto, anche le risposte citate dentro la mail inoltrata.
    if (FORWARD_MARKER.test(line)) return { body: text, quoted: null };
    const header = lines.slice(i + 1, i + 1 + HEADER_WINDOW);
    if (!isOutlookHeader(line, header) && !isTableHeader(line, header)) continue;
    const subject = header.map((l) => SUBJECT_LINE.exec(l)).find((m) => m !== null);
    if (subject && FORWARD_SUBJECT.test((subject[1] ?? "").trim())) return { body: text, quoted: null };

    // La riga di separazione subito sopra (Outlook ne mette una) va con la citazione.
    let cut = i;
    let prev = cut - 1;
    while (prev >= 0 && (lines[prev] ?? "").trim() === "") prev -= 1;
    if (prev >= 0 && SEPARATOR.test(lines[prev] ?? "")) cut = prev;

    // `trimEnd` non toglie gli spazi a larghezza zero che certe firme lasciano in fondo.
    const body = lines.slice(0, cut).join("\n").replace(/[\s\u200b]+$/, "");
    // Un messaggio che è SOLO citazione resta intero: meglio un blocco lungo
    // che un messaggio vuoto con un bottone.
    if (body.trim() === "") return { body: text, quoted: null };
    return { body, quoted: lines.slice(cut).join("\n").trim() };
  }
  return { body: text, quoted: null };
}
