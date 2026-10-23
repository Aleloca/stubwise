import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../data/api";
import { PROJECT_STATUSES } from "../data/seed/statuses";
import type { FilterCriteria } from "../data/types";
import { renderWithData } from "../test/renderWithData";
import { FilterBar } from "./FilterBar";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

function Harness({
  initial,
  lockedProjectId,
  onChange,
}: {
  initial: FilterCriteria;
  lockedProjectId?: string;
  onChange?: (c: FilterCriteria) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <FilterBar
      value={value}
      lockedProjectId={lockedProjectId}
      onChange={(c) => {
        setValue(c);
        onChange?.(c);
      }}
    />
  );
}

const mkxStatuses = PROJECT_STATUSES.filter((s) => s.projectId === "prj-mkx");

async function openStatusMenu() {
  await userEvent.click(await screen.findByRole("button", { name: /^Status/ }));
  return screen.findByRole("menu", { name: "Status" });
}

describe("FilterBar", () => {
  it("con due progetti offre solo le famiglie, non gli stati precisi", async () => {
    renderWithData(<Harness initial={{ projectIds: ["prj-mkx", "prj-aud"] }} />);
    const menu = await openStatusMenu();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "In progress" })).toBeInTheDocument();
    for (const s of mkxStatuses) {
      expect(within(menu).queryByRole("menuitemcheckbox", { name: s.name })).toBeNull();
    }
  });

  it("con un progetto bloccato offre anche gli stati precisi di quel progetto", async () => {
    renderWithData(<Harness initial={{}} lockedProjectId="prj-mkx" />);
    const menu = await openStatusMenu();
    for (const s of mkxStatuses) {
      expect(
        await within(menu).findByRole("menuitemcheckbox", { name: s.name }),
      ).toBeInTheDocument();
    }
  });

  it("scegliere una famiglia cambia i criteri; Esc chiude il menu e non arriva oltre", async () => {
    const onChange = vi.fn();
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    renderWithData(<Harness initial={{}} lockedProjectId="prj-mkx" onChange={onChange} />);
    const menu = await openStatusMenu();
    await userEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "In progress" }));
    expect(onChange).toHaveBeenLastCalledWith({ families: ["active"] });
    expect(within(menu).getByRole("menuitemcheckbox", { name: "In progress" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    const esc = outer.mock.calls.map(([e]) => e as KeyboardEvent).find((e) => e.key === "Escape");
    expect(esc?.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Status/ })).toHaveFocus(),
    );
    window.removeEventListener("keydown", outer);
  });

  it("con un progetto bloccato non c'è il criterio progetto; «Clear» svuota i criteri", async () => {
    const onChange = vi.fn();
    renderWithData(
      <Harness initial={{ families: ["todo"] }} lockedProjectId="prj-mkx" onChange={onChange} />,
    );
    await screen.findByRole("button", { name: /^Status/ });
    expect(screen.queryByRole("button", { name: /^Project/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it("togliere i progetti fino a più di uno toglie gli stati precisi scelti", async () => {
    const onChange = vi.fn();
    renderWithData(
      <Harness
        initial={{ projectIds: ["prj-mkx"], statusIds: [mkxStatuses[0]!.id] }}
        onChange={onChange}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /^Project/ }));
    const menu = await screen.findByRole("menu", { name: "Project" });
    await userEvent.click(await within(menu).findByRole("menuitemcheckbox", { name: /^AUD/ }));
    expect(onChange).toHaveBeenLastCalledWith({ projectIds: ["prj-mkx", "prj-aud"] });
  });
});
