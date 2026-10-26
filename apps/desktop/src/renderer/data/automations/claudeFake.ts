import type { EngineInput } from "../../domain/automations/engine";
import { AUTOMATION_LIMITS } from "../../domain/automations/fields";
import { show } from "../../domain/automations/preview";
import { fold } from "../../domain/textSearch";
import type { Step } from "../types";

// Claude finto delle automazioni (area 7): risposte deterministiche per
// istruzione e input. Lo chiama `effects.ts`, l'unico esecutore; la
// verifica col dichiarato la fa sempre il motore (`checkClaudeResult`).

type ClaudeStep = Extract<Step, { kind: "claude" }>;

/** Che cosa fa il reparto per ogni prodotto venduto (il contratto «letto» da Claude). */
const PRODUCT_TASKS: Record<string, [titolo: string, reparto: string][]> = {
  CRM: [
    ["Importare l'anagrafica clienti nel CRM", "Development"],
    ["Pianificare le sessioni di formazione sul CRM", "Sales"],
  ],
  "Centralino AI": [["Configurare il Centralino AI", "Support"]],
  "Campagne WhatsApp": [
    ["Verificare il numero WhatsApp Business", "Support"],
    ["Preparare i modelli dei messaggi", "Sales"],
  ],
  "Preventivi online": [["Caricare il catalogo dal listino", "Development"]],
};

const STOP = new Set([
  "della",
  "delle",
  "degli",
  "dello",
  "alla",
  "alle",
  "agli",
  "con",
  "per",
  "testo",
]);

/** Le cose chieste in un elenco libero («A, B e C»), ognuna con la sua parola chiave. */
function requested(text: string): { item: string; key: string }[] {
  return text
    .replace(/\.$/, "")
    .split(/,|\se\s/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const words = fold(item)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3 && !STOP.has(w));
      // La radice della parola più lunga: «apertura» si ritrova in «aperti».
      const word = words.sort((x, y) => y.length - x.length)[0] ?? fold(item);
      return { item, key: word.slice(0, 5) };
    });
}

/**
 * La risposta finta di Claude, deterministica per istruzione e input: le
 * uscite e i campi dichiarati dal passo, col loro tipo. La verifica col
 * dichiarato la fa comunque il motore (`checkClaudeResult`): qui si finge
 * solo la lettura.
 */
export function fakeClaude(
  step: ClaudeStep,
  input: Record<string, unknown>,
  ownerId: string | null,
): Extract<EngineInput, { kind: "claude_result" }> {
  const values = Object.entries(input);
  const reply = values.find(([k]) => k.startsWith("risposta."))?.[1];
  const askedFor = values.find(
    ([k, v]) => !k.startsWith("risposta.") && typeof v === "string",
  )?.[1];
  const missing =
    typeof askedFor === "string"
      ? requested(askedFor).filter(({ key }) => !fold(show(reply)).includes(key))
      : [];
  const allText = fold(values.map(([, v]) => JSON.stringify(v ?? "")).join(" "));
  const products = values
    .map(([, v]) => v)
    .find((v): v is { nome: string }[] => Array.isArray(v) && v.some((x) => typeof x === "object"));
  const contract = values.map(([, v]) => v).find((v) => show((v as { testo?: unknown })?.testo));

  let outcome: string | undefined;
  if (step.outcomes.length > 0) {
    if (reply !== undefined) {
      outcome = missing.length === 0 ? step.outcomes[0] : step.outcomes.at(-1);
    } else {
      outcome =
        step.outcomes.find((o) => allText.includes(fold(o))) ??
        (/(errore|non funziona|si blocca|crash)/.test(allText) && step.outcomes.includes("bug")
          ? "bug"
          : step.outcomes.at(-1));
    }
  }

  const fields: Record<string, unknown> = {};
  for (const f of step.fields) {
    if (f.type === "list") {
      const hasTasks =
        f.of?.some((x) => x.key === "titolo") && f.of.some((x) => x.key === "reparto");
      const tasks = hasTasks
        ? [
            ...(products ?? []).flatMap((p) =>
              (PRODUCT_TASKS[p.nome] ?? [[`Attivare ${p.nome}`, "Support"]]).map(
                ([titolo, reparto]) => ({ titolo, reparto }),
              ),
            ),
            ...(fold(show((contract as { testo?: unknown })?.testo)).includes("fattur")
              ? [{ titolo: "Fatturare il primo canone all'attivazione", reparto: "Administration" }]
              : []),
          ]
        : [];
      fields[f.key] = tasks.slice(0, AUTOMATION_LIMITS.forEachRounds);
    } else if (f.type === "number") fields[f.key] = 0;
    else if (f.type === "boolean") fields[f.key] = show(reply).trim() !== "";
    else if (f.type === "date") fields[f.key] = new Date(0).toISOString().slice(0, 10);
    else if (f.type === "email")
      fields[f.key] =
        allText.match(/[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]+/)?.[0] ?? "cliente@example.com";
    else if (f.type === "person") fields[f.key] = ownerId ?? "p-roberta";
    else if (/mancant/.test(f.key)) fields[f.key] = missing.map((m) => m.item).join(", ");
    else if (/prodotto/.test(f.key)) fields[f.key] = products?.[0]?.nome ?? "";
    else fields[f.key] = show(values[0]?.[1]).slice(0, 200);
  }

  const reason =
    reply !== undefined
      ? missing.length === 0
        ? "La risposta contiene tutto quello che era stato chiesto."
        : `Nella risposta manca: ${missing.map((m) => m.item).join(", ")}.`
      : products
        ? `Ho letto il contratto e i prodotti venduti (${products.map((p) => p.nome).join(", ")}).`
        : `Ho letto ${values.map(([k]) => `«${k}»`).join(", ") || "l'evento"}.`;
  return { kind: "claude_result", ...(outcome !== undefined ? { outcome } : {}), fields, reason };
}
