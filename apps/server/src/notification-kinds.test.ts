import { notificationKind } from "@stubwise/db";
import { sampleEvents } from "@stubwise/notifications";
import { notificationKindSchema } from "@stubwise/shared";
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
