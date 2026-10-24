import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { renderWithData } from "../../test/renderWithData";
import { MergeDialog, mergeCandidates } from "./MergeDialog";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

const byId = (id: string) => state.requests.find((r) => r.id === id)!;

describe("mergeCandidates", () => {
  it("le simili per prime; niente archiviate, fuse, di altri progetti né la richiesta stessa", () => {
    // Una nuova richiesta che somiglia alla landing page del showroom (MKX).
    const fresh = {
      ...byId("req-mkx-3"),
      id: "req-mkx-new",
      title: "Showroom event landing",
      createdAt: "2026-10-23T12:00:00Z",
    };
    const list = mergeCandidates(fresh, [...state.requests, fresh]);
    expect(list[0]).toEqual({ request: byId("req-mkx-2"), similar: true });
    const ids = list.map((c) => c.request.id);
    expect(ids).not.toContain("req-mkx-new");
    expect(ids).not.toContain("req-mkx-4"); // fusa
    expect(ids).not.toContain("req-mkx-5"); // archiviata
    expect(ids.every((id) => byId(id).projectId === "prj-mkx")).toBe(true);
    expect(list.slice(1).every((c) => !c.similar)).toBe(true);
  });
});

describe("MergeDialog", () => {
  it("segna le simili e le mette in cima", async () => {
    // req-mkx-4 è fusa in req-mkx-2: riaperta a mano, la sua simile resta req-mkx-2.
    const reopened = { ...byId("req-mkx-4"), status: "new" as const, mergedIntoId: null };
    state.requests = state.requests.map((r) => (r.id === reopened.id ? reopened : r));
    renderWithData(
      <MergeDialog request={reopened} projectName="Kitchens" onMerged={() => {}} onClose={() => {}} />,
      { personId: "p-giulia" },
    );
    const dialog = await screen.findByRole("dialog", { name: "Merge into another request" });
    const radios = await within(dialog).findAllByRole("radio");
    expect(radios[0]).toHaveAccessibleName(/Landing page for the showroom event/);
    expect(radios[0]!.closest("label")).toHaveTextContent("Similar");
  });
});
