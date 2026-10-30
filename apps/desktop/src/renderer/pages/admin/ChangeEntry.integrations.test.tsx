import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instance, resetApi, setLatency } from "../../data/api";
import { markReauthenticated } from "../../data/auth/reauth";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import i18n, { setLanguage } from "../../i18n";
import { resetReauthForTest } from "../../layout/useReauth";
import { renderRoute } from "../../test/renderRoute";

// Le voci delle integrazioni nel registro (area 9b, Task 4, Ruling T3): la
// voce salva i soli campi cambiati in valori STABILI (il nome del campo come
// chiave, on/off come booleani, il formato e gli eventi del webhook come
// id) e `ChangeEntry` li dice nella lingua di chi legge. I nomi dati da una
// persona (un workspace, un bucket, un URL, un dominio) restano com'erano.

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

describe("le voci delle integrazioni, in inglese e in italiano", () => {
  it("account git, revisore, app Google, archiviazione, webhook e plugin", async () => {
    setSessionPersonId(ROBERTA);
    markReauthenticated(ROBERTA);
    await instance.updateGitAccount("git-bitbucket-audin", { workspace: "audin-srl" });
    await instance.setDefaultReviewer("git-github-stubwise", false);
    await instance.setDefaultReviewer("git-github-stubwise", true);
    await instance.updateGoogleApp("gw-example", { domains: ["example.com", "example.org"] });
    await instance.setAttachments(false);
    const w = await instance.getWebhook();
    await instance.saveWebhook({
      ...w,
      format: "discord",
      events: { ...w.events, "job.pr_opened": false, "release.failed": true },
    });
    await instance.updatePluginRef("plg-superpowers", { ref: "v4.1.0", trusted: true });

    // Nel dato, nessuna parola inglese: chiavi, booleani, id.
    expect(state.changelog.map((e) => [e.kind, e.before, e.after])).toEqual([
      ["git_account.updated", '{"workspace":"audin"}', '{"workspace":"audin-srl"}'],
      ["git_account.updated", '{"defaultReviewer":true}', '{"defaultReviewer":false}'],
      ["git_account.default_reviewer_changed", null, "GitHub Stubwise"],
      [
        "google_app.updated",
        '{"domains":["example.com"]}',
        '{"domains":["example.com","example.org"]}',
      ],
      ["storage.changed", '{"attachments":true}', '{"attachments":false}'],
      [
        "webhook.changed",
        '{"format":"slack","events":["ticket.created","job.failed","job.pr_opened","monitor"]}',
        '{"format":"discord","events":["ticket.created","job.failed","release.failed","monitor"]}',
      ],
      ["plugin.ref_updated", "v4.0.3", "v4.1.0"],
    ]);

    const expected = {
      en: [
        "Roberta Fontana updated superpowers to a new ref. | v4.0.3 → v4.1.0",
        "Roberta Fontana changed the outgoing webhook. | Format Slack → Discord · Events + Release failed, − Pull request opened by Claude",
        "Roberta Fontana changed the storage settings. | Attachments On → Off",
        "Roberta Fontana changed the Google app Example. | Email domains + example.org",
        "Roberta Fontana changed the default reviewer to GitHub Stubwise. | none → GitHub Stubwise",
        "Roberta Fontana changed the git account GitHub Stubwise. | Default reviewer On → Off",
        "Roberta Fontana changed the git account Bitbucket Audin. | Workspace audin → audin-srl",
      ],
      it: [
        "Roberta Fontana ha aggiornato superpowers a un nuovo ref. | v4.0.3 → v4.1.0",
        "Roberta Fontana ha cambiato il webhook in uscita. | Formato Slack → Discord · Eventi + Rilascio non riuscito, − Pull request aperta da Claude",
        "Roberta Fontana ha cambiato le impostazioni dell'archiviazione. | Allegati Acceso → Spento",
        "Roberta Fontana ha modificato l'app Google Example. | Domini email + example.org",
        "Roberta Fontana ha reso GitHub Stubwise il revisore predefinito. | nessuno → GitHub Stubwise",
        "Roberta Fontana ha modificato l'account git GitHub Stubwise. | Revisore predefinito Acceso → Spento",
        "Roberta Fontana ha modificato l'account git Bitbucket Audin. | Workspace audin → audin-srl",
      ],
    };
    renderRoute("/admin/changelog", ROBERTA);
    await screen.findByRole("heading", { level: 1, name: "Change log" });
    await waitFor(() => expect(lines()).toEqual(expected.en));
    act(() => setLanguage("it"));
    await waitFor(() => expect(lines()).toEqual(expected.it));
  });
});
