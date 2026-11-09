import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instance, resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import i18n, { setLanguage } from "../../i18n";
import { resetReauthForTest } from "../../layout/useReauth";
import { renderRoute } from "../../test/renderRoute";

// Le voci della coda nel registro (area 9b, Task 5, Ruling T3): la ripresa
// salva «paused:<da quando>» → «running», e `ChangeEntry` lo dice nella
// lingua di chi legge. Scritte con le funzioni vere del livello dati.

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
const lines = () =>
  entries().map((e) => [...e.querySelectorAll("p")].map((p) => p.textContent ?? "").join(" | "));

describe("le voci della coda, in inglese e in italiano", () => {
  it("pausa, ripresa (con prima e dopo) e lavoro rimesso in coda", async () => {
    setSessionPersonId(ROBERTA);
    await instance.resumeQueue("prj-stw");
    await instance.pauseQueue("prj-stw");
    expect(await instance.retryJob("cv-run-acq-3")).toMatchObject({ ok: true });

    expect(state.changelog.map((e) => [e.kind, e.object.label, e.before, e.after])).toEqual([
      ["queue.resumed", "STW", "paused:2026-10-22T18:00:00Z", "running"],
      ["queue.paused", "STW", null, null],
      ["job.retried", "ACQ-3", null, null],
    ]);

    const expected = {
      en: [
        "Roberta Fontana put the work on ACQ-3 back in the queue.",
        "Roberta Fontana paused STW's queue.",
        "Roberta Fontana resumed STW's queue. | Paused since Oct 22, 18:00 → Running",
      ],
      it: [
        "Roberta Fontana ha rimesso in coda il lavoro di ACQ-3.",
        "Roberta Fontana ha messo in pausa la coda di STW.",
        "Roberta Fontana ha ripreso la coda di STW. | In pausa dal 22 ott, 18:00 → Attiva",
      ],
    };
    renderRoute("/admin/changelog", ROBERTA);
    await screen.findByRole("heading", { level: 1, name: "Change log" });
    await waitFor(() => expect(lines()).toEqual(expected.en));
    act(() => setLanguage("it"));
    await waitFor(() => expect(lines()).toEqual(expected.it));
  });
});
