import { randomUUID } from 'node:crypto'

import type { Context } from 'koishi'

import { LyricsRepository } from './repository.js'
import type { LyricsVectorStore, VectorDocument } from './types.js'

export class LyricsSemanticIndex {
    private stores = new Map<string, LyricsVectorStore>()

    constructor(
        readonly ctx: Context,
        readonly repo: LyricsRepository
    ) {}

    async available() {
        const dataset = await this.repo.active()
        return Boolean(
            this.repo.config.semanticEnabled &&
                dataset?.semanticStatus === 'ready' &&
                dataset.semanticKey &&
                dataset.embeddings === this.repo.config.embeddings &&
                dataset.vectorStore === this.repo.config.vectorStore
        )
    }

    async build(datasetId?: string) {
        if (!this.repo.config.semanticEnabled) {
            throw new Error('Semantic search is disabled')
        }
        if (!this.ctx.chatluna) throw new Error('ChatLuna service is unavailable')
        if (!this.repo.config.embeddings) {
            throw new Error('An embeddings model must be configured')
        }
        if (!this.repo.config.vectorStore) {
            throw new Error('A vector store must be configured')
        }

        const dataset = datasetId
            ? (
                  await this.repo.db.get('chatluna_lyrics_dataset', {
                      id: datasetId
                  })
              )[0]
            : await this.repo.active()
        if (!dataset) throw new Error('No dataset is available')

        await this.repo.db.set(
            'chatluna_lyrics_dataset',
            { id: dataset.id },
            {
                semanticStatus: 'building',
                semanticError: null,
                embeddings: this.repo.config.embeddings,
                vectorStore: this.repo.config.vectorStore
            }
        )

        try {
            const ref = await this.ctx.chatluna.createEmbeddings(
                this.repo.config.embeddings
            )
            if (!ref.value) throw new Error('The embeddings model is unavailable')
            const key = `lyrics-${dataset.id}-${randomUUID().slice(0, 8)}`
            const store = await this.ctx.chatluna.platform.createVectorStore(
                this.repo.config.vectorStore,
                { key, embeddings: ref.value }
            )
            this.stores.set(key, store)
            await store.delete({ deleteAll: true })

            const batch: VectorDocument[] = []
            for (let offset = 0; ; offset += 500) {
                const songs = await this.repo.songs(dataset.id, offset, 500)
                if (!songs.length) break
                for (const song of songs) {
                    const chunks: string[] = []
                    let text = ''
                    for (const line of song.lyricsPlain.split('\n')) {
                        if (
                            text &&
                            text.length + line.length + 1 >
                                this.repo.config.semanticChunkChars
                        ) {
                            chunks.push(text)
                            text = ''
                        }
                        text += `${text ? '\n' : ''}${line}`
                    }
                    if (text) chunks.push(text)
                    for (const [index, chunk] of chunks
                        .slice(0, this.repo.config.semanticMaxChunksPerSong)
                        .entries()) {
                        batch.push({
                            id: `${song.id}:${index}`,
                            pageContent: `${song.title}\n${song.artist}\n${chunk}`,
                            metadata: {
                                songId: song.id,
                                title: song.title,
                                artist: song.artist,
                                album: song.album,
                                chunk: index,
                                text: chunk
                            }
                        })
                        if (batch.length < this.repo.config.semanticBatchSize) {
                            continue
                        }
                        await store.addDocuments(batch.splice(0))
                    }
                }
            }
            if (batch.length) await store.addDocuments(batch)
            await this.repo.db.set(
                'chatluna_lyrics_dataset',
                { id: dataset.id },
                {
                    semanticStatus: 'ready',
                    semanticKey: key,
                    semanticError: null
                }
            )
        } catch (err) {
            await this.repo.db.set(
                'chatluna_lyrics_dataset',
                { id: dataset.id },
                {
                    semanticStatus: 'failed',
                    semanticError: (err as Error).message
                }
            )
            throw err
        }
    }

    async search(query: string, limit: number) {
        const dataset = await this.repo.active()
        if (!dataset?.semanticKey || dataset.semanticStatus !== 'ready') {
            throw new Error('The semantic index is not ready')
        }
        if (
            dataset.embeddings !== this.repo.config.embeddings ||
            dataset.vectorStore !== this.repo.config.vectorStore
        ) {
            throw new Error(
                'The embeddings or vector store configuration changed; rebuild the semantic index'
            )
        }
        if (!this.ctx.chatluna) throw new Error('ChatLuna service is unavailable')
        let store = this.stores.get(dataset.semanticKey)
        if (!store) {
            const ref = await this.ctx.chatluna.createEmbeddings(
                dataset.embeddings ?? this.repo.config.embeddings
            )
            if (!ref.value) throw new Error('The embeddings model is unavailable')
            store = await this.ctx.chatluna.platform.createVectorStore(
                dataset.vectorStore ?? this.repo.config.vectorStore,
                { key: dataset.semanticKey, embeddings: ref.value }
            )
            this.stores.set(dataset.semanticKey, store)
        }
        return (await store.similaritySearchWithScore(query, limit)).map(
            ([document, score]) => ({
                songId: document.metadata.songId,
                title: document.metadata.title,
                artist: document.metadata.artist,
                album: document.metadata.album,
                snippet: document.metadata.text,
                score
            })
        )
    }

    async close() {
        await Promise.all(
            [...this.stores.values()].map((store) => store.free?.())
        )
        this.stores.clear()
    }
}
