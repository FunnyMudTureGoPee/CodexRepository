import type { MailService } from './service.js'
import { occurrence } from './schedule.js'
export { localMinute } from './schedule.js'
export class Scheduler {
  private busy = false
  constructor(readonly service: MailService) {}
  async tick(now = new Date()) {
    if (this.busy || this.service.stopped || !this.service.config.enabled) return
    this.busy = true
    try {
      const due: Array<{ id: string; key: string }> = []
      for (const row of await this.service.repo.list('task')) {
        try {
          const task = await this.service.task(row.id.slice(5))
          if (!task.enabled) continue
          const key = occurrence(task, now)
          if (key) due.push({ id: task.id, key })
        } catch {
          this.service.ctx.logger('chatluna-mail-mcp').warn('Invalid stored mail task: %s', row.id)
        }
      }
      // Independent due tasks must not block each other's scheduled minute.
      await Promise.allSettled(due.map(task => this.service.evaluate(task.id, task.key)))
    } finally { this.busy = false }
  }
}
