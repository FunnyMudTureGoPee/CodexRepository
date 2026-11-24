import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { $ } from 'koishi'

import { LyricsRepository } from './repository.js'
import { readSongs } from './source.js'
import type {
    ImportReport,
    LyricsDataset,
    LyricsSong,
    ParsedSong
} from './types.js'

export class LyricsImporter {
    constructor(
        readonly repo: LyricsRepository,
        readonly beforeActivate?: (datasetId: string) => Promise<void>
    ) {}

    async validate(source: string): Promise<ImportReport> {
        const hash = createHash('sha256')
        const keys = new Set<string>()
        let count = 0
        let duplicates = 0
        for await (const song of readSongs(source)) {
            if (keys.has(song.songKey)) {
                duplicates += 1
                continue
            }
            keys.add(song.songKey)
            count += 1
            hash.update(JSON.stringify(song))
        }
        if (!count) throw new Error('The source contains no valid songs')
        return {
            source: resolve(source),
            count,
            duplicates,
            checksum: hash.digest('hex')
        }
    }

    async import(source: string, mode: 'replace' | 'merge'): Promise<ImportReport> {
        const path = resolve(source)
        const id = randomUUID()
        const version = new Date().toISOString().replace(/[:.]/g, '-')
        const dataset: LyricsDataset = {
            id,
            version,
            source: path,
            checksum: '',
            status: 'staging',
            songCount: 0,
            importedAt: new Date(),
            error: null,
            semanticStatus: this.repo.config.semanticEnabled ? 'pending' : 'disabled',
            semanticKey: null,
            semanticError: null,
            embeddings: this.repo.config.semanticEnabled
                ? this.repo.config.embeddings
                : null,
            vectorStore: this.repo.config.semanticEnabled
                ? this.repo.config.vectorStore
                : null
        }
        await this.repo.db.create('chatluna_lyrics_dataset', dataset)

        try {
            if (mode === 'merge') await this.cloneActive(id)
            const hash = createHash('sha256')
            const keys = new Set<string>()
            const batch: LyricsSong[] = []
            let count = mode === 'merge' ? await this.countSongs(id) : 0
            let duplicates = 0
            for await (const song of readSongs(path)) {
                if (keys.has(song.songKey)) {
                    duplicates += 1
                    continue
                }
                keys.add(song.songKey)
                hash.update(JSON.stringify(song))
                batch.push(this.row(id, song))
                if (batch.length < 500) continue
                await this.repo.db.upsert('chatluna_lyrics_song', batch)
                count += batch.length
                batch.length = 0
            }
            if (batch.length) {
                await this.repo.db.upsert('chatluna_lyrics_song', batch)
                count += batch.length
            }
            if (!keys.size && mode === 'replace') {
                throw new Error('The source contains no valid songs')
            }
            const checksum = hash.digest('hex')
            if (mode === 'merge') count = await this.countSongs(id)
            await this.repo.db.set(
                'chatluna_lyrics_dataset',
                { id },
                { checksum, songCount: count }
            )
            await this.beforeActivate?.(id)
            await this.repo.db.transact(async (db) => {
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
            })
            return {
                source: path,
                count,
                duplicates,
                checksum,
                datasetId: id,
                version
            }
        } catch (err) {
            await this.repo.db.remove('chatluna_lyrics_song', { datasetId: id })
            await this.repo.db.set(
                'chatluna_lyrics_dataset',
                { id },
                { status: 'failed', error: (err as Error).message }
            )
            throw err
        }
    }

    private row(datasetId: string, song: ParsedSong): LyricsSong {
        return {
            id: `${datasetId}:${song.songKey}`,
            songKey: song.songKey,
            datasetId,
            sourceId: song.sourceId ?? null,
            title: song.title,
            artist: song.artist,
            album: song.album,
            titleNormalized: song.titleNormalized,
            artistNormalized: song.artistNormalized,
            albumNormalized: song.albumNormalized,
            lyricsRaw: song.lyricsRaw,
            lyricsPlain: song.lyricsPlain,
            lyricsNormalized: song.lyricsNormalized,
            language: song.language,
            source: song.source,
            updatedAt: new Date()
        }
    }

    private async cloneActive(datasetId: string) {
        const current = await this.repo.active()
        if (!current) return
        for (let offset = 0; ; offset += 500) {
            const songs = await this.repo.songs(current.id, offset, 500)
            if (!songs.length) break
            await this.repo.db.upsert(
                'chatluna_lyrics_song',
                songs.map((song) => ({
                    ...song,
                    id: `${datasetId}:${song.songKey}`,
                    datasetId
                }))
            )
        }
    }

    private async countSongs(datasetId: string) {
        return Number(
            await this.repo.db.eval(
                'chatluna_lyrics_song',
                (row) => $.count(row.id),
                { datasetId }
            )
        )
    }
}
