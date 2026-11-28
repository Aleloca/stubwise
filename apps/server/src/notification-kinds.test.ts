import { notificationKind } from "@stubwise/db";
import { sampleEvents, type ActionId } from "@stubwise/notifications";
import { inboxActionSchema, notificationKindSchema, type InboxAction } from "@stubwise/shared";
import { describe, expect, it } from "vitest";

/**
 * Parità dei `kind` di notifica fra le TRE liste che li dichiarano:
 *
 *  1. l'enum Postgres `notification_kind` (`@stubwise/db`),
 *  2. l'unione `NotificationEvent["kind"]` (`@stubwise/notifications`),
 *  3. `notificationKindSchema` (`@stubwise/shared`), il contratto HTTP.
 *
 * Sono tre perché non possono essere una: `@stubwise/shared` finisce nel bundle
 * browser e dipende dal solo `zod` (non può importare né drizzle né il motore
 * delle notifiche). Il commento in `schemas/notification.ts` dice "vanno tenute
 * allineate a mano": questo test è ciò che rende quel "a mano" verificabile.
 *
 * Vive nel SERVER perché è l'unico posto dove tutti e tre i package sono
 * importabili insieme (nessun altro li ha tutti fra le dipendenze).
 *
 * La lista di `@stubwise/notifications` si legge da `sampleEvents`, che espone
 * un evento per kind ed è a sua volta verificata esaustiva dal test del
 * package: `NotificationKind` è un tipo, non esiste a runtime.
 */
describe("parità dei kind di notifica", () => {
  const sharedKinds = [...notificationKindSchema.options].sort();

  it("shared e @stubwise/notifications dichiarano gli stessi kind", () => {
    const eventKinds = [
      ...new Set(sampleEvents("https://app.example.com").map((event) => event.kind)),
    ].sort();
    expect(sharedKinds).toEqual(eventKinds);
  });

  it("shared e l'enum Postgres notification_kind dichiarano gli stessi kind", () => {
    expect(sharedKinds).toEqual([...notificationKind.enumValues].sort());
  });
});

/**
 * Parità delle AZIONI d'inbox fra le liste che le dichiarano: `ActionId`
 * (`@stubwise/notifications`, il catalogo) e `inboxActionSchema`
 * (`@stubwise/shared`, il contratto HTTP). Stessa ragione dei kind:
 * `@stubwise/shared` non può importare il motore delle notifiche. (Fino a R2
 * c'era una terza lista, gli `action_id` dei bottoni Slack.)
 */
describe("parità delle azioni d'inbox", () => {
  it("shared e il catalogo dichiarano la stessa unione (parità di TIPO)", () => {
    // Le due assegnazioni compilano solo se le unioni coincidono in ENTRAMBI i
    // versi: è il typecheck a fare il test, l'expect a runtime è solo la prova
    // che il caso è stato eseguito.
    const daShared: ActionId[] = [...inboxActionSchema.options];
    const daCatalogo: InboxAction[] = daShared;
    expect(daCatalogo).toEqual([...inboxActionSchema.options]);
  });

});
