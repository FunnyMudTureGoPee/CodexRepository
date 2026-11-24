import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as memoryModule from '@koishijs/plugin-database-memory'
import { Context } from 'koishi'

import { LyricsImporter } from '../src/importer.js'
import { registerModels } from '../src/index.js'
import { LyricsRepository } from '../src/repository.js'
import type { PluginConfig } from '../src/types.js'

const config: PluginConfig = {
    endpoint: '/mcp/lyrics',
    token: '',
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

async function setup() {
    const ctx = new Context()
    const memory = memoryModule.default ?? memoryModule
    ctx.plugin(memory as never)
    registerModels(ctx)
    await ctx.start()
    const repo = new LyricsRepository(ctx, config)
    return { ctx, repo, importer: new LyricsImporter(repo) }
}

test('imports, searches, replaces, rolls back, and cleans datasets', async () => {
    const { ctx, repo, importer } = await setup()
    const dir = await mkdtemp(join(tmpdir(), 'lyrics-repository-'))
    const first = join(dir, 'first.jsonl')
    await writeFile(
        first,
        [
            {
                id: 'one',
                title: 'First Song',
                artist: 'Singer',
                album: 'Album',
                lyrics: 'A unique fragment lives here'
            },
            {
                id: 'two',
                title: 'Second Song',
                artist: 'Another Singer',
                lyrics: 'Another line'
            },
            {
                id: 'one',
                title: 'Duplicate First Song',
                artist: 'Singer',
                lyrics: 'This duplicate must be ignored'
            }
        ]
            .map((value) => JSON.stringify(value))
            .join('\n'),
        'utf8'
    )

    const report = await importer.import(first, 'replace')
    assert.equal(report.count, 2)
    assert.equal(report.duplicates, 1)
    assert.equal((await repo.status()).songCount, 2)
    assert.equal((await repo.search({ query: 'First' }))[0]?.match, 'prefix')
    assert.equal(
        (await repo.search({ query: 'unique fragment', searchLyrics: true }))[0]
            ?.match,
        'lyrics'
    )
    await assert.rejects(
        repo.search({ query: 'abc', searchLyrics: true }),
        /at least 4/
    )
    const concurrent = await Promise.all(
        Array.from({ length: 8 }, () => repo.search({ artist: 'Singer' }))
    )
    assert.ok(concurrent.every((matches) => matches.length >= 1))

    const vectorFailure = new LyricsImporter(repo, async () => {
        throw new Error('simulated vector build failure')
    })
    await assert.rejects(vectorFailure.import(first, 'replace'), /vector build/)
    assert.equal((await repo.status()).songCount, 2)

    const second = join(dir, 'second.jsonl')
    await writeFile(
        second,
        `${JSON.stringify({
            id: 'three',
            title: 'Replacement',
            artist: 'Singer',
            lyrics: 'Replacement lyrics'
        })}\n`,
        'utf8'
    )
    await importer.import(second, 'replace')
    assert.equal((await repo.status()).songCount, 1)
    await repo.rollback()
    assert.equal((await repo.status()).songCount, 2)

    const broken = join(dir, 'broken.jsonl')
    await writeFile(broken, '{not json}\n', 'utf8')
    await assert.rejects(importer.import(broken, 'replace'))
    assert.equal((await repo.status()).songCount, 2)
    assert.equal(await repo.cleanup(), 2)
    await ctx.stop()
})

test('merge creates a new atomic version', async () => {
    const { ctx, repo, importer } = await setup()
    const dir = await mkdtemp(join(tmpdir(), 'lyrics-merge-'))
    const first = join(dir, 'first.jsonl')
    const merge = join(dir, 'merge.jsonl')
    await writeFile(
        first,
        `${JSON.stringify({
            id: 'one',
            title: 'Original',
            artist: 'Singer',
            lyrics: 'Original lyrics'
        })}\n`,
        'utf8'
    )
    await writeFile(
        merge,
        `${JSON.stringify({
            id: 'two',
            title: 'Added',
            artist: 'Singer',
            lyrics: 'Added lyrics'
        })}\n`,
        'utf8'
    )
    await importer.import(first, 'replace')
    await importer.import(merge, 'merge')
    assert.equal((await repo.status()).songCount, 2)
    assert.equal((await repo.search({ query: 'Added' })).length, 1)
    await ctx.stop()
})
