// I valori di prima/dopo delle voci d'impostazione del 9b (Ruling T3). Una
// voce è un FATTO salvato: non contiene mai parole di una lingua («On»,
// «Default (Sonnet)», «No budget»), che poi nessuno potrebbe più tradurre.
// Salva valori STABILI, scritti con gli `encode*` qui sotto, e la lettura del
// registro (`reads.ts`, `decodeSetting`) li riporta in forma di dato
// (`SettingValue`); le parole le mette `ChangeEntry`, nella lingua di chi
// legge. Modulo foglia: niente import, così lo usano sia le scritture
// d'istanza sia le letture del registro senza legarle fra loro.
//
// Le forme salvate in `before`/`after`:
// - `switch` (`provider.updated`): `"on"` / `"off"`;
// - `model` (`model.changed`): `"<fonte>:<modello>"`, fonte `set` (scelto
//   qui), `env` (dal worker) o `default`; il modello è un alias o un id;
// - `budget` (`budget.changed`): l'importo in USD come numero in stringa
//   (`"600"`, `"12.5"`), `null` per «nessun budget»;
// - `language` (`content_language.changed`): il locale, `"en"` / `"it"`;
// - `automation` (`automation.changed`): JSON con le sole righe cambiate,
//   `{ rules: AutomationRuleValue[], prReview: … | null }`.
// L'oggetto di `model.changed` ha come `id` e `label` l'id dell'operazione
// (`fix_plan`): il nome lo traduce la pagina (`usage.operations.<op>`).
// I Task 4–7 seguono la stessa regola: un nome dato da una persona (un
// account, un server) si salva com'è; una parola di Stubwise mai.

export interface AutomationRuleValue {
  taskType: "bug" | "feature" | "activity";
  autoFix: boolean;
  maxEffort: number;
  planApprovalMinEffort: number | null;
  maxCostUsd: number | null;
}

export interface PrReviewValue {
  enabled: boolean;
  maxCostUsd: number | null;
}

export type ModelSourceValue = "set" | "env" | "default";

export type SettingValue =
  | { type: "switch"; on: boolean }
  | { type: "model"; source: ModelSourceValue; model: string }
  | { type: "budget"; usd: number | null }
  | { type: "language"; locale: string }
  | { type: "automation"; rules: AutomationRuleValue[]; prReview: PrReviewValue | null };

/** Il tipo di valore di ogni voce d'impostazione. */
export const SETTING_KINDS: Readonly<Record<string, SettingValue["type"]>> = {
  "provider.updated": "switch",
  "model.changed": "model",
  "budget.changed": "budget",
  "content_language.changed": "language",
  "automation.changed": "automation",
};

export const encodeSwitch = (on: boolean): string => (on ? "on" : "off");
export const encodeModel = (source: ModelSourceValue, model: string): string =>
  `${source}:${model}`;
export const encodeBudget = (usd: number | null): string | null =>
  usd === null ? null : String(usd);
export const encodeAutomation = (
  rules: AutomationRuleValue[],
  prReview: PrReviewValue | null,
): string => JSON.stringify({ rules, prReview });

/** Il valore salvato di una voce d'impostazione, in forma di dato; `null` se non lo riconosce. */
export function decodeSetting(kind: string, raw: string | null): SettingValue | null {
  switch (SETTING_KINDS[kind]) {
    case "switch":
      return raw === "on" || raw === "off" ? { type: "switch", on: raw === "on" } : null;
    case "model": {
      const m = raw ? /^(set|env|default):(.+)$/.exec(raw) : null;
      return m ? { type: "model", source: m[1] as ModelSourceValue, model: m[2]! } : null;
    }
    case "budget": {
      if (raw === null) return { type: "budget", usd: null };
      const usd = Number(raw);
      return Number.isFinite(usd) ? { type: "budget", usd } : null;
    }
    case "language":
      return raw ? { type: "language", locale: raw } : null;
    case "automation": {
      if (!raw) return null;
      try {
        const v = JSON.parse(raw) as {
          rules?: AutomationRuleValue[];
          prReview?: PrReviewValue | null;
        };
        return { type: "automation", rules: v.rules ?? [], prReview: v.prReview ?? null };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}
