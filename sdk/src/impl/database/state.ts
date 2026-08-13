import { DynamicAgentTemplateSchema } from '@savant-code/common/types/dynamic-agent-template'
import z from 'zod/v4'

import type {
  GetUserInfoFromApiKeyOutput,
  UserColumn,
} from '@savant-code/common/types/contracts/database'

export type CachedUserInfo = Partial<
  NonNullable<Awaited<GetUserInfoFromApiKeyOutput<UserColumn>>>
>

// Never stores null: auth failures delete the key, successes store an object.
// (FID-2026-0802-008 D9 removed the dead null branches that assumed otherwise.)
// FID-2026-0809-015: consolidated from database.ts so the {user-info,agent}
// split shares one cache instance.
export const userInfoCache: Record<string, CachedUserInfo> = {}

export const agentsResponseSchema = z.object({
  version: z.string(),
  data: DynamicAgentTemplateSchema,
})
