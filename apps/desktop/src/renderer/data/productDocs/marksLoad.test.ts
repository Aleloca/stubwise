import { beforeEach, expect, it } from "vitest";
import type { ProductBlock } from "../model";
import { resetStore, state } from "../store";
import { withoutSeed11b } from "../seed/productDocs/without11b";
import { listProductMarksAs } from "./marks";
import { writeProductBlocksAs } from "./writes";

// Il segno si sposta con un'unione anche quando nessuno ha caricato
// `productDocs/index.ts` né `api.ts` (review del Task 3): lo sposta la stessa
// scrittura che lo crea, non un ascoltatore che dipende da cosa è stato
// importato. Questo file importa apposta solo `writes.ts` e `marks.ts`.

const LAURA = "p-laura";
const MARCO = "p-marco";
const PAGE = "pp-acq-sign-in";
const HEADING = "blk-acq-signin-3";
const STORES = "blk-acq-signin-4";

beforeEach(() => {
  resetStore();
  // Sign-in senza il segno di Claude del seme 11b.
  withoutSeed11b();
});

it("un'unione porta il segno sul blocco unito senza l'indice del modulo", () => {
  const page = state.productPages.find((p) => p.id === PAGE)!;
  const stores = page.blocks.find((b) => b.id === STORES)!;
  writeProductBlocksAs(
    LAURA,
    PAGE,
    [{ op: "set", block: { ...stores, content: { text: "Only the name.", marks: [] } } as ProductBlock }],
    { kind: "edit", via: "claude", source: { kind: "task", id: "t-acq-7" }, groupId: "pgrp-load" },
  );
  writeProductBlocksAs(MARCO, PAGE, [{ op: "merge", firstId: HEADING, secondId: STORES }], { sessionId: "s-m" });
  expect(listProductMarksAs(LAURA, PAGE).map((m) => m.anchorId)).toEqual([HEADING]);
});

// Revisione del lotto 2 (minor): il segno di Claude dice per chi ha agito
// col segnaposto di chi guarda non conosce (r.1414).
it("il segno di una revisione di uno sconosciuto: `actorId` e `onBehalfOfId` segnaposti", async () => {
  resetStore();
  const { strangersTo } = await import("../../test/strangers");
  const [mark] = listProductMarksAs(LAURA, PAGE);
  expect(mark).toBeDefined();
  const [who] = strangersTo(LAURA);
  state.productRevisions.find((r) => r.id === mark!.revisionId)!.actorId = who!;
  const [out] = listProductMarksAs(LAURA, PAGE);
  expect(out!.actorId).toMatch(/^hidden-\d+$/);
  expect(out!.onBehalfOfId).toBe(out!.actorId);
  expect(JSON.stringify(listProductMarksAs(LAURA, PAGE))).not.toContain(who!);
});
