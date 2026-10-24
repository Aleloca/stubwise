import type { DocPage } from "../types";

// Alcune pagine dei Docs dei progetti con un repository (STW, AUD) e di un
// progetto cliente: quanto basta perché Claude le citi e ci cerchi dentro.
// I progetti senza il modulo Docs non ne hanno.

// [id, codice progetto, titolo, percorso, estratto]
type Row = [string, string, string, string, string];

// prettier-ignore
const ROWS: Row[] = [
  ["doc-aud-callbacks", "AUD", "Scheduled callbacks", "Guide / Dialer", "A callback is stored in UTC and shown in the timezone of the workspace. Reminders go out 10 minutes before, by email and in the app."],
  ["doc-aud-import", "AUD", "Importing contacts", "Guide / Contacts", "The CSV import matches duplicates by email first, then by phone number. Rows that match an existing contact are shown in the preview before anything is saved."],
  ["doc-aud-billing", "AUD", "Invoices and billing emails", "Guide / Billing", "Invoices are issued on the first working day of the month. The billing email uses the invoice layout of the workspace and attaches the PDF."],
  ["doc-aud-export", "AUD", "Exporting the call history", "Guide / Reports", "The export covers the selected period and the filters in use. Large exports are prepared in the background and arrive by email."],
  ["doc-stw-stalled", "STW", "How stalled tasks work", "Guide / Tasks", "A task is stalled when nobody touched it for longer than the project threshold, when it waits for a decision or for an answer to Claude, or when someone marked it by hand."],
  ["doc-stw-planning", "STW", "Weekly planning", "Guide / Planning", "Each task can be planned for a week; a task that ends the week open slips to the next one and its counter grows."],
  ["doc-stw-selfhost", "STW", "Self-hosted upgrades", "Operations / Upgrades", "Pull the new images, then restart the server before the worker: migrations run when the server starts."],
  ["doc-stw-notifications", "STW", "Notifications and quiet hours", "Guide / Notifications", "Notifications arrive in the inbox and, when enabled, as push messages. Quiet hours are not available yet."],
  ["doc-cbv-shipping", "CBV", "Shipping rules", "Store / Shipping", "Orders over 6 bottles ship free in Italy. Gift boxes are packed by hand and add one working day."],
];

export const DOC_PAGES: DocPage[] = ROWS.map(([id, code, title, path, excerpt]) => ({
  id,
  projectId: `prj-${code.toLowerCase()}`,
  title,
  path,
  excerpt,
}));
