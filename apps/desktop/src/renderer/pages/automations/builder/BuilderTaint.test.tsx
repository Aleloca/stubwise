import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { automations as automationsApi, resetApi, setLatency } from "../../../data/api";
import { state } from "../../../data/store";
import type { AutomationFlow, Step } from "../../../data/types";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { renderRoute } from "../../../test/renderRoute";
import { setMatchMedia } from "../../../test/setup";

// Area 7, F3 (F3-1 = a, M): un passo che sceglie a chi va con un campo di
// Claude nato da un input non fidato chiede SEMPRE l'approvazione. Il
// costruttore lo dice sulla riga, la forza alla prima modifica (e la salva),
// e nel pannello «Runs by itself» non si sceglie più, col motivo.

const LAURA = "p-laura";
const settle = () => act(() => new Promise((r) => setTimeout(r, 600)));

const flow: AutomationFlow = {
  trigger: { kind: "stubwise", event: "mail_received" },
  titleTemplate: "Dalla posta",
  steps: [
    {
      id: "c1",
      kind: "claude",
      instruction: "Chi deve rispondere?",
      inputs: ["email.testo"],
      outcomes: [],
      fields: [{ key: "claude.indirizzo", label: "Indirizzo", type: "email" }],
      branches: {},
    },
    {
      id: "e1",
      kind: "sendEmail",
      to: "{{claude.indirizzo}}",
      subject: "Ciao",
      body: "Testo",
      attachRefs: [],
      approval: { mode: "auto" },
    },
  ] as unknown as Step[],
};

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});

describe("il costruttore con un destinatario scelto da Claude su un dato di fuori (F3-1)", () => {
  it("la riga lo dice; alla prima modifica il passo chiede l'approvazione, e «Runs by itself» non si sceglie", async () => {
    renderRoute("/home", LAURA);
    const a = await automationsApi.createAutomation({ name: "Smista", projectId: "prj-aud", flow });
    renderRoute(`/automations/${a.code}/edit?step=e1`, LAURA);
    await screen.findByRole("tree");
    const row = () => screen.getByRole("tree").querySelector<HTMLElement>('[data-tree-row="e1"]')!;
    await waitFor(() => expect(row()).toHaveTextContent("Asks first: Claude picks who"));
    const subject = await screen.findByRole("textbox", { name: "Subject" });
    subject.textContent = "Ciao di nuovo";
    fireEvent.input(subject);
    await settle();
    const saved = state.automations.find((x) => x.id === a.id)!.versions.at(-1)!.flow;
    expect(saved.steps.find((s) => s.id === "e1")).toMatchObject({
      approval: { mode: "ask", who: { owner: true } },
    });
    const group = screen.getByRole("radiogroup", { name: "Before it runs" });
    expect(within(group).getByRole("radio", { name: /Runs by itself/ })).toBeDisabled();
    expect(group.parentElement).toHaveTextContent(/came from outside/);
    await waitFor(() => expect(row()).not.toHaveTextContent("Asks first: Claude picks who"));
  });
});
