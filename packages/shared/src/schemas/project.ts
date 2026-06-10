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
  createdAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;
