import type { Context } from 'koishi'

export type DatasetStatus =
    | 'staging'
    | 'active'
    | 'archived'
    | 'failed'

export type SemanticStatus =
    | 'disabled'
    | 'pending'
    | 'building'
    | 'ready'
    | 'failed'

export interface LyricsDataset {
    id: string
    version: string
    source: string
    checksum: string
    status: DatasetStatus
    songCount: number
    importedAt: Date
    error: string | null
    semanticStatus: SemanticStatus
    semanticKey: string | null
    semanticError: string | null
    embeddings: string | null
    vectorStore: string | null
}

export interface LyricsSong {
    id: string
    songKey: string
    datasetId: string
    sourceId: string | null
    title: string
    artist: string
    album: string
    titleNormalized: string
    artistNormalized: string
    albumNormalized: string
    lyricsRaw: string
    lyricsPlain: string
    lyricsNormalized: string
    language: string
    source: string
    updatedAt: Date
}

export interface SongInput {
    id?: string
    title: string
    artist: string
    album?: string
    lyrics?: string
    lrc?: string
    language?: string
    source?: string
}

export interface ParsedSong {
    sourceId?: string
    songKey: string
    title: string
    artist: string
    album: string
    titleNormalized: string
    artistNormalized: string
    albumNormalized: string
    lyricsRaw: string
    lyricsPlain: string
    lyricsNormalized: string
    language: string
    source: string
}

export interface ImportReport {
    source: string
    count: number
    duplicates: number
    checksum: string
    datasetId?: string
    version?: string
}

export interface SearchInput {
    query?: string
    title?: string
    artist?: string
    album?: string
    searchLyrics?: boolean
    limit?: number
}

export interface SongMatch {
    id: string
    title: string
    artist: string
    album: string
    language: string
    match: 'exact' | 'prefix' | 'metadata' | 'lyrics'
    snippet?: string
}

export interface LyricsStatus {
    active: boolean
    datasetId?: string
    version?: string
    songCount: number
    importedAt?: string
    source?: string
    semantic: {
        enabled: boolean
        status: SemanticStatus
        embeddings?: string
        vectorStore?: string
        error?: string
    }
    formats: string[]
}

export interface PluginConfig {
    endpoint: string
    token: string
    allowRemote: boolean
    queryTimeoutMs: number
    maxResults: number
    retainVersions: number
    semanticEnabled: boolean
    embeddings: string
    vectorStore: string
    semanticChunkChars: number
    semanticMaxChunksPerSong: number
    semanticBatchSize: number
}

export interface VectorDocument {
    id?: string
    pageContent: string
    metadata: Record<string, unknown>
}

export interface LyricsVectorStore {
    addDocuments(documents: VectorDocument[]): Promise<string[] | void>
    delete(options: { deleteAll?: boolean; ids?: string[] }): Promise<void>
    similaritySearchWithScore(
        query: string,
        limit: number
    ): Promise<[VectorDocument, number][]>
    free?(): Promise<void>
}

export interface ChatLunaLike {
    createEmbeddings(name: string): Promise<{ value: unknown }>
    platform: {
        createVectorStore(
            name: string,
            options: { key: string; embeddings: unknown }
        ): Promise<LyricsVectorStore>
    }
}

declare module 'koishi' {
    interface Tables {
        chatluna_lyrics_dataset: LyricsDataset
        chatluna_lyrics_song: LyricsSong
    }

    interface Context {
        chatluna?: ChatLunaLike
    }
}

export type LyricsContext = Context & {
    database: NonNullable<Context['database']>
    server: NonNullable<Context['server']>
}
