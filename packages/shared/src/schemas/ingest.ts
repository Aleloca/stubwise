import { z } from "zod";
import { ticketPrioritySchema, ticketTypeSchema } from "./ticket.js";

export const breadcrumbSchema = z.object({
  type: z.enum(["click", "navigation", "fetch", "log"]),
  message: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
});
export type Breadcrumb = z.infer<typeof breadcrumbSchema>;

export const errorEventSchema = z.object({
  kind: z.literal("error"),
  message: z.string().min(1),
  errorType: z.string().optional(),
  stack: z.string().optional(),
  url: z.string().optional(),
  release: z.string().optional(),
  environment: z.string().optional(),
  breadcrumbs: z.array(breadcrumbSchema).max(30),
  timestamp: z.iso.datetime({ offset: true }),
});
export type ErrorEvent = z.infer<typeof errorEventSchema>;

export const feedbackEventSchema = z.object({
  kind: z.literal("feedback"),
  message: z.string().min(1),
  email: z.email().optional(),
  url: z.string().optional(),
  release: z.string().optional(),
});
export type FeedbackEvent = z.infer<typeof feedbackEventSchema>;

export const ticketCreateEventSchema = z.object({
  kind: z.literal("ticket"),
  title: z.string().min(1),
  body: z.string().optional(),
  type: ticketTypeSchema,
  priority: ticketPrioritySchema,
});
export type TicketCreateEvent = z.infer<typeof ticketCreateEventSchema>;

export const ingestEventSchema = z.discriminatedUnion("kind", [
  errorEventSchema,
  feedbackEventSchema,
  ticketCreateEventSchema,
]);
export type IngestEvent = z.infer<typeof ingestEventSchema>;

export const ingestBatchSchema = z.object({
  events: z.array(ingestEventSchema).max(100),
});
export type IngestBatch = z.infer<typeof ingestBatchSchema>;
