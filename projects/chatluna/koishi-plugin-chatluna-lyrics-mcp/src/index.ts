import { Context, Schema } from 'koishi'
import type {} from '@koishijs/plugin-server'

import { LyricsImporter } from './importer.js'
import { registerMcp } from './mcp.js'
import { LyricsRepository } from './repository.js'
import { LyricsSemanticIndex } from './semantic.js'
import type { PluginConfig } from './types.js'

export const name = 'chatluna-lyrics-mcp'

export const inject = {
    required: ['database', 'server'],
    optional: ['chatluna']
}

export const Config: Schema<PluginConfig> = Schema.object({
    endpoint: Schema.string()
        .default('/mcp/lyrics')
        .description('MCP HTTP 路径，必须以 / 开头。'),
    token: Schema.string()
        .role('secret')
        .default('')
        .description('可选 Bearer Token。留空时不校验令牌。'),
    allowRemote: Schema.boolean()
        .default(false)
        .description('是否允许非本机地址访问 MCP。'),
    queryTimeoutMs: Schema.number()
        .min(500)
        .max(30000)
        .default(3000)
        .description('歌词正文查询超时（毫秒）。'),
    maxResults: Schema.number()
        .min(1)
        .max(100)
        .default(20)
        .description('单次查询最大返回数量。'),
    retainVersions: Schema.number()
        .min(0)
        .max(10)
        .default(1)
        .description('清理时保留的历史数据集数量。'),
    semanticEnabled: Schema.boolean()
        .default(false)
        .description('启用 ChatLuna 向量语义检索。'),
    embeddings: Schema.string()
        .default('')
        .description('ChatLuna 嵌入模型完整名称。'),
    vectorStore: Schema.string()
        .default('luna-vdb')
        .description('ChatLuna 向量数据库名称。'),
    semanticChunkChars: Schema.number()
        .min(100)
        .max(4000)
        .default(600)
        .description('语义索引单个歌词片段的最大字符数。'),
    semanticMaxChunksPerSong: Schema.number()
        .min(1)
        .max(20)
        .default(4)
        .description('每首歌曲最多写入的向量片段数。'),
    semanticBatchSize: Schema.number()
        .min(1)
        .max(200)
        .default(30)
        .description('向量索引批处理大小。')
})

export function registerModels(ctx: Context) {
    ctx.model.extend(
        'chatluna_lyrics_dataset',
        {
            id: { type: 'char', length: 36 },
            version: { type: 'string', length: 64 },
            source: 'text',
            checksum: { type: 'char', length: 64 },
            status: { type: 'string', length: 16 },
            songCount: 'unsigned',
            importedAt: 'timestamp',
            error: { type: 'text', nullable: true },
            semanticStatus: { type: 'string', length: 16 },
            semanticKey: { type: 'string', length: 128, nullable: true },
            semanticError: { type: 'text', nullable: true },
            embeddings: { type: 'string', length: 128, nullable: true },
            vectorStore: { type: 'string', length: 64, nullable: true }
        },
        {
            primary: 'id',
            indexes: ['status', 'importedAt', 'version']
        }
    )
    ctx.model.extend(
        'chatluna_lyrics_song',
        {
            id: { type: 'string', length: 80 },
            songKey: { type: 'string', length: 40 },
            datasetId: { type: 'char', length: 36 },
            sourceId: { type: 'string', length: 128, nullable: true },
            title: { type: 'string', length: 512 },
            artist: { type: 'string', length: 512 },
            album: { type: 'string', length: 512 },
            titleNormalized: { type: 'string', length: 512 },
            artistNormalized: { type: 'string', length: 512 },
            albumNormalized: { type: 'string', length: 512 },
            lyricsRaw: 'text',
            lyricsPlain: 'text',
            lyricsNormalized: 'text',
            language: { type: 'string', length: 32 },
            source: 'text',
            updatedAt: 'timestamp'
        },
        {
            primary: 'id',
            indexes: [
                ['datasetId', 'songKey'],
                ['datasetId', 'titleNormalized'],
                ['datasetId', 'artistNormalized'],
                ['datasetId', 'albumNormalized']
            ]
        }
    )
}

function format(value: unknown) {
    return JSON.stringify(value, null, 2)
}

export function apply(ctx: Context, config: PluginConfig) {
    if (!config.endpoint.startsWith('/')) {
        throw new Error('endpoint must start with /')
    }
    registerModels(ctx)
    const repo = new LyricsRepository(ctx, config)
    const semantic = new LyricsSemanticIndex(ctx, repo)
    const importer = new LyricsImporter(
        repo,
        config.semanticEnabled
            ? async (datasetId) => semantic.build(datasetId)
            : undefined
    )
    registerMcp(ctx, repo, semantic, config)

    ctx.command('lyrics', '管理本地歌词数据库', { authority: 4 })

    ctx.command('lyrics.validate <path:text>', '只读校验 CSV、JSONL 或 LRC 目录', {
        authority: 4
    })
        .action(async (_, path) => format(await importer.validate(path)))

    ctx.command('lyrics.import <path:text>', '导入并切换歌词数据集', {
        authority: 4
    })
        .option('mode', '--mode <mode:string>', { fallback: 'replace' })
        .action(async ({ options }, path) => {
            const mode = options?.mode ?? 'replace'
            if (!['replace', 'merge'].includes(mode)) {
                throw new Error('mode must be replace or merge')
            }
            const report = await importer.import(
                path,
                mode as 'replace' | 'merge'
            )
            return format(report)
        })

    ctx.command('lyrics.replace <path:text>', '完整替换并原子切换歌词数据集', {
        authority: 4
    }).action(async (_, path) => format(await importer.import(path, 'replace')))

    ctx.command('lyrics.merge <path:text>', '合并输入并原子切换新数据集', {
        authority: 4
    }).action(async (_, path) => format(await importer.import(path, 'merge')))

    ctx.command('lyrics.rollback', '回滚到最近一个归档数据集', {
        authority: 4
    })
        .action(async () => format(await repo.rollback()))

    ctx.command('lyrics.cleanup', '清理失败、staging 和超出保留数量的数据集', {
        authority: 4
    })
        .action(async () => `Removed ${await repo.cleanup()} dataset(s).`)

    ctx.command('lyrics.status', '显示活动歌词数据集状态', {
        authority: 4
    })
        .action(async () => format(await repo.status()))

    ctx.command('lyrics.semantic-reindex', '重建活动数据集的可选语义索引', {
        authority: 4
    })
        .action(async () => {
            await semantic.build()
            return 'Semantic lyrics index rebuilt.'
        })

    ctx.on('ready', async () => {
        if (!config.semanticEnabled) return
        const dataset = await repo.active()
        if (dataset?.semanticStatus !== 'pending') return
        void semantic.build(dataset.id).catch((err) => {
            ctx.logger('chatluna-lyrics-mcp').error(err)
        })
    })

    ctx.on('dispose', () => semantic.close())
}

export { LyricsImporter } from './importer.js'
export { LyricsRepository } from './repository.js'
export { LyricsSemanticIndex } from './semantic.js'
export { normalizeText, parseSong, prefixRegex, stripLrc } from './text.js'
export type {
    PluginConfig,
    ImportReport,
    LyricsDataset,
    LyricsSong,
    SearchInput,
    SongInput,
    SongMatch
} from './types.js'
