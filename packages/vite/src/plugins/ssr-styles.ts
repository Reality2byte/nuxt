import { pathToFileURL } from 'node:url'
import type { Plugin } from 'vite'
import { dirname, relative } from 'pathe'
import { genImport, genObjectFromRawEntries } from 'knitwork'
import { filename as _filename } from 'pathe/utils'
import { parseQuery, parseURL } from 'ufo'
import type { Component } from '@nuxt/schema'
import MagicString from 'magic-string'
import { findStaticImports } from 'mlly'

import { isCSS, isVue } from '../utils'

interface SSRStylesPluginOptions {
  srcDir: string
  chunksWithInlinedCSS: Set<string>
  shouldInline?: ((id?: string) => boolean) | boolean
  components: Component[]
  clientCSSMap: Record<string, Set<string>>
  entry: string
  globalCSS: string[]
  mode: 'server' | 'client'
}

const SUPPORTED_FILES_RE = /\.(?:vue|(?:[cm]?j|t)sx?)$/

export function SSRStylesPlugin (options: SSRStylesPluginOptions): Plugin {
  const cssMap: Record<string, { files: string[], inBundle?: boolean }> = {}
  const idRefMap: Record<string, string> = {}

  const relativeToSrcDir = (path: string) => relative(options.srcDir, path)

  const warnCache = new Set<string>()
  const islands = options.components.filter(component =>
    component.island ||
    // .server components without a corresponding .client component will need to be rendered as an island
    (component.mode === 'server' && !options.components.some(c => c.pascalName === component.pascalName && c.mode === 'client')),
  )

  return {
    name: 'ssr-styles',
    resolveId: {
      order: 'pre',
      async handler (id, importer, _options) {
        // We want to remove side effects (namely, emitting CSS) from `.vue` files and explicitly imported `.css` files
        // but only as long as we are going to inline that CSS.
        if ((options.shouldInline === false || (typeof options.shouldInline === 'function' && !options.shouldInline(importer)))) {
          return
        }

        if (id === '#build/css' || id.endsWith('.vue') || isCSS(id)) {
          const res = await this.resolve(id, importer, { ..._options, skipSelf: true })
          if (res) {
            return {
              ...res,
              moduleSideEffects: false,
            }
          }
        }
      },
    },
    generateBundle (outputOptions) {
      if (options.mode === 'client') { return }

      const emitted: Record<string, string> = {}
      for (const [file, { files, inBundle }] of Object.entries(cssMap)) {
        // File has been tree-shaken out of build (or there are no styles to inline)
        if (!files.length || !inBundle) { continue }
        const fileName = filename(file)
        const base = typeof outputOptions.assetFileNames === 'string'
          ? outputOptions.assetFileNames
          : outputOptions.assetFileNames({
              type: 'asset',
              name: `${fileName}-styles.mjs`,
              names: [`${fileName}-styles.mjs`],
              originalFileName: `${fileName}-styles.mjs`,
              originalFileNames: [`${fileName}-styles.mjs`],
              source: '',
            })

        const baseDir = dirname(base)

        emitted[file] = this.emitFile({
          type: 'asset',
          name: `${fileName}-styles.mjs`,
          source: [
            ...files.map((css, i) => `import style_${i} from './${relative(baseDir, this.getFileName(css))}';`),
            `export default [${files.map((_, i) => `style_${i}`).join(', ')}]`,
          ].join('\n'),
        })
      }

      for (const key in emitted) {
        // Track the chunks we are inlining CSS for so we can omit including links to the .css files
        options.chunksWithInlinedCSS.add(key)
      }

      // TODO: remove css from vite preload arrays

      this.emitFile({
        type: 'asset',
        fileName: 'styles.mjs',
        originalFileName: 'styles.mjs',
        source:
          [
            'const interopDefault = r => r.default || r || []',
            `export default ${genObjectFromRawEntries(
              Object.entries(emitted).map(([key, value]) => [key, `() => import('./${this.getFileName(value)}').then(interopDefault)`]) as [string, string][],
            )}`,
          ].join('\n'),
      })
    },
    renderChunk (_code, chunk) {
      const isEntry = chunk.facadeModuleId === options.entry
      if (isEntry) {
        options.clientCSSMap[chunk.facadeModuleId!] ||= new Set()
      }
      for (const moduleId of [chunk.facadeModuleId, ...chunk.moduleIds].filter(Boolean) as string[]) {
        // 'Teleport' CSS chunks that made it into the bundle on the client side
        // to be inlined on server rendering
        if (options.mode === 'client') {
          const moduleMap = options.clientCSSMap[moduleId] ||= new Set()
          if (isCSS(moduleId)) {
            // Vue files can (also) be their own entrypoints as they are tracked separately
            if (isVue(moduleId)) {
              moduleMap.add(moduleId)
              const parent = moduleId.replace(/\?.+$/, '')
              const parentMap = options.clientCSSMap[parent] ||= new Set()
              parentMap.add(moduleId)
            }
            // This is required to track CSS in entry chunk
            if (isEntry && chunk.facadeModuleId) {
              const facadeMap = options.clientCSSMap[chunk.facadeModuleId] ||= new Set()
              facadeMap.add(moduleId)
            }
          }
          continue
        }

        const relativePath = relativeToSrcDir(moduleId)
        if (relativePath in cssMap) {
          cssMap[relativePath]!.inBundle = cssMap[relativePath]!.inBundle ?? ((isVue(moduleId) && !!relativeToSrcDir(moduleId)) || isEntry)
        }
      }

      return null
    },
    async transform (code, id) {
      if (options.mode === 'client') {
        // We will either teleport global CSS to the 'entry' chunk on the server side
        // or include it here in the client build so it is emitted in the CSS.
        if (id === options.entry && (options.shouldInline === true || (typeof options.shouldInline === 'function' && options.shouldInline(id)))) {
          const s = new MagicString(code)
          const idClientCSSMap = options.clientCSSMap[id] ||= new Set()
          if (!options.globalCSS.length) { return }

          for (const file of options.globalCSS) {
            const resolved = await this.resolve(file) ?? await this.resolve(file, id)
            const res = await this.resolve(file + '?inline&used') ?? await this.resolve(file + '?inline&used', id)
            if (!resolved || !res) {
              if (!warnCache.has(file)) {
                warnCache.add(file)
                this.warn(`[nuxt] Cannot extract styles for \`${file}\`. Its styles will not be inlined when server-rendering.`)
              }
              s.prepend(`${genImport(file)}\n`)
              continue
            }
            idClientCSSMap.add(resolved.id)
          }
          if (s.hasChanged()) {
            return {
              code: s.toString(),
              map: s.generateMap({ hires: true }),
            }
          }
        }
        return
      }

      const { pathname, search } = parseURL(decodeURIComponent(pathToFileURL(id).href))

      if (!(id in options.clientCSSMap) && !islands.some(c => c.filePath === pathname)) { return }

      const query = parseQuery(search)
      if (query.macro || query.nuxt_component) { return }

      if (!islands.some(c => c.filePath === pathname)) {
        if (options.shouldInline === false || (typeof options.shouldInline === 'function' && !options.shouldInline(id))) { return }
      }

      const relativeId = relativeToSrcDir(id)
      const idMap = cssMap[relativeId] ||= { files: [] }

      const emittedIds = new Set<string>()

      let styleCtr = 0
      const ids = options.clientCSSMap[id] || []
      for (const file of ids) {
        const resolved = await this.resolve(file) ?? await this.resolve(file, id)
        const res = await this.resolve(file + '?inline&used') ?? await this.resolve(file + '?inline&used', id)
        if (!resolved || !res) {
          if (!warnCache.has(file)) {
            warnCache.add(file)
            this.warn(`[nuxt] Cannot extract styles for \`${file}\`. Its styles will not be inlined when server-rendering.`)
          }
          continue
        }
        if (emittedIds.has(file)) { continue }
        const ref = this.emitFile({
          type: 'chunk',
          name: `${filename(id)}-styles-${++styleCtr}.mjs`,
          id: file + '?inline&used',
        })

        idRefMap[relativeToSrcDir(file)] = ref
        idMap.files.push(ref)
      }

      if (!SUPPORTED_FILES_RE.test(pathname)) { return }

      for (const i of findStaticImports(code)) {
        const { type } = parseQuery(i.specifier)
        if (type !== 'style' && !i.specifier.endsWith('.css')) { continue }

        const resolved = await this.resolve(i.specifier, id)
        if (!resolved) { continue }
        if (!(await this.resolve(resolved.id + '?inline&used'))) {
          if (!warnCache.has(resolved.id)) {
            warnCache.add(resolved.id)
            this.warn(`[nuxt] Cannot extract styles for \`${i.specifier}\`. Its styles will not be inlined when server-rendering.`)
          }
          continue
        }

        if (emittedIds.has(resolved.id)) { continue }
        const ref = this.emitFile({
          type: 'chunk',
          name: `${filename(id)}-styles-${++styleCtr}.mjs`,
          id: resolved.id + '?inline&used',
        })

        idRefMap[relativeToSrcDir(resolved.id)] = ref
        idMap.files.push(ref)
      }
    },
  }
}

function filename (name: string) {
  return _filename(name.replace(/\?.+$/, ''))
}
