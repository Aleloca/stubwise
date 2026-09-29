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
const SUBJECT_LINE = /^\s*\*?(?:Oggetto|Subject)\s*:\*?\s*(.*)$/i;
const FORWARD_SUBJECT = /^(?:I|Fw|Fwd|Tr|Inoltro)\s*:/i;
// Gmail («---------- Forwarded message ---------») e Apple Mail («Begin forwarded message:», «Inizio messaggio inoltrato:»).
const FORWARD_MARKER = /forwarded message|messaggio inoltrato/i;
const SEPARATOR = /^\s*(?:_{10,}|-{5,}\s*(?:Original Message|Messaggio originale)\s*-*)\s*$/i;

/** Quante righe dopo `Da:` si cerca il resto dell'intestazione. */
const HEADER_WINDOW = 6;

export function splitQuotedReply(text: string): QuotedReplySplit {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    // Un inoltro PRIMA di qualunque intestazione di risposta: tutto ciò che
    // segue è contenuto, anche le risposte citate dentro la mail inoltrata.
    if (FORWARD_MARKER.test(line)) return { body: text, quoted: null };
    if (!FROM_LINE.test(line)) continue;

    const header = lines.slice(i + 1, i + 1 + HEADER_WINDOW);
    if (!header.some((l) => SENT_LINE.test(l))) continue;
    const subject = header.map((l) => SUBJECT_LINE.exec(l)).find((m) => m !== null);
    if (subject && FORWARD_SUBJECT.test((subject[1] ?? "").trim())) return { body: text, quoted: null };

    // La riga di separazione subito sopra (Outlook ne mette una) va con la citazione.
    let cut = i;
    let prev = cut - 1;
    while (prev >= 0 && (lines[prev] ?? "").trim() === "") prev -= 1;
    if (prev >= 0 && SEPARATOR.test(lines[prev] ?? "")) cut = prev;

    const body = lines.slice(0, cut).join("\n").trimEnd();
    // Un messaggio che è SOLO citazione resta intero: meglio un blocco lungo
    // che un messaggio vuoto con un bottone.
    if (body.trim() === "") return { body: text, quoted: null };
    return { body, quoted: lines.slice(cut).join("\n").trim() };
  }
  return { body: text, quoted: null };
}
