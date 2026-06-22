import { z } from "zod";

/**
 * Tipo di pagina di documentazione: "technical" (registro tecnico/dev),
 * "functional" (registro funzionale/business) — entrambi autogenerati — o
 * "manual" (pagina curata a mano, non toccata dalla rigenerazione). Fonte di
 * verità condivisa tra db (enum `doc_page_kind`), server (validazione) e web.
 */
export const docPageKindSchema = z.enum(["technical", "functional", "manual"]);
export type DocPageKind = z.infer<typeof docPageKindSchema>;

/**
 * Stato di una generazione di documentazione: "pending" (creata, non ancora
 * avviata), "running" (in corso), "succeeded" / "failed" (terminali).
 */
export const docGenerationStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
]);
export type DocGenerationStatus = z.infer<typeof docGenerationStatusSchema>;

/**
 * Origine di una generazione: "manual" (avviata da un umano) o "push"
 * (innescata da un evento push del repo, fase 2 — già predisposta nello schema).
 */
export const docGenerationTriggerSchema = z.enum(["manual", "push"]);
export type DocGenerationTrigger = z.infer<typeof docGenerationTriggerSchema>;

/**
 * Stato di un job di doc-generation (project-scoped, coda dedicata): "queued",
 * "running", "succeeded", "failed", "held" (parcheggiato, es. cap di costo).
 */
export const docJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "held",
]);
export type DocJobStatus = z.infer<typeof docJobStatusSchema>;
