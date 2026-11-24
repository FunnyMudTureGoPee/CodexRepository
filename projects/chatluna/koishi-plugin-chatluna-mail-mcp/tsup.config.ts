import { defineConfig } from 'tsup'
export default defineConfig([
  { entry:['src/index.ts'], outDir:'lib', format:['cjs'], dts:true, clean:true, sourcemap:true, target:'node20',
    external:['koishi','@koishijs/plugin-console'], outExtension:()=>({js:'.cjs'}) },
  { entry:['client/index.ts'], outDir:'console', format:['esm'], dts:false, clean:true, sourcemap:true, target:'es2022',
    platform:'browser', external:['vue','@koishijs/client'], outExtension:()=>({js:'.js'}) },
])
