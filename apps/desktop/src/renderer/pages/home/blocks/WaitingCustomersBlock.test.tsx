import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../../data/api";
import { now, state, visibleProjectIds } from "../../../data/store";
import type { MailMessage } from "../../../data/types";
import { renderRoute } from "../../../test/renderRoute";
import { accessState } from "../../../data/access/state";
import { BLOCKS } from "./registry";

// Area 8, «Clienti in attesa» (R1–R2): il blocco della Home legge la posta
// delle MIE caselle (`mail.listWaitingCustomers`), non più Support. Nel
// catalogo, mai nelle Home di default [A 17]. Una riga: cliente, oggetto,
// progetto, da quanto aspetta, e il motivo di Claude — o «da valutare».
// Il clic apre il thread nella Posta.

const ME = "p-giulia";
const hours = (h: number) => new Date(Date.parse(now()) - h * 3_600_000).toISOString();

function thread(threadId: string, subject: string): MailMessage {
  const box = state.mailboxes.find((b) => b.personId === ME)!;
  const projectId = [...visibleProjectIds(ME)][0]!;
  return {
    id: `wcb-${threadId}`,
    messageId: `<wcb-${threadId}@test>`,
    threadId,
    from: { name: "Anna Verdi", email: "anna@cliente.test", personId: null },
    to: [{ name: "Giulia", email: box.email, personId: ME }],
    cc: null,
    subject,
    at: hours(50),
    text: "…",
    quoted: null,
    html: null,
    attachments: [],
    mailboxPersonIds: [ME],
    readByPersonIds: [],
    kind: "email",
    context: false,
    classification: {
      state: "done",
      projectIds: [projectId],
      importance: "normal",
      dueDate: null,
      uncertainProjectIds: [],
    },
  };
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  state.mailMessages = [];
  state.mailReplyJudgments.clear();
  state.personalHomes = state.personalHomes.filter((h) => h.personId !== ME);
  state.personalHomes.push({
    personId: ME,
    blocks: [{ kind: "waitingCustomers" }],
    seenDepartmentUpdates: {},
  });
});
afterEach(() => resetApi());

describe("il blocco «Clienti in attesa» (R1–R2)", () => {
  it("righe col motivo di Claude o «To review»; il clic apre il thread nella Posta", async () => {
    const yes = thread("th-yes", "Fattura di ottobre");
    const pending = thread("th-pending", "Preventivo nuovo");
    state.mailMessages.push(yes, pending);
    const box = state.mailboxes.find((b) => b.personId === ME)!;
    state.mailReplyJudgments.set(`${box.email}|${yes.id}`, {
      judgment: "yes",
      reason: "Asks for the October invoice and nobody sent it.",
    });
    const router = renderRoute("/home", ME);
    const block = await screen.findByRole("region", { name: "Customers waiting" });
    const rowYes = await waitFor(() => {
      const el = block.querySelector<HTMLElement>("[data-waiting-thread='th-yes']");
      if (!el) throw new Error("no row");
      return el;
    });
    expect(rowYes).toHaveTextContent("Anna Verdi");
    expect(rowYes).toHaveTextContent("Fattura di ottobre");
    expect(rowYes).toHaveTextContent("Asks for the October invoice and nobody sent it.");
    const rowPending = block.querySelector<HTMLElement>("[data-waiting-thread='th-pending']")!;
    expect(rowPending).toHaveTextContent("To review");
    await userEvent.click(within(rowYes).getByRole("link"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/mail/th-yes"));
  });

  it("vuoto: «No customer is waiting»; nel catalogo, mai nelle Home di default", async () => {
    renderRoute("/home", ME);
    const block = await screen.findByRole("region", { name: "Customers waiting" });
    expect(await within(block).findByText("No customer is waiting")).toBeInTheDocument();
    expect(BLOCKS.waitingCustomers.area).toBe("mail-waiting");
  });

  it("mai nelle Home di default: la Home di p-laura non ha il blocco", async () => {
    renderRoute("/home", "p-laura");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    expect(screen.queryByRole("region", { name: /^Customers waiting/ })).toBeNull();
  });

  it("review M1–M3: un «sì» senza motivo non è «To review»; nessun colore d'allarme su ogni riga", async () => {
    const yes = thread("th-yes", "Fattura di ottobre");
    state.mailMessages.push(yes);
    const box = state.mailboxes.find((b) => b.personId === ME)!;
    state.mailReplyJudgments.set(`${box.email}|${yes.id}`, { judgment: "yes", reason: null });
    renderRoute("/home", ME);
    const block = await screen.findByRole("region", { name: "Customers waiting" });
    const row = await waitFor(() => {
      const el = block.querySelector<HTMLElement>("[data-waiting-thread='th-yes']");
      if (!el) throw new Error("no row");
      return el;
    });
    expect(row).not.toHaveTextContent("To review");
    expect(row).toHaveTextContent("Claude says it needs your reply");
    expect(row.querySelector(".text-warning")).toBeNull();
  });
});

describe("review M7: solo la MIA Home", () => {
  /** Il catalogo «Add block» dell'editor aperto su `which` («My Home» o la Home del reparto). */
  async function catalogFor(which: RegExp) {
    const user = userEvent.setup();
    // Giulia gestisce anche la Home di un suo reparto: «Customize» chiede quale Home.
    // Nella Home personale il blocco non c'è ancora (il catalogo non ripropone i presenti).
    state.personalHomes.find((h) => h.personId === ME)!.blocks = [{ kind: "myTasks" }];
    const dep = accessState().departments.find((d) => d.memberIds.includes(ME))!;
    if (!dep.homeManagerIds.includes(ME)) dep.homeManagerIds.push(ME);
    renderRoute("/home", ME);
    await user.click(await screen.findByRole("button", { name: "Customize" }));
    await user.click(await screen.findByRole("menuitem", { name: which }));
    await user.click(await screen.findByRole("button", { name: "Add block" }));
    const menu = await screen.findByRole("menu", { name: "Add block" });
    return within(menu)
      .queryAllByRole("menuitem")
      .map((i) => i.textContent ?? "");
  }

  it("nel catalogo della Home personale c'è", async () => {
    expect((await catalogFor(/^My Home$/)).some((n) => /Customers waiting/.test(n))).toBe(true);
  });

  it("nel catalogo della Home di un reparto no (la posta è di chi guarda)", async () => {
    const names = await catalogFor(/^(?!My Home$).+ Home$/);
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((n) => /Customers waiting/.test(n))).toBe(false);
  });
});
