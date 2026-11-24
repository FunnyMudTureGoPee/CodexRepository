import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readSongs } from '../src/source.js'
import {
    literalRegex,
    normalizeText,
    parseSong,
    stripLrc
} from '../src/text.js'

test('normalizes metadata and strips LRC timestamps', () => {
    assert.equal(normalizeText(' Ｈｅｌｌｏ，世界！ '), 'hello世界')
    assert.equal(
        stripLrc('[ti:Song]\n[00:01.00]First line\n[00:03]Second line'),
        'First line\nSecond line'
    )
    const song = parseSong(
        {
            title: ' Song ',
            artist: ' Artist ',
            lrc: '[00:01.00]Hello world'
        },
        'test'
    )
    assert.equal(song.title, 'Song')
    assert.equal(song.lyricsPlain, 'Hello world')
    assert.equal(song.songKey.length, 32)
})

test('escapes regular expression metacharacters', () => {
    const regex = literalRegex('[a+b]?.*')
    assert.equal(regex.test('before [a+b]?.* after'), true)
    assert.equal(regex.test('aaaa'), false)
})

test('reads CSV, JSONL, and LRC directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lyrics-source-'))
    const csv = join(dir, 'songs.csv')
    await writeFile(
        csv,
        'id,title,artist,album,lyrics\n1,"CSV Song","CSV Artist","Album","Line one"\n',
        'utf8'
    )
    const csvSongs = []
    for await (const song of readSongs(csv)) csvSongs.push(song)
    assert.equal(csvSongs[0]?.title, 'CSV Song')

    const jsonl = join(dir, 'songs.jsonl')
    await writeFile(
        jsonl,
        `${JSON.stringify({
            title: 'JSON Song',
            artist: 'JSON Artist',
            lyrics: 'Line two'
        })}\n`,
        'utf8'
    )
    const jsonSongs = []
    for await (const song of readSongs(jsonl)) jsonSongs.push(song)
    assert.equal(jsonSongs[0]?.artist, 'JSON Artist')

    const artist = join(dir, 'LRC Artist')
    await mkdir(artist)
    await writeFile(
        join(artist, 'fallback.lrc'),
        '[ti:LRC Song]\n[ar:Tagged Artist]\n[al:LRC Album]\n[00:01]Line three',
        'utf8'
    )
    const lrcSongs = []
    for await (const song of readSongs(artist)) lrcSongs.push(song)
    assert.equal(lrcSongs[0]?.title, 'LRC Song')
    assert.equal(lrcSongs[0]?.artist, 'Tagged Artist')
    assert.equal(lrcSongs[0]?.album, 'LRC Album')
})
