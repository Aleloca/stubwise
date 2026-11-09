import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerProvider, useViewer } from "../data/viewer";
import { ToastRegion, clearToasts, useToast } from "./Toast";

afterEach(() => {
  act(() => clearToasts());
  vi.useRealTimers();
});

describe("Toast", () => {
  it("un errore compare nella regione annunciata e si chiude col bottone", async () => {
    render(<ToastRegion />);
    const { result } = renderHook(() => useToast());
    act(() => result.current.error("Couldn't move MKX-33. It's back where it was."));
    const region = screen.getByRole("region", { name: "Messages" });
    expect(region).toHaveTextContent("Couldn't move MKX-33. It's back where it was.");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(region).not.toHaveTextContent("MKX-33");
  });

  it("al cambio di persona «vedi come» un messaggio su una task di chi guardava sparisce", async () => {
    function Harness() {
      const { viewer, setPersona } = useViewer();
      const toast = useToast();
      return (
        <>
          <span data-testid="who">{viewer.personId}</span>
          <button type="button" onClick={() => toast.error("Couldn't move MKX-33. It's back where it was.")}>
            fail
          </button>
          <button type="button" onClick={() => setPersona("p-sara")}>
            switch
          </button>
          <ToastRegion />
        </>
      );
    }
    render(
      <ViewerProvider initialPersonId="p-giulia">
        <Harness />
      </ViewerProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "fail" }));
    expect(screen.getByRole("alert")).toHaveTextContent("MKX-33");
    await userEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(screen.getByTestId("who")).toHaveTextContent("p-sara");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/MKX-33/)).toBeNull();
  });

  it("sparisce da solo dopo qualche secondo, e l'azione si esegue", () => {
    vi.useFakeTimers();
    render(<ToastRegion />);
    const { result } = renderHook(() => useToast());
    const undo = vi.fn();
    act(() => result.current.show("MKX-33 planned", { action: { label: "Undo", run: undo } }));
    act(() => screen.getByRole("button", { name: "Undo" }).click());
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText("MKX-33 planned")).toBeNull();

    act(() => result.current.show("Saved"));
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.queryByText("Saved")).toBeNull();
  });
});
