/**
 * @format
 */

import { ticketStatusSchema } from "@stubwise/shared";
import ReactTestRenderer from "react-test-renderer";
import type { ReactTestRendererJSON } from "react-test-renderer";
import App from "../App";

type Node = ReactTestRendererJSON | string | null;

function collectText(node: Node | Node[]): string[] {
  if (node === null) return [];
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(collectText);
  return collectText((node.children ?? []) as Node[]);
}

test("mostra il numero di stati ticket esposti da @stubwise/shared", async () => {
  // L'import in cima è già la prova che Metro/Jest risolvono il package del
  // workspace: se non lo risolvessero, il modulo non si caricherebbe. Qui si
  // verifica solo che l'app renda quel numero, senza inchiodare apps/mobile al
  // contenuto dell'enum (aggiungere uno stato non deve rompere questo test).
  expect(ticketStatusSchema.options.length).toBeGreaterThan(0);
  const expected = String(ticketStatusSchema.options.length);

  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });

  expect(collectText(renderer?.toJSON() ?? null)).toContain(expected);
});
