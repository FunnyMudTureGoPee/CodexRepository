import type { Context, Query } from 'koishi'

import {
    literalRegex,
    lyricSnippet,
    normalizeText,
    prefixRegex
} from './text.js'
import type {
    LyricsDataset,
    LyricsSong,
    LyricsStatus,
    SearchInput,
    SongMatch,
    PluginConfig
} from './types.js'

export class LyricsRepository {
    constructor(
        readonly ctx: Context,
        readonly config: PluginConfig
    ) {}

    get db() {
        return this.ctx.database
    }

    async active() {
        return (
            await this.db.get(
                'chatluna_lyrics_dataset',
                { status: 'active' },
                { limit: 1, sort: { importedAt: 'desc' } }
            )
        )[0]
    }

    async status(): Promise<LyricsStatus> {
        const dataset = await this.active()
        if (!dataset) {
            return {
                active: false,
                songCount: 0,
                semantic: {
                    enabled: this.config.semanticEnabled,
                    status: 'disabled'
                },
                formats: ['csv', 'jsonl', 'lrc-directory']
            }
        }
        return {
            active: true,
            datasetId: dataset.id,
            version: dataset.version,
            songCount: dataset.songCount,
            importedAt: dataset.importedAt.toISOString(),
            source: dataset.source,
            semantic: {
                enabled: this.config.semanticEnabled,
                status: dataset.semanticStatus,
                ...(dataset.embeddings ? { embeddings: dataset.embeddings } : {}),
                ...(dataset.vectorStore ? { vectorStore: dataset.vectorStore } : {}),
                ...(dataset.semanticError ? { error: dataset.semanticError } : {})
            },
            formats: ['csv', 'jsonl', 'lrc-directory']
        }
    }

    async song(id: string) {
        const dataset = await this.active()
        if (!dataset) return
        return (
            await this.db.get('chatluna_lyrics_song', {
                id,
                datasetId: dataset.id
            })
        )[0]
    }

    async songs(datasetId: string, offset: number, limit: number) {
        return await this.db.get(
            'chatluna_lyrics_song',
            { datasetId },
            { offset, limit, sort: { id: 'asc' } }
        )
    }

    async search(input: SearchInput): Promise<SongMatch[]> {
        const dataset = await this.active()
        if (!dataset) return []
        const limit = Math.min(
            Math.max(input.limit ?? 10, 1),
            this.config.maxResults
        )
        const terms = [input.query, input.title, input.artist, input.album]
            .filter((term): term is string => Boolean(term?.trim()))
            .map((term) => normalizeText(term))
        if (terms.length === 0) throw new Error('At least one search term is required')

        const found = new Map<string, SongMatch>()
        const add = (
            rows: LyricsSong[],
            match: SongMatch['match'],
            query?: string
        ) => {
            for (const row of rows) {
                if (found.has(row.id)) continue
                found.set(row.id, {
                    id: row.id,
                    title: row.title,
                    artist: row.artist,
                    album: row.album,
                    language: row.language,
                    match,
                    ...(query ? { snippet: lyricSnippet(row.lyricsPlain, query) } : {})
                })
                if (found.size >= limit) break
            }
        }

        if (input.query) {
            const query = normalizeText(input.query)
            add(
                await this.db.get(
                    'chatluna_lyrics_song',
                    {
                        datasetId: dataset.id,
                        $or: [
                            { titleNormalized: query },
                            { artistNormalized: query },
                            { albumNormalized: query }
                        ]
                    },
                    { limit, sort: { id: 'asc' } }
                ),
                'exact'
            )
            if (found.size < limit) {
                add(
                    await this.db.get(
                        'chatluna_lyrics_song',
                        {
                            datasetId: dataset.id,
                            $or: [
                                { titleNormalized: { $regex: prefixRegex(query) } },
                                { artistNormalized: { $regex: prefixRegex(query) } },
                                { albumNormalized: { $regex: prefixRegex(query) } }
                            ]
                        },
                        { limit, sort: { id: 'asc' } }
                    ),
                    'prefix'
                )
            }
        }

        if (found.size < limit) {
            const query: Record<string, unknown> = { datasetId: dataset.id }
            const clauses: Record<string, unknown>[] = []
            if (input.query) {
                const regex = literalRegex(normalizeText(input.query))
                clauses.push(
                    { titleNormalized: { $regex: regex } },
                    { artistNormalized: { $regex: regex } },
                    { albumNormalized: { $regex: regex } }
                )
            }
            if (input.title) {
                query.titleNormalized = {
                    $regex: literalRegex(normalizeText(input.title))
                }
            }
            if (input.artist) {
                query.artistNormalized = {
                    $regex: literalRegex(normalizeText(input.artist))
                }
            }
            if (input.album) {
                query.albumNormalized = {
                    $regex: literalRegex(normalizeText(input.album))
                }
            }
            if (clauses.length) query.$or = clauses
            add(
                await this.db.get(
                    'chatluna_lyrics_song',
                    query as Query<LyricsSong>,
                    { limit, sort: { id: 'asc' } }
                ),
                'metadata'
            )
        }

        if (input.searchLyrics && input.query && found.size < limit) {
            const query = normalizeText(input.query)
            if (query.length < 4) {
                throw new Error('Lyrics search requires at least 4 normalized characters')
            }
            const rows = await Promise.race([
                this.db.get(
                    'chatluna_lyrics_song',
                    {
                        datasetId: dataset.id,
                        lyricsNormalized: { $regex: literalRegex(query) }
                    } as Query<LyricsSong>,
                    { limit, sort: { id: 'asc' } }
                ),
                new Promise<never>((_, reject) =>
                    setTimeout(
                        () => reject(new Error('Lyrics search timed out')),
                        this.config.queryTimeoutMs
                    )
                )
            ])
            add(rows, 'lyrics', input.query)
        }
        return [...found.values()].slice(0, limit)
    }

    async switchActive(id: string) {
        const db = this.db
        await db.set(
            'chatluna_lyrics_dataset',
            { status: 'active' },
            { status: 'archived' }
        )
        await db.set(
            'chatluna_lyrics_dataset',
            { id },
            { status: 'active', error: null }
        )
    }

    async rollback() {
        const current = await this.active()
        const previous = (
            await this.db.get(
                'chatluna_lyrics_dataset',
                { status: 'archived' },
                { limit: 1, sort: { importedAt: 'desc' } }
            )
        )[0]
        if (!current || !previous) throw new Error('No archived dataset is available')
        await this.db.transact(async (db) => {
            await db.set(
                'chatluna_lyrics_dataset',
                { id: current.id },
                { status: 'archived' }
            )
            await db.set(
                'chatluna_lyrics_dataset',
                { id: previous.id },
                { status: 'active' }
            )
        })
        return previous
    }

    async cleanup() {
        const datasets = await this.db.get(
            'chatluna_lyrics_dataset',
            {},
            { sort: { importedAt: 'desc' } }
        )
        const keep = new Set(
            datasets
                .filter((item) => item.status === 'active')
                .concat(
                    datasets
                        .filter((item) => item.status === 'archived')
                        .slice(0, this.config.retainVersions)
                )
                .map((item) => item.id)
        )
        const remove = datasets.filter((item) => !keep.has(item.id))
        for (const dataset of remove) {
            await this.db.remove('chatluna_lyrics_song', {
                datasetId: dataset.id
            })
            await this.db.remove('chatluna_lyrics_dataset', { id: dataset.id })
        }
        return remove.length
    }
}
