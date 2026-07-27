import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetViewPings, useViewPing } from "./use-view-ping";

const pingPageView = vi.hoisted(() => vi.fn());
vi.mock("./docs-api", () => ({ pingPageView }));

const REPO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function Probe({ slug }: { slug: string | undefined }) {
  useViewPing(REPO, slug);
  return null;
}

describe("useViewPing", () => {
  beforeEach(() => {
    pingPageView.mockClear();
    resetViewPings();
  });

  it("pinga una volta all'apertura della pagina", () => {
    render(<Probe slug="auth-module" />);
    expect(pingPageView).toHaveBeenCalledTimes(1);
    expect(pingPageView).toHaveBeenCalledWith(REPO, "auth-module");
  });

  it("non ripinga lo stesso slug al rimontaggio ravvicinato", () => {
    const first = render(<Probe slug="auth-module" />);
    first.unmount();
    render(<Probe slug="auth-module" />);
    expect(pingPageView).toHaveBeenCalledTimes(1);
  });

  it("pinga di nuovo per uno slug diverso", () => {
    render(<Probe slug="auth-module" />);
    render(<Probe slug="billing-module" />);
    expect(pingPageView).toHaveBeenCalledTimes(2);
  });

  it("senza slug non pinga", () => {
    render(<Probe slug={undefined} />);
    expect(pingPageView).not.toHaveBeenCalled();
  });
});
