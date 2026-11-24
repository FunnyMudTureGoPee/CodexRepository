import { z } from 'zod'
import type { Mail } from './types.js'
import { key } from './types.js'
import type { Repository } from './repository.js'

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
export const templateSchema = z.object({
  id: key,
  name: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(8000),
  fields: z.record(key, z.object({
    required: z.boolean().default(false),
    default: z.string().max(4000).default(''),
  }).strict()).default({}),
  layout: z.object({
    accent: color.default('#2563eb'), background: color.default('#ffffff'),
    textColor: color.default('#1f2937'), width: z.number().int().min(320).max(800).default(640),
    heading: z.boolean().default(true), footer: z.string().max(2000).default(''),
  }).strict().default({}),
}).strict()
export type Template = z.infer<typeof templateSchema> & { version: number }
export const templates: Template[] = [
  { id: 'briefing', name: '图文简报', prompt: '根据提供的事实生成简洁图文邮件。输出 subject、paragraphs、images；图片只引用已提供的 assetId，不虚构事实或图片。' },
  { id: 'notice', name: '事项提醒', prompt: '说明需要提醒的事项、时间和下一步。输出 subject、paragraphs、images，资料不足时不要编造。' },
  { id: 'plain', name: '文字通知', prompt: '用简洁文字说明情况。输出 subject、paragraphs，images 使用空数组。' },
].map(t => ({ ...templateSchema.parse(t), version: 1 }))

export function substitute(source: string, template: Template, values: Record<string, string> = {}) {
  for (const [name, field] of Object.entries(template.fields)) {
    if (field.required && !(values[name] ?? field.default).trim()) throw new Error('Missing template variable: ' + name)
  }
  return source.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_match, name: string) => {
    const field = template.fields[name]
    if (!field) throw new Error('Undeclared template variable: ' + name)
    return values[name] ?? field.default
  })
}
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export function render(mail: Mail, selected?: Template) {
  const template = selected ?? templates.find(t => t.id === mail.templateId)
  if (!template) throw new Error('Template not found')
  // Preserve the exact builtin v1 layout used by 0.1.0 drafts.
  if (['briefing','notice','plain'].includes(template.id) && template.version === 1) {
    const text = [mail.subject, ...mail.paragraphs, ...mail.images.map(i => [i.alt,i.caption].filter(Boolean).join('：'))].join('\n\n')
    const paragraphs = mail.paragraphs.map(p => '<p>'+escapeHtml(p).replace(/\n/g,'<br>')+'</p>').join('')
    const images = mail.images.map((i,n) => '<figure style="margin:16px 0"><img style="max-width:100%;height:auto" src="cid:image-'+n+'@chatluna-mail" alt="'+escapeHtml(i.alt)+'"><figcaption>'+escapeHtml(i.caption)+'</figcaption></figure>').join('')
    return {text,html:'<!doctype html><html><body><main style="max-width:640px;margin:auto;font-family:Arial,sans-serif;line-height:1.7"><h1>'+escapeHtml(mail.subject)+'</h1>'+paragraphs+images+'</main></body></html>'}
  }
  const { footer, ...layout } = template.layout
  const footerText = substitute(footer, template, mail.variables)
  const text = [mail.subject, ...mail.paragraphs, ...mail.images.map(i => [i.alt, i.caption].filter(Boolean).join('：')), footerText].filter(Boolean).join('\n\n')
  const paragraphs = mail.paragraphs.map(p => '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('')
  const images = mail.images.map((i, n) => '<figure style="margin:16px 0"><img style="max-width:100%;height:auto" src="cid:image-' + n + '@chatluna-mail" alt="' + escapeHtml(i.alt) + '"><figcaption>' + escapeHtml(i.caption) + '</figcaption></figure>').join('')
  const heading = layout.heading ? '<h1 style="color:' + layout.accent + '">' + escapeHtml(mail.subject) + '</h1>' : ''
  const foot = footerText ? '<footer style="border-top:1px solid #dddddd;margin-top:24px;padding-top:12px">' + escapeHtml(footerText).replace(/\n/g, '<br>') + '</footer>' : ''
  return { text, html: '<!doctype html><html><body><main style="max-width:' + layout.width + 'px;margin:auto;padding:24px;font-family:Arial,sans-serif;line-height:1.7;background:' + layout.background + ';color:' + layout.textColor + '">' + heading + paragraphs + images + foot + '</main></body></html>' }
}

export class TemplateStore {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(readonly repo: Repository) {}
  async list(): Promise<Template[]> {
    return [...templates, ...(await this.repo.list('template')).map(e => JSON.parse(e.payload) as Template)]
  }
  async get(id: string): Promise<Template> {
    const builtin = templates.find(t => t.id === id)
    if (builtin) return structuredClone(builtin)
    const row = await this.repo.get('template:' + id)
    if (!row) throw new Error('Template not found')
    return JSON.parse(row.payload)
  }
  async save(input: unknown, expectedVersion?: number): Promise<Template> {
    const action = async () => {
      const value = templateSchema.parse(input)
      if (templates.some(t => t.id === value.id)) throw new Error('Copy builtin template with a new ID before editing')
      const prior = await this.repo.get('template:' + value.id)
      const previous = prior ? JSON.parse(prior.payload).version as number : 0
      if (expectedVersion !== undefined && previous !== expectedVersion) throw new Error('Template version conflict; refresh before saving')
      const result = { ...value, version: previous + 1 }
      // Validate placeholders at save time, allowing required fields to be filled later.
      const sample = Object.fromEntries(Object.keys(value.fields).map(k => [k, 'sample']))
      substitute(value.prompt + value.layout.footer, result, sample)
      await this.repo.put('template-version:' + value.id + ':' + result.version, 'template-version', 'ready', result)
      await this.repo.put('template:' + value.id, 'template', 'ready', result)
      return result
    }
    const next = this.tail.then(action, action)
    this.tail = next.catch(() => {})
    return next
  }
}
