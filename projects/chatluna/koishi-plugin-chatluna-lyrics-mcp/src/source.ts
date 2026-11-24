import { createReadStream } from 'node:fs'
import { opendir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { parse } from 'csv-parse'

import { parseSong, readLrcTag } from './text.js'
import type { ParsedSong, SongInput } from './types.js'

async function* walk(dir: string): AsyncGenerator<string> {
    for await (const entry of await opendir(dir)) {
        const file = resolve(dir, entry.name)
        if (entry.isDirectory()) {
            yield* walk(file)
        } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.lrc') {
            yield file
        }
    }
}

export async function* readSongs(source: string): AsyncGenerator<ParsedSong> {
    const path = resolve(source)
    const info = await stat(path)
    const ext = extname(path).toLowerCase()

    if (info.isDirectory()) {
        for await (const file of walk(path)) {
            const lrc = await readFile(file, 'utf8')
            yield parseSong(
                {
                    title: readLrcTag(lrc, 'ti') ?? basename(file, '.lrc'),
                    artist: readLrcTag(lrc, 'ar') ?? basename(dirname(file)),
                    album: readLrcTag(lrc, 'al'),
                    lrc,
                    source: file
                },
                path
            )
        }
        return
    }

    if (!info.isFile()) throw new Error('The import source must be a file or directory')

    if (ext === '.jsonl' || ext === '.ndjson') {
        const lines = createInterface({
            input: createReadStream(path, { encoding: 'utf8' }),
            crlfDelay: Infinity
        })
        let line = 0
        for await (const text of lines) {
            line += 1
            if (!text.trim()) continue
            try {
                yield parseSong(JSON.parse(text) as SongInput, path)
            } catch (err) {
                throw new Error(
                    `Invalid JSONL record at line ${line}: ${(err as Error).message}`
                )
            }
        }
        return
    }

    if (ext === '.csv') {
        const parser = createReadStream(path, { encoding: 'utf8' }).pipe(
            parse({
                bom: true,
                columns: true,
                skip_empty_lines: true,
                trim: true
            })
        )
        let row = 1
        for await (const record of parser) {
            row += 1
            try {
                yield parseSong(record as SongInput, path)
            } catch (err) {
                throw new Error(
                    `Invalid CSV record at row ${row}: ${(err as Error).message}`
                )
            }
        }
        return
    }

    throw new Error('Supported inputs are CSV, JSONL, NDJSON, or an LRC directory')
}
