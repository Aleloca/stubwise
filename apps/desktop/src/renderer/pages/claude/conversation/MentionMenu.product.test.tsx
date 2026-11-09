import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../../data/api";
import { state } from "../../../data/store";
import { setLanguage } from "../../../i18n";
import { renderWithData } from "../../../test/renderWithData";
import { useMentionSuggestions } from "./MentionMenu";

// Il menu «#» della casella e le pagine di prodotto (area 11a, Task 6): con
// le altre pagine dei Docs, la riga dice «ACQ · Product» / «ACQ · Prodotto»,
// composta in lettura; chi non legge ACQ non le vede (R-G5).

const SIGN_IN = "pp-acq-sign-in";
const signInCode = () => state.productPages.find((p) => p.id === SIGN_IN)!.code;

function Rows({ q }: { q: string }) {
  const { groups, loading } = useMentionSuggestions("objects", q, true);
  if (loading) return <p>loading</p>;
  return (
    <ul>
      {groups.flatMap((g) =>
        g.items.map((s) => (
          <li key={s.id} data-group={g.label}>
            {[s.code, s.label, s.detail].filter(Boolean).join(" | ")}
          </li>
        )),
      )}
    </ul>
  );
}

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => {
  act(() => setLanguage("en"));
});

describe("menu «#» e pagine di prodotto", () => {
  it("«sign»: la pagina di prodotto fra le pagine, `detail` «ACQ · Product»", async () => {
    renderWithData(<Rows q="sign" />, { personId: "p-laura" });
    const row = await screen.findByText(`${signInCode()} | Sign-in | ACQ · Product`);
    expect(row).toHaveAttribute("data-group", "Docs");
  });

  it("in italiano «ACQ · Prodotto»", async () => {
    act(() => setLanguage("it"));
    renderWithData(<Rows q="sign" />, { personId: "p-laura" });
    expect(
      await screen.findByText(`${signInCode()} | Sign-in | ACQ · Prodotto`),
    ).toBeInTheDocument();
  });

  it("chi non legge i Docs di ACQ non vede né il titolo né il codice", async () => {
    renderWithData(<Rows q="sign" />, { personId: "p-giulia" });
    await waitFor(() => expect(screen.queryByText("loading")).toBeNull());
    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).not.toContain("sign-in");
    expect(text).not.toContain(signInCode().toLowerCase());
  });
});
