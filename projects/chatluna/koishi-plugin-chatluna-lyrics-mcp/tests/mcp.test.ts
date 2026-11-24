import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as memoryModule from '@koishijs/plugin-database-memory'
import * as serverModule from '@koishijs/plugin-server'
import { Context } from 'koishi'

import { LyricsImporter } from '../src/importer.js'
import { isLoopbackAddress, registerMcp } from '../src/mcp.js'
import { registerModels } from '../src/index.js'
import { LyricsRepository } from '../src/repository.js'
import { LyricsSemanticIndex } from '../src/semantic.js'
import type { PluginConfig } from '../src/types.js'

const config: PluginConfig = {
    endpoint: '/mcp/lyrics',
    token: 'test-token',
    allowRemote: false,
    queryTimeoutMs: 3000,
    maxResults: 20,
    retainVersions: 1,
    semanticEnabled: false,
    embeddings: '',
    vectorStore: 'luna-vdb',
    semanticChunkChars: 600,
    semanticMaxChunksPerSong: 4,
    semanticBatchSize: 30
}

async function freePort() {
    return new Promise<number>((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (!address || typeof address === 'string') {
                reject(new Error('Unable to reserve a test port'))
                return
            }
            server.close(() => resolve(address.port))
        })
    })
}

test('loopback guard recognizes only local addresses', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true)
    assert.equal(isLoopbackAddress('::1'), true)
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackAddress('192.168.1.2'), false)
})

test('serves read-only MCP tools and enforces bearer auth', { timeout: 20000 }, async () => {
    const port = await freePort()
    const ctx = new Context()
    const memory = memoryModule.default ?? memoryModule
    const server = serverModule.default ?? serverModule
    ctx.plugin(memory as never)
    ctx.plugin(server as never, { host: '127.0.0.1', port } as never)
    registerModels(ctx)
    await ctx.start()

    const repo = new LyricsRepository(ctx, config)
    const semantic = new LyricsSemanticIndex(ctx, repo)
    registerMcp(ctx, repo, semantic, config)
    const dir = await mkdtemp(join(tmpdir(), 'lyrics-mcp-'))
    const source = join(dir, 'songs.jsonl')
    await writeFile(
        source,
        `${JSON.stringify({
            id: 'mcp-song',
            title: 'MCP Song',
            artist: 'Local Singer',
            lyrics: '[00:01.00]A searchable local line'
        })}\n`,
        'utf8'
    )
    await new LyricsImporter(repo).import(source, 'replace')

    const url = `http://127.0.0.1:${port}${config.endpoint}`
    const denied = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'auth-test', version: '1.0.0' }
            }
        })
    })
    assert.equal(denied.status, 401)

    const client = new Client({ name: 'lyrics-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
            headers: { authorization: `Bearer ${config.token}` }
        }
    })
    try {
        await client.connect(transport)
        const sessionId = transport.sessionId
        assert.ok(sessionId)
        const sse = await fetch(url, {
            method: 'GET',
            headers: {
                accept: 'text/event-stream',
                authorization: `Bearer ${config.token}`,
                'mcp-session-id': sessionId
            }
        })
        assert.equal(sse.status, 405)
        assert.equal(sse.headers.get('allow'), 'POST, DELETE')

        const tools = await client.listTools()
        assert.deepEqual(
            tools.tools.map((tool) => tool.name).sort(),
            ['get_lyrics', 'get_lyrics_database_status', 'search_songs']
        )
        const invalid = await client.callTool({
            name: 'search_songs',
            arguments: {}
        })
        assert.equal(invalid.isError, true)
        const status = await client.callTool({
            name: 'get_lyrics_database_status',
            arguments: {}
        })
        assert.equal(status.isError, undefined)
        const search = await client.callTool({
            name: 'search_songs',
            arguments: { query: 'MCP Song' }
        })
        const searchContent = search.content as Array<{
            type: string
            text?: string
        }>
        const searchText = searchContent[0]
        assert.equal(searchText?.type, 'text')
        const matches = JSON.parse(
            searchText?.type === 'text' ? (searchText.text ?? '[]') : '[]'
        ) as Array<{ id: string }>
        assert.equal(matches.length, 1)

        const lyrics = await client.callTool({
            name: 'get_lyrics',
            arguments: { songId: matches[0]?.id, format: 'plain' }
        })
        const lyricsContent = lyrics.content as Array<{
            type: string
            text?: string
        }>
        const lyricsText = lyricsContent[0]
        assert.match(
            lyricsText?.type === 'text' ? (lyricsText.text ?? '') : '',
            /searchable local line/
        )
    } finally {
        await client.close()
        await new Promise<void>((resolve) => {
            const http = (ctx.server as unknown as {
                _http: { close(callback: () => void): void }
            })._http
            http.close(() => resolve())
        })
        await semantic.close()
    }
})
