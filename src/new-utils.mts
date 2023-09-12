import * as fs from "fs"
import p from "path"
import { logger, PRODUCTION } from "./new-index.mts"

export function fsFind(currentPath: string, isRecursive: boolean, findPredicate: (path: string) => boolean, ignorePredicate = (path: string) => false): string[] {
  const go = (path: string, result: string[]) => {
    const listing = fs.readdirSync(path)
    for (let name of listing) {
      const listingPath = p.join(path, name)
      if (ignorePredicate(path)) {
        continue
      }

      if (findPredicate(listingPath)) {
        result.push(listingPath)
      }

      if (fs.statSync(listingPath).isDirectory() && isRecursive) {
        go(listingPath, result)
      }
    }
    return result
  }
  return go(currentPath, [])
}

export function isFileAOlderThanB(pathA: string, pathB: string) {
  return !fs.existsSync(pathA) || (fs.existsSync(pathA) && fs.lstatSync(pathA).mtimeMs < fs.lstatSync(pathB).mtimeMs)
}

export function checkFileExists(filePath: string, errorMessage?: string) {
  let result = true
  if (!fs.existsSync(filePath)) {
    result = false
    errorMessage ??= `Couldn't find required file '${filePath}'`
    const error = Error(errorMessage)
    logger.error(error.message)
    if (process.env.NODE_ENV === PRODUCTION) {
      throw error
    }
  }
  return result
}
