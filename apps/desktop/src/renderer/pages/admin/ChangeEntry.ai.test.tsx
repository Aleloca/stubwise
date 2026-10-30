import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instance, resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import i18n, { setLanguage } from "../../i18n";
import { resetReauthForTest } from "../../layout/useReauth";
import { renderRoute } from "../../test/renderRoute";

// Le voci AI del registro (area 9b, Task 3, Ruling T3): la voce salva valori
// STABILI (l'id dell'operazione, on/off, fonte e modello, l'importo, il
// locale) e `ChangeEntry` li dice nella lingua di chi legge. Scritte con le
// funzioni vere del livello dati, lette in inglese e in italiano.

const ROBERTA = "p-roberta";

beforeEach(() => {
  setLatency(0);
  resetApi();
  resetReauthForTest();
  window.localStorage.clear();
  state.changelog.splice(0);
});
afterEach(async () => {
  resetApi();
  await i18n.changeLanguage("en");
});

const entries = () => [...document.querySelectorAll<HTMLElement>("[data-change-entry]")];
/** Frase e riga del prima/dopo di ogni voce, dalla più recente. */
const lines = () =>
  entries().map((e) => [...e.querySelectorAll("p")].map((p) => p.textContent ?? "").join(" | "));

describe("le voci AI del registro, in inglese e in italiano", () => {
  it("modello, budget, lingua, provider e automazione", async () => {
    setSessionPersonId(ROBERTA);
    await instance.setModel("fix_plan", null);
    await instance.setModel("mail_classify", "opus");
    await instance.saveBudget({ monthlyUsd: null, contentLanguage: "it" });
    await instance.saveBudget({ monthlyUsd: 800, contentLanguage: "it" });
    await instance.setProviderEnabled("prv-backup-max", false);
    const { rules, prReview } = await instance.getAutomation();
    await instance.saveAutomation({
      rules: rules.map((r) => (r.taskType === "bug" ? { ...r, maxEffort: 3 as const } : r)),
      prReview: { ...prReview, maxCostUsd: 3 },
    });

    // Nel dato, nessuna parola inglese: solo valori stabili.
    expect(state.changelog.map((e) => [e.kind, e.object.label, e.before, e.after])).toEqual([
      ["model.changed", "fix_plan", "set:opus", "default:sonnet"],
      ["model.changed", "mail_classify", "env:haiku", "set:opus"],
      ["budget.changed", "budget", "600", null],
      ["content_language.changed", "content_language", "en", "it"],
      ["budget.changed", "budget", null, "800"],
      ["provider.updated", "Backup Max", "on", "off"],
      ["automation.changed", "automation", expect.any(String), expect.any(String)],
    ]);

    const expected = {
      en: [
        "Roberta Fontana changed the AI automation. | Bug: auto-fix up to effort 2 · PR review cap $2 → Bug: auto-fix up to effort 3 · PR review cap $3",
        "Roberta Fontana changed the AI account Backup Max. | On → Off",
        "Roberta Fontana changed the monthly AI budget. | No budget → $800",
        "Roberta Fontana changed the language of generated content. | English → Italiano",
        "Roberta Fontana changed the monthly AI budget. | $600 → No budget",
        "Roberta Fontana changed the model for Mail classification. | Server configuration (Haiku) → Opus",
        "Roberta Fontana changed the model for Fix plan. | Opus → Default (Sonnet)",
      ],
      it: [
        "Roberta Fontana ha cambiato l'automazione AI. | Bug: auto-fix fino all'effort 2 · tetto della revisione delle PR $2 → Bug: auto-fix fino all'effort 3 · tetto della revisione delle PR $3",
        "Roberta Fontana ha modificato l'account AI Backup Max. | Acceso → Spento",
        "Roberta Fontana ha cambiato il budget AI mensile. | Nessun budget → $800",
        "Roberta Fontana ha cambiato la lingua dei contenuti generati. | English → Italiano",
        "Roberta Fontana ha cambiato il budget AI mensile. | $600 → Nessun budget",
        "Roberta Fontana ha cambiato il modello per Classificazione della posta. | Configurazione del server (Haiku) → Opus",
        "Roberta Fontana ha cambiato il modello per Piano della correzione. | Opus → Predefinito (Sonnet)",
      ],
    };
    renderRoute("/admin/changelog", ROBERTA);
    await screen.findByRole("heading", { level: 1, name: "Change log" });
    await waitFor(() => expect(lines()).toEqual(expected.en));
    act(() => setLanguage("it"));
    await waitFor(() => expect(lines()).toEqual(expected.it));
  });
});
