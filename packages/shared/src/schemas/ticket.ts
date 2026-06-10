import { z } from "zod";

export const ticketStatusSchema = z.enum([
  "open",
  "triaged",
  "in_progress",
  "in_review",
  "done",
  "closed",
]);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

export const ticketTypeSchema = z.enum(["bug", "feature", "task", "feedback"]);
export type TicketType = z.infer<typeof ticketTypeSchema>;

export const ticketPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;

export const ticketSourceSchema = z.enum(["manual", "sdk_error", "sdk_feedback", "api"]);
export type TicketSource = z.infer<typeof ticketSourceSchema>;
