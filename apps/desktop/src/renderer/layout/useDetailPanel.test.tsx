import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ViewerProvider } from "../data/viewer";
import { setMatchMedia } from "../test/setup";
import {
  DETAIL_PANEL_MAX_WIDTH,
  DETAIL_PANEL_MIN_WIDTH,
  DetailPanel,
  detailPanelWidthKey,
  useDetailPanel,
} from "./useDetailPanel";

beforeEach(() => {
  window.localStorage.clear();
});

function Harness({ withModal = false }: { withModal?: boolean }) {
  const panel = useDetailPanel();
  return (
    <>
      <button type="button" onClick={panel.open}>
        open
      </button>
      {panel.isOpen && (
        <DetailPanel mode={panel.mode} label="Details" onClose={panel.close}>
          <p>body</p>
        </DetailPanel>
      )}
      {withModal && <div role="dialog" aria-modal="true" aria-label="Palette" />}
    </>
  );
}

const panelEl = () => document.querySelector<HTMLElement>("[data-detail-panel]");

describe("DetailPanel — Esc", () => {
  it("non chiude con un Esc già gestito da altri (defaultPrevented)", async () => {
    setMatchMedia("(min-width: 1200px)", true);
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    const consumed = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    consumed.preventDefault();
    act(() => {
      window.dispatchEvent(consumed);
    });
    expect(panelEl()).not.toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(panelEl()).toBeNull();
  });

  it("non chiude finché un dialogo modale è aperto", async () => {
    setMatchMedia("(min-width: 1200px)", true);
    render(<Harness withModal />);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await userEvent.keyboard("{Escape}");
    expect(panelEl()).not.toBeNull();
  });

  it("Maiusc+Esc non lo chiude: è «segna tutto letto» della Chat", async () => {
    setMatchMedia("(min-width: 1200px)", true);
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", shiftKey: true, cancelable: true }),
      );
    });
    expect(panelEl()).not.toBeNull();
  });
});

describe("DetailPanel — fuoco in modalità sovrapposta", () => {
  it("il fuoco entra nel pannello all'apertura e torna al bottone d'origine alla chiusura", async () => {
    setMatchMedia("(min-width: 1200px)", false);
    render(<Harness />);
    const origin = screen.getByRole("button", { name: "open" });
    await userEvent.click(origin);
    const dialog = screen.getByRole("dialog", { name: "Details" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Details" })).toBeNull();
    expect(origin).toHaveFocus();
  });

  it("affiancato non ruba il fuoco", async () => {
    setMatchMedia("(min-width: 1200px)", true);
    render(<Harness />);
    const origin = screen.getByRole("button", { name: "open" });
    await userEvent.click(origin);
    expect(origin).toHaveFocus();
  });
});

describe("DetailPanel — larghezza", () => {
  it("si ridimensiona dal bordo con la tastiera, entro 320–640, e la salva per persona", async () => {
    setMatchMedia("(min-width: 1200px)", true);
    render(
      <ViewerProvider initialPersonId="p-elena">
        <Harness />
      </ViewerProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    const handle = screen.getByRole("separator", { name: "Resize panel" });
    expect(handle).toHaveAttribute("aria-valuenow", "360");
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(panelEl()!.style.width).toBe("392px");
    expect(window.localStorage.getItem(detailPanelWidthKey("p-elena"))).toBe("392");

    await userEvent.keyboard("{End}");
    expect(panelEl()!.style.width).toBe(`${DETAIL_PANEL_MAX_WIDTH}px`);
    await userEvent.keyboard("{Home}");
    expect(panelEl()!.style.width).toBe(`${DETAIL_PANEL_MIN_WIDTH}px`);
  });

  it("si trascina col puntatore e riparte dalla larghezza salvata", async () => {
    setMatchMedia("(min-width: 1200px)", true);
    window.localStorage.setItem(detailPanelWidthKey("p-elena"), "500");
    render(
      <ViewerProvider initialPersonId="p-elena">
        <Harness />
      </ViewerProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    expect(panelEl()!.style.width).toBe("500px");
    const handle = screen.getByRole("separator", { name: "Resize panel" });
    fireEvent.pointerDown(handle, { clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 900, pointerId: 1 });
    expect(panelEl()!.style.width).toBe("600px");
    fireEvent.pointerDown(handle, { clientX: 900, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 });
    expect(panelEl()!.style.width).toBe("640px");
  });

  it("uno storage bloccato non rompe il pannello", async () => {
    setMatchMedia("(min-width: 1200px)", true);
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      render(<Harness />);
      await userEvent.click(screen.getByRole("button", { name: "open" }));
      expect(panelEl()!.style.width).toBe("360px");
    } finally {
      Object.defineProperty(window, "localStorage", original);
    }
  });
});
