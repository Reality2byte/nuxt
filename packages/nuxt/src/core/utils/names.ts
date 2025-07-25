import { basename, dirname, extname, normalize } from 'pathe'
import { kebabCase, splitByCase } from 'scule'
import { withTrailingSlash } from 'ufo'
import { QUOTE_RE } from '.'

export function getNameFromPath (path: string, relativeTo?: string) {
  const relativePath = relativeTo
    ? normalize(path).replace(withTrailingSlash(normalize(relativeTo)), '')
    : basename(path)
  const prefixParts = splitByCase(dirname(relativePath))
  const fileName = basename(relativePath, extname(relativePath))
  const segments = resolveComponentNameSegments(fileName.toLowerCase() === 'index' ? '' : fileName, prefixParts).filter(Boolean)
  return kebabCase(segments).replace(QUOTE_RE, '')
}

export function hasSuffix (path: string, suffix: string) {
  return basename(path, extname(path)).endsWith(suffix)
}

export function resolveComponentNameSegments (fileName: string, prefixParts: string[]) {
  /**
   * Array of fileName parts split by case, / or -
   * @example third-component -> ['third', 'component']
   * @example AwesomeComponent -> ['Awesome', 'Component']
   */
  const fileNameParts = splitByCase(fileName)
  const fileNamePartsContent = fileNameParts.join('/').toLowerCase()
  const componentNameParts: string[] = prefixParts.flatMap(p => splitByCase(p))
  let index = prefixParts.length - 1
  const matchedSuffix: string[] = []
  while (index >= 0) {
    const prefixPart = prefixParts[index]!
    matchedSuffix.unshift(...splitByCase(prefixPart).map(p => p.toLowerCase()))
    const matchedSuffixContent = matchedSuffix.join('/')
    if ((fileNamePartsContent === matchedSuffixContent || fileNamePartsContent.startsWith(matchedSuffixContent + '/')) ||
      // e.g. Item/Item/Item.vue -> Item
      (prefixPart.toLowerCase() === fileNamePartsContent &&
        prefixParts[index + 1] &&
        prefixParts[index] === prefixParts[index + 1])) {
      componentNameParts.length = index
    }
    index--
  }
  return [...componentNameParts, ...fileNameParts]
}
