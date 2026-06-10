import { z } from "zod";

export const gitProviderSchema = z.enum(["bitbucket", "github"]);
export type GitProvider = z.infer<typeof gitProviderSchema>;

export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  provider: gitProviderSchema,
  repoUrl: z.url(),
  defaultBranch: z.string().min(1),
  ingestionKey: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;
