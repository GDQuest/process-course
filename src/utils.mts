import * as fs from "fs"
import klawSync from "klaw-sync"
import { logger, PRODUCTION } from "./index.mts"

export function fsFind(path: string, klawOptions: klawSync.Options) {
  return klawSync(path, klawOptions).map(({ path }) => path) as string[]
}

export function isFileAOlderThanB(pathA: string, pathB: string) {
  return !fs.existsSync(pathA) || (fs.existsSync(pathA) && fs.lstatSync(pathA).mtimeMs < fs.lstatSync(pathB).mtimeMs)
}

export function checkPathExists(path: string, errorMessage?: string) {
  let result = true
  if (!fs.existsSync(path)) {
    result = false
    const error = Error(errorMessage || `Couldn't find required file '${path}'`)
    if (process.env.NODE_ENV === PRODUCTION) {
      logger.error(error.message)
      throw error
    } else {
      logger.warn(error.message)
    }
  }
  return result
}

export function isObjectEmpty(object: Object) {
  return Object.keys(object).length === 0
}
