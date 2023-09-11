import * as fs from "fs"
import p from "path"

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
