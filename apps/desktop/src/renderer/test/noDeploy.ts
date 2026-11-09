import { screen } from "@testing-library/react";
import { expect } from "vitest";

/**
 * Anti-obiettivo 1: nessun controllo che avvii, rilanci o promuova un
 * rilascio o una pipeline. Si cerca per nome accessibile fra bottoni, link,
 * voci di menu e interruttori, e per testo in tutta la pagina: un elemento il
 * cui testo SIA un invito a rilanciare è vietato (la riga-confine «Stubwise
 * doesn't re-run pipelines» lo nomina solo per negarlo).
 */
export function expectNoDeploy(): void {
  const actions = [
    ...screen.queryAllByRole("button"),
    ...screen.queryAllByRole("link"),
    ...screen.queryAllByRole("menuitem"),
    ...screen.queryAllByRole("switch"),
  ];
  const banned =
    /^(re-?deploy|deploy|re-?run|rerun|retry the pipeline|promote|riprova|rilancia|promuovi)\b/i;
  for (const el of actions) {
    const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
    expect(name, `controllo vietato: «${name}»`).not.toMatch(banned);
  }
  for (const el of document.body.querySelectorAll("*")) {
    expect(el.textContent?.trim() ?? "").not.toMatch(
      /^(deploy|re-?deploy|re-?run( the)? pipeline|riprova la pipeline|rilancia la pipeline)$/i,
    );
  }
}
