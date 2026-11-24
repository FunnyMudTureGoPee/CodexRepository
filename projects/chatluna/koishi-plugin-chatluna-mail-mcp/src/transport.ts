import {WorkflowError} from './workflow-policy.js'
export type DeliveryOrigin =
  | { kind: 'admin' }
  | { kind: 'agent' }
  | { kind: 'task'; taskId: string; taskHash: string; autoRetry: boolean }
export interface DeliveryOptions { origin?: DeliveryOrigin; rootDeliveryId?: string; attempt?: number }
export function failureInfo(error: unknown) {
  const e = error as {code?:unknown;responseCode?:unknown}
  const code = typeof e?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(e.code) ? e.code : 'TRANSPORT_ERROR'
  const responseCode = Number(e?.responseCode)
  const definite = ['EAUTH','ECONNECTION','EDNS','EENVELOPE'].includes(code) || (responseCode >= 400 && responseCode <= 599)
  const transient = definite && code !== 'EAUTH' && (['ECONNECTION','EDNS'].includes(code) || responseCode >= 400 && responseCode <= 499)
  return { status: definite ? 'failed' : 'unknown', errorCode: code, responseCode: Number.isFinite(responseCode) ? responseCode : undefined, transient }
}
export function safeError(error: unknown) {
  if(error instanceof WorkflowError) return error.message
  const message = error instanceof Error ? error.message : ''
  if(message==='Compatible ChatLuna conversation/preset APIs are unavailable') return message
  if (/^(Workflow|Media |Retry|Cleanup|Maintenance|Draft|Task|Context|Selected model|Preset|Conversation|Missing template|Undeclared template|Recipient|Sending|Daily sending|Hourly decision|Asset|Image|Invalid asset|Copy builtin|Template)/.test(message) && message.length < 250)
    return message
  return 'OPERATION_FAILED'
}
