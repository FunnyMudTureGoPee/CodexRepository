import { randomUUID } from 'node:crypto'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { Context } from 'koishi'
import type {} from '@koishijs/plugin-server'
import { z } from 'zod'

import { LyricsRepository } from './repository.js'
import { LyricsSemanticIndex } from './semantic.js'
import type { PluginConfig } from './types.js'

export function isLoopbackAddress(address: string) {
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
}

function json(value: unknown) {
    return {
        content: [
            {
                type: 'text' as const,
                text: JSON.stringify(value, null, 2)
            }
        ]
    }
}

function createServer(
    repo: LyricsRepository,
    semantic: LyricsSemanticIndex,
    config: PluginConfig
) {
    const server = new McpServer({
        name: 'chatluna-lyrics',
        version: '0.1.1'
    })

    server.registerTool(
        'search_songs',
        {
            description:
                'Search the local lyrics database by title, artist, album, or an exact lyrics fragment. Returns summaries, not complete lyrics.',
            inputSchema: {
                query: z.string().trim().min(1).optional(),
                title: z.string().trim().min(1).optional(),
                artist: z.string().trim().min(1).optional(),
                album: z.string().trim().min(1).optional(),
                searchLyrics: z.boolean().default(false),
                limit: z.number().int().min(1).max(config.maxResults).default(10)
            }
        },
        async (input) => json(await repo.search(input))
    )

    server.registerTool(
        'get_lyrics',
        {
            description:
                'Get the complete lyrics for one song returned by search_songs.',
            inputSchema: {
                songId: z.string().trim().min(1),
                format: z.enum(['plain', 'lrc']).default('plain')
            }
        },
        async (input) => {
            const song = await repo.song(input.songId)
            if (!song) throw new Error('Song not found in the active dataset')
            return json({
                id: song.id,
                title: song.title,
                artist: song.artist,
                album: song.album,
                language: song.language,
                lyrics:
                    input.format === 'lrc' ? song.lyricsRaw : song.lyricsPlain,
                format: input.format
            })
        }
    )

    server.registerTool(
        'get_lyrics_database_status',
        {
            description:
                'Get the active lyrics dataset version, song count, update time, and semantic index status.',
            inputSchema: {}
        },
        async () => json(await repo.status())
    )

    return semantic.available().then((ready) => {
        if (ready) {
            server.registerTool(
                'semantic_search_lyrics',
                {
                    description:
                        'Search lyrics by semantic meaning using the configured ChatLuna embeddings and vector store.',
                    inputSchema: {
                        query: z.string().trim().min(1),
                        limit: z
                            .number()
                            .int()
                            .min(1)
                            .max(config.maxResults)
                            .default(10)
                    }
                },
                async (input) =>
                    json(await semantic.search(input.query, input.limit))
            )
        }
        return server
    })
}

export function registerMcp(
    ctx: Context,
    repo: LyricsRepository,
    semantic: LyricsSemanticIndex,
    config: PluginConfig
) {
    const sessions = new Map<
        string,
        { server: McpServer; transport: StreamableHTTPServerTransport }
    >()

    ctx.server.all(config.endpoint, async (web) => {
        const remote = web.req.socket.remoteAddress ?? ''
        if (!config.allowRemote && !isLoopbackAddress(remote)) {
            web.status = 403
            web.body = { error: 'Remote MCP access is disabled' }
            return
        }
        if (
            config.token &&
            web.headers.authorization !== `Bearer ${config.token}`
        ) {
            web.status = 401
            web.body = { error: 'Invalid bearer token' }
            return
        }

        // This server never sends unsolicited notifications. Explicitly reject
        // the optional standalone SSE stream so clients do not keep an idle GET
        // connection that an HTTP server or proxy may close periodically.
        if (web.method === 'GET') {
            web.status = 405
            web.set('Allow', 'POST, DELETE')
            web.body = {
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'SSE notifications are not supported'
                },
                id: null
            }
            return
        }

        const body = web.request.body
        const id = web.headers['mcp-session-id']
        let session = typeof id === 'string' ? sessions.get(id) : undefined

        if (web.method === 'POST' && isInitializeRequest(body)) {
            const server = await createServer(repo, semantic, config)
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: randomUUID,
                enableJsonResponse: true,
                onsessioninitialized: (sessionId) => {
                    sessions.set(sessionId, { server, transport })
                }
            })
            transport.onclose = () => {
                if (transport.sessionId) sessions.delete(transport.sessionId)
            }
            await server.connect(transport)
            session = { server, transport }
        }

        if (!session) {
            web.status = 400
            web.body = { error: 'Missing or invalid MCP session' }
            return
        }

        web.respond = false
        await session.transport.handleRequest(web.req, web.res, body)
    })

    ctx.on('dispose', async () => {
        await Promise.all(
            [...sessions.values()].map(async (session) => {
                await session.transport.close()
                await session.server.close()
            })
        )
        sessions.clear()
    })
}
