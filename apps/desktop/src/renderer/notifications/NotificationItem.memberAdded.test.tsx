import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claude,
  confirmProposal,
  createConversation,
  listNotifications,
  resetApi,
  runScript,
  setLatency,
  setStreamLatency,
} from "../data/api";
import { markReauthenticated } from "../data/auth/reauth";
import { setSessionPersonId } from "../data/session";
import { state } from "../data/store";
import type { AppNotification, ConversationEvent } from "../data/types";
import i18n from "../i18n";
import { renderWithData } from "../test/renderWithData";
import { NotificationItem } from "./NotificationItem";

// `member.added` nel pannello (area 10b, Task 7, D4; shape §3.9): titolo e
// corpo si compongono a lettura nella lingua di chi guarda, dai valori
// stabili (progetto, ruolo, chi ha agito); il nome del ruolo è quello di
// adesso, e un ruolo che non c'è più si dice. Annullata, la notifica resta
// con «Undone by» e il codice del progetto non apre più niente [SC 16].

const LAURA = "p-laura";
const LUCA = "p-luca";

beforeEach(() => {
  setLatency(0);
  setStreamLatency(null);
  resetApi();
});
afterEach(async () => {
  resetApi();
  await i18n.changeLanguage("en");
});

/** Come la legge Luca: una riga a mano, SENZA `viaClaude` (apposta: la forma più comune). */
const byHand: AppNotification = {
  id: "n-member-test",
  kind: "member.added",
  projectId: "prj-acq",
  objectCode: "ACQ",
  departmentId: null,
  recipientIds: [LUCA],
  title: "You've been added to ACQ as Developer",
  body: "Laura Costa added you to ACQ as Developer.",
  createdAt: "2026-10-30T09:00:00Z",
  read: false,
  archived: false,
  snoozedUntil: null,
  link: "#/p/ACQ/overview",
  roleId: "role-developer",
  roleName: "Developer",
  actorName: "Laura Costa",
};

function renderItem(n: AppNotification) {
  return renderWithData(
    <ul>
      <NotificationItem
        notification={n}
        project={{ code: "ACQ", name: "Acquedotto" }}
        onOpen={() => {}}
        onChange={() => {}}
      />
    </ul>,
    { personId: LUCA },
  );
}

const itemText = () =>
  (document.querySelector("[data-notification]")?.textContent ?? "").replace(/\s+/g, " ");

describe("member.added: titolo e corpo a lettura", () => {
  it("a mano, in en", () => {
    renderItem(byHand);
    expect(itemText()).toContain("You've been added to ACQ as Developer");
    expect(itemText()).toContain("Laura Costa added you to ACQ as Developer.");
    expect(itemText()).not.toContain("Claude");
  });

  it("a mano, in it: «ad ACQ»", async () => {
    await i18n.changeLanguage("it");
    renderItem(byHand);
    expect(itemText()).toContain("Sei stato aggiunto ad ACQ come Developer");
    expect(itemText()).toContain("Laura Costa ti ha aggiunto ad ACQ come Developer.");
    expect(itemText()).not.toContain("added");
  });

  it("con Claude: «Claude on behalf of Laura Costa added you…», e in it", async () => {
    const via = {
      ...byHand,
      viaClaude: { personId: LAURA, actionId: "ca-x" },
      viaClaudeName: "Laura Costa",
      undoneByName: null,
    };
    renderItem(via);
    expect(itemText()).toContain("Claude on behalf of Laura Costa added you to ACQ as Developer.");
    document.body.innerHTML = "";
    await i18n.changeLanguage("it");
    renderItem(via);
    expect(itemText()).toContain(
      "Claude per conto di Laura Costa ti ha aggiunto ad ACQ come Developer.",
    );
  });

  it("il ruolo rinominato dice il nome nuovo; un ruolo eliminato si dice [SC 15]", async () => {
    renderItem({ ...byHand, roleName: "Engineer" });
    expect(itemText()).toContain("You've been added to ACQ as Engineer");
    document.body.innerHTML = "";
    renderItem({ ...byHand, roleName: null });
    expect(itemText()).toContain("You've been added to ACQ as a role that no longer exists");
    document.body.innerHTML = "";
    await i18n.changeLanguage("it");
    renderItem({ ...byHand, roleName: null });
    expect(itemText()).toContain("come un ruolo che non esiste più");
  });

  it("una riga senza `roleId` resta com'è salvata", () => {
    const old: AppNotification = { ...byHand, title: "Saved title", body: "Saved body." };
    delete old.roleId;
    delete old.roleName;
    renderItem(old);
    expect(itemText()).toContain("Saved title");
    expect(itemText()).toContain("Saved body.");
  });
});

describe("member.added dopo «Annulla» (richiesta del coordinatore)", () => {
  it("resta visibile a Luca, con «Undone by Laura Costa», e il codice del progetto è testo, non un link", async () => {
    setSessionPersonId(LAURA);
    markReauthenticated(LAURA);
    const cid = (await createConversation()).id;
    await runScript(cid, [
      {
        step: "event",
        event: {
          type: "proposal",
          proposalId: "prop-test",
          requesterId: LAURA,
          actions: [
            {
              fn: "addMember",
              args: { projectId: "prj-acq", personId: LUCA, roleId: "role-developer" },
              summary: "Add Luca Bianchi to ACQ as Developer",
            },
          ],
          status: "open",
        },
      },
    ]);
    await confirmProposal(cid, "prop-test");
    const groupId = (state.conversationEvents.get(cid) ?? []).find(
      (e): e is Extract<ConversationEvent, { type: "proposal" }> => e.type === "proposal",
    )!.groupId!;
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({ ok: true });

    setSessionPersonId(LUCA);
    const mine = (await listNotifications()).filter((n) => n.kind === "member.added");
    expect(mine).toHaveLength(1);
    renderItem(mine[0]!);
    expect(itemText()).toContain("Undone by Laura Costa");
    expect(itemText()).toContain("Claude on behalf of Laura Costa added you to ACQ as Developer.");
    // Il codice c'è, ma niente si apre: nessun bottone attorno.
    const code = document.querySelector("[data-object-code]")!;
    expect(code.textContent).toBe("ACQ");
    expect(code.closest("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /added to ACQ/ })).toBeNull();
    // Non è un'«eliminata»: nessuna riga che lo dica.
    expect(document.querySelector("[data-object-gone]")).toBeNull();
  });

  it("finché Luca è membro, la notifica si apre", async () => {
    renderItem(byHand);
    expect(document.querySelector("[data-object-code]")!.closest("button")).not.toBeNull();
  });
});
