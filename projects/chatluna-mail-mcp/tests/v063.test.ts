import test from 'node:test'
import assert from 'node:assert/strict'
import {taskSchema} from '../src/types.js'
test('Gemini compatible runAt string retains date validation and old task defaults',()=>{
 const base={id:'test',time:'09:00',conversationId:'conv',prompt:'test',to:['a@example.com']}
 assert.equal(taskSchema.parse(base).runAt,'')
 assert.equal(taskSchema.parse({...base,runAt:''}).runAt,'')
 const date='2026-10-20T09:00:00+08:00'
 assert.equal(taskSchema.parse({...base,scheduleType:'once',runAt:date}).runAt,date)
 for(const value of ['bad-date','2026-10-20T09:00:00','2026-10-20T27:00:00+08:00']) assert.throws(()=>taskSchema.parse({...base,runAt:value}))
 assert.throws(()=>taskSchema.parse({...base,scheduleType:'once',runAt:''}))
 assert.throws(()=>taskSchema.parse({...base,scheduleType:'once'}))
})
