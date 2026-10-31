import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { recordChange } from "../../data/changelog/index";
import type { ChangeObjectLink } from "../../data/queries";
import { state } from "../../data/store";
import i18n from "../../i18n";
import { resetReauthForTest } from "../../layout/useReauth";
import { renderRoute } from "../../test/renderRoute";

// Il link dell'oggetto di una voce del 9c (Task 1): porta alla sezione di
// Progetto → Settings in cui sta l'oggetto. Il ramo è uno dei casi di uno
// `switch` esaustivo in `ObjectLink`: una destinazione senza ramo non compila.

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

describe("il link projectSettings di una voce", () => {
  it("apre #/p/<CODE>/settings/<section>", async () => {
    recordChange({
      kind: "project.switch_changed",
      actorId: ROBERTA,
      projectId: "prj-acq",
      object: { type: "project", id: "prj-acq", label: "ACQ" },
      before: "on",
      after: "off",
      params: { switch: "weeklyBrief" },
    });
    renderRoute("/admin/changelog", ROBERTA);
    await screen.findByRole("heading", { level: 1, name: "Change log" });
    const link = await screen.findByRole("link", { name: "ACQ" });
    // Nei test il router è in memoria: l'indirizzo è quello dopo `#`.
    expect(link.getAttribute("href")).toBe("/p/ACQ/settings/automations");
    // La frase dice l'interruttore in parole, il prima/dopo da valori stabili.
    const entry = document.querySelector("[data-change-entry]")!;
    const lines = [...entry.querySelectorAll("p")].map((p) => p.textContent);
    expect(lines).toEqual(["Roberta Fontana changed “Weekly brief” in ACQ.", "On → Off"]);
  });

  it("una destinazione sconosciuta non compila", () => {
    // @ts-expect-error — `to` fuori da `ChangeObjectLink`: `ObjectLink` non avrebbe il suo ramo.
    const unknown: ChangeObjectLink = { to: "nowhere", code: "ACQ" };
    expect(unknown.to).toBe("nowhere");
  });
});
