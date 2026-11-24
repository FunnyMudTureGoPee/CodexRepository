import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node18',
    external: ['koishi'],
    outExtension({ format }) {
        return { js: format === 'cjs' ? '.cjs' : '.js' }
    }
})
