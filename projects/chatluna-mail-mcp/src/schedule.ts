import type { Task } from './types.js'

const formats = new Map<string, Intl.DateTimeFormat>()
export function localMinute(date: Date, timezone: string) {
  let formatter = formats.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    })
    formats.set(timezone, formatter)
  }
  const p = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
  const weekdays: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
  return { day: p.year + '-' + p.month + '-' + p.day, time: p.hour + ':' + p.minute, weekday: weekdays[p.weekday]! }
}

export function occurrence(task: Task, now: Date): string | undefined {
  if (task.scheduleType === 'once') {
    // Only the scheduled minute is eligible; no restart catch-up.
    const target = new Date(task.runAt).getTime()
    if (Math.floor(now.getTime() / 60000) === Math.floor(target / 60000)) return 'once-' + target
    return
  }
  const local = localMinute(now, task.timezone)
  if (local.time !== task.time) return
  if (task.scheduleType === 'weekly' && !task.weekdays.includes(local.weekday)) return
  return local.day
}

export function nextOccurrence(task: Task, now = new Date()): string | null {
  if (!task.enabled) return null
  if (task.scheduleType === 'once') {
    return new Date(task.runAt).getTime() > now.getTime() ? new Date(task.runAt).toISOString() : null
  }
  // UTC-minute search handles non-hour offsets, DST gaps and duplicated wall times.
  const start = Math.floor(now.getTime() / 60000) * 60000 + 60000
  for (let minute = 0; minute < 8 * 1440; minute++) {
    const at = new Date(start + minute * 60000)
    if (occurrence(task, at)) return at.toISOString()
  }
  return null
}
