const assert = require('node:assert/strict')
const { Context } = require('koishi')
const memory = require('@koishijs/plugin-database-memory').default
const server = require('@koishijs/plugin-server').default
const plugin = require('../lib/index.cjs')
;(async () => {
  assert.equal(typeof plugin.apply, 'function')
  const ctx = new Context()
  ctx.plugin(memory)
  const fork = ctx.plugin(server, {host:'127.0.0.1',port:0})
  const config = plugin.Config({token:'smoke-token-only-at-least-24-characters'})
  assert.equal(config.enabled,false)
  assert.equal(config.allowAgentSend,false)
  ctx.plugin(plugin,config)
  try {
    await ctx.start()
    assert.ok(ctx.model.tables.chatluna_mail)
    assert.ok(ctx.$commander.get('mail.status'))
    console.log('Built plugin loaded; schema defaults, database model and admin commands verified. No SMTP or LLM call.')
  } finally {await fork.dispose();await ctx.stop()}
})().catch(error=>{console.error(error);process.exitCode=1})
