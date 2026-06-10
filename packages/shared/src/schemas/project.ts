import { z } from "zod";

export const gitProviderKindSchema = z.enum(["bitbucket", "github"]);
export type GitProviderKind = z.infer<typeof gitProviderKindSchema>;

export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  provider: gitProviderKindSchema,
  repoUrl: z.url(),
  defaultBranch: z.string().min(1),
  ingestionKey: z.string().min(1),
  // Segreto HMAC del webhook git: esposto solo via API admin, serve a
  // configurare il webhook lato provider. Stringa vuota = non ancora generato
  // (righe legacy): i webhook vengono rifiutati finché resta vuoto.
  webhookSecret: z.string(),
  createdAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;
