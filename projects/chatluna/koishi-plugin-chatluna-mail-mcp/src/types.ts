import { z } from 'zod'
export const key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
export const address = z.string().trim().email().max(254).refine(v => !/[\r\n]/.test(v)).transform(v => v.toLowerCase())
export const mailSchema = z.object({
  to: z.array(address).min(1).max(10),
  subject: z.string().trim().min(1).max(200).refine(v => !/[\r\n]/.test(v)),
  paragraphs: z.array(z.string().trim().min(1).max(4000)).min(1).max(20),
  images: z.array(z.object({ assetId: key, alt: z.string().max(200).default(''), caption: z.string().max(500).default('') })).max(5).default([]),
  templateId: key.default('briefing'),
  variables: z.record(z.string().max(4000)).default({})
}).strict()
export type Mail = z.infer<typeof mailSchema>
const scheduledDate=z.string().datetime({offset:true})
export const taskSchema = z.object({
  id: key, name: z.string().trim().max(100).default(''), enabled: z.boolean().default(false),
  scheduleType: z.enum(['daily', 'weekly', 'once']).default('daily'),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1]),
  runAt: z.string().refine(v=>v==='' || scheduledDate.safeParse(v).success,{message:'runAt must be empty or an ISO datetime with explicit timezone'}).default('').describe('For once tasks, an ISO 8601 datetime with explicit timezone is required. For daily or weekly tasks omit this field or use an empty string.'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().default('Asia/Shanghai').refine(v => { try { new Intl.DateTimeFormat('en', {timeZone:v}); return true } catch { return false } }),
  conversationId: z.string().min(1).max(128), preset: z.string().max(100).default(''),
  model: z.string().max(200).default(''), useDefaultModel: z.boolean().default(false), prompt: z.string().min(1).max(8000),
  to: z.array(address).min(1).max(10), templateId: key.default('briefing'),
  variables: z.record(z.string().max(4000)).default({}), historyLimit: z.number().int().min(1).max(200).default(60),
  retryOnFailure: z.boolean().default(false),
  executionMode:z.enum(['context','tools']).default('context'),
  tools:z.array(z.string().min(1).max(128)).max(12).default([]),
  workflowImages:z.boolean().default(false),
  toolFailurePolicy:z.enum(['stop','continue']).default('stop'),
  contextMode: z.enum(['recent','since-last-send']).default('recent'),
  contextMaxAgeHours: z.number().int().min(0).max(8760).default(0),
  minNewMessages: z.number().int().min(0).max(100).default(0),
  contextOverflow: z.enum(['reject','trim-oldest']).default('reject'),
  cooldownMinutes: z.number().int().min(1).max(10080).default(60)
}).strict().superRefine((v, c) => {
  if(v.executionMode==='tools' && !v.tools.length && !v.workflowImages) c.addIssue({code:'custom',message:'Select at least one workflow tool or enable workflow images'})
  if (v.scheduleType === 'once' && !v.runAt) c.addIssue({code:'custom',message:'runAt with explicit timezone is required for once tasks'})
})
export type Task = z.infer<typeof taskSchema>
export interface Config {
  endpoint: string; token: string; enabled: boolean; allowAgentSend: boolean; allowedRecipients: string[];
  smtpHost: string; smtpPort: number; smtpSecure: boolean; smtpUser: string; smtpPassword: string; from: string;
  maxPerDay: number; modelTimeoutMs: number; maxContextChars: number;
  allowAgentManage?: boolean;
  autoRetryEnabled?: boolean; maxRetryAttempts?: number; retryDelayMinutes?: number;
  cleanupEnabled?: boolean; retentionDays?: number; maxDecisionsPerHour?: number;
}
export interface Entry { id: string; kind: string; status: string; payload: string; hash: string; createdAt: Date; updatedAt: Date }
declare module 'koishi' { interface Tables { chatluna_mail: Entry } }
export interface Asset { id: string; name: string; mime: string; bytes: number; pinned?: boolean }
export interface Decision {
  shouldSend: boolean; reason: string;
  mail?: Omit<Mail, 'to' | 'templateId'>;
}
export const decisionSchema = z.object({
  shouldSend: z.boolean(), reason: z.string().min(1).max(1000),
  mail: mailSchema.omit({to:true, templateId:true, variables:true}).optional()
}).strict().superRefine((v, c) => { if(v.shouldSend && !v.mail) c.addIssue({code:'custom',message:'mail is required when shouldSend=true'}) })
