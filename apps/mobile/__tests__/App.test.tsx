/**
 * @format
 */

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
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });

  // Il conteggio reale di ticketStatusSchema: open, triaged, in_progress,
  // in_review, done, closed. Asserendo il letterale (e non
  // ticketStatusSchema.options.length) il test fallisce davvero se l'import del
  // package workspace smette di funzionare o se l'enum cambia.
  expect(collectText(renderer?.toJSON() ?? null)).toContain("6");
});
