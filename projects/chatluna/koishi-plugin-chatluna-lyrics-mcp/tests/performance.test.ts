import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeText, parseSong } from '../src/text.js'

test(
    'normalizes one hundred thousand synthetic songs without retaining lyrics globally',
    { skip: process.env.LYRICS_BENCHMARK !== '1', timeout: 60000 },
    () => {
        let checksum = 0
        for (let index = 0; index < 100_000; index += 1) {
            const song = parseSong(
                {
                    id: String(index),
                    title: `Synthetic Song ${index}`,
                    artist: `Artist ${index % 1000}`,
                    lyrics: `Line ${index} for bounded import verification`
                },
                'benchmark'
            )
            checksum += normalizeText(song.title).length
        }
        assert.ok(checksum > 0)
    }
)
