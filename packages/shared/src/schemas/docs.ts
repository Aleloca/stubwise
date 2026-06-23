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

/**
 * Stato di un nodo del DAG di documentazione ricorsivo: "pending" (creato,
 * claimabile per esplorazione), "exploring" (in esplorazione), "awaiting_children"
 * (ramo che attende i figli), "ready_to_synthesize" (figli completati, claimabile
 * per sintesi), "synthesizing" (in sintesi), "done" / "failed" (terminali). Fonte
 * di verità condivisa tra db (enum `doc_node_status`) e worker.
 */
export const docNodeStatusSchema = z.enum([
  "pending",
  "exploring",
  "awaiting_children",
  "ready_to_synthesize",
  "synthesizing",
  "done",
  "failed",
]);
export type DocNodeStatus = z.infer<typeof docNodeStatusSchema>;

/**
 * Albero di appartenenza di un nodo di documentazione: "technical" (registro
 * tecnico/dev) o "functional" (registro funzionale/business). Fonte di verità
 * condivisa tra db (enum `doc_tree`) e worker.
 */
export const docTreeSchema = z.enum(["technical", "functional"]);
export type DocTree = z.infer<typeof docTreeSchema>;
