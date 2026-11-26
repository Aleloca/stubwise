import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import { RoleOptions } from "./InviteDialog";

// Review F1 (72): il blocco dell'ultimo full admin sta sulla SCELTA, non
// sull'azione intera. Una scelta col suo `block` è spenta e dice perché; le
// altre restano scegliibili.

describe("RoleOptions: il blocco della singola scelta", () => {
  it("la scelta bloccata è spenta col motivo; le altre si scelgono", async () => {
    const onPick = vi.fn();
    render(
      <RoleOptions
        roles={[
          { roleId: "r-admin", name: "Admin", permissionCount: 40, missing: [] },
          {
            roleId: "r-user",
            name: "User",
            permissionCount: 9,
            missing: [],
            block: "last_full_admin",
          },
        ]}
        value="r-admin"
        blockName="Roberta Fontana"
        onPick={onPick}
      />,
    );
    const user = userEvent.setup();
    const blocked = screen.getByRole("menuitemradio", { name: /User/ });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).toHaveTextContent(/Roberta Fontana/);
    await user.click(blocked);
    expect(onPick).not.toHaveBeenCalled();
    await user.click(screen.getByRole("menuitemradio", { name: /Admin/ }));
    expect(onPick).toHaveBeenCalledWith("r-admin");
  });
});
