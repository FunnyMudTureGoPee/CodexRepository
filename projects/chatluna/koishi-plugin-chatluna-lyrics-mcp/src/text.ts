import { createHash } from 'node:crypto'

import type { ParsedSong, SongInput } from './types.js'

export function normalizeText(text: string) {
    return text
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function stripLrc(text: string) {
    return text
        .replace(/^\[(ar|ti|al|by|offset|re|ve|length):.*\]\s*$/gimu, '')
        .replace(/(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+/g, '')
        .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n')
}

export function readLrcTag(text: string, tag: 'ti' | 'ar' | 'al') {
    return new RegExp(`^\\[${tag}:(.*)\\]\\s*$`, 'imu').exec(text)?.[1]?.trim()
}

export function parseSong(input: SongInput, fallbackSource: string): ParsedSong {
    const raw = input.lrc ?? input.lyrics ?? ''
    const title = input.title.trim()
    const artist = input.artist.trim()
    const album = input.album?.trim() ?? ''
    const plain = stripLrc(raw)

    if (!title) throw new Error('title is required')
    if (!artist) throw new Error(`artist is required for "${title}"`)
    if (!plain) throw new Error(`lyrics are required for "${title}"`)

    const key =
        input.id?.trim() ||
        createHash('sha256')
            .update(
                [
                    normalizeText(title),
                    normalizeText(artist),
                    normalizeText(album)
                ].join('\0')
            )
            .digest('hex')
            .slice(0, 32)

    return {
        ...(input.id?.trim() ? { sourceId: input.id.trim() } : {}),
        songKey: key,
        title,
        artist,
        album,
        titleNormalized: normalizeText(title),
        artistNormalized: normalizeText(artist),
        albumNormalized: normalizeText(album),
        lyricsRaw: raw.replace(/\r\n/g, '\n').trim(),
        lyricsPlain: plain,
        lyricsNormalized: normalizeText(plain),
        language: input.language?.trim() ?? '',
        source: input.source?.trim() || fallbackSource
    }
}

export function literalRegex(text: string) {
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

export function prefixRegex(text: string) {
    const literal = literalRegex(text)
    return new RegExp(`^${literal.source}`, literal.flags)
}

export function lyricSnippet(text: string, query: string) {
    const normalized = normalizeText(query)
    const lines = text.split('\n')
    const index = lines.findIndex((line) => normalizeText(line).includes(normalized))
    if (index < 0) return text.slice(0, 180)
    return lines.slice(Math.max(0, index - 1), index + 2).join('\n').slice(0, 300)
}
