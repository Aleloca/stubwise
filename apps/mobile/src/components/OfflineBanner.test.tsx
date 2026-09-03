import ReactTestRenderer from "react-test-renderer";
import "../i18n"; // inizializza i18next (nessun <I18nextProvider> nel test)
import { OfflineBanner } from "./OfflineBanner";

function textOf(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

test("nessuna sincronizzazione: copy dedicata, senza minuti", () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<OfflineBanner lastSyncAt={null} />);
  });
  expect(textOf(renderer!)).toContain("nessuna sincronizzazione");
});

test("12 minuti fa: interpola il conteggio nella stringa", () => {
  const lastSyncAt = new Date("2026-09-03T09:48:00.000Z").toISOString();
  const now = () => new Date("2026-09-03T10:00:00.000Z").getTime();

  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<OfflineBanner lastSyncAt={lastSyncAt} now={now} />);
  });
  expect(textOf(renderer!)).toContain("12 min fa");
});

// Mutazione da rompere apposta: se il calcolo dei minuti usasse i millisecondi
// grezzi invece di dividerli per 60_000, "12 minuti fa" diventerebbe un
// numero enorme e sbagliato nel banner.
test("meno di un minuto: copy 'pochi istanti fa', non '0 min fa'", () => {
  const lastSyncAt = new Date("2026-09-03T09:59:45.000Z").toISOString();
  const now = () => new Date("2026-09-03T10:00:00.000Z").getTime();

  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<OfflineBanner lastSyncAt={lastSyncAt} now={now} />);
  });
  expect(textOf(renderer!)).toContain("pochi istanti fa");
});
