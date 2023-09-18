import * as fs from "fs"
import p from "path"
import klawSync from "klaw-sync"
import lqip from 'lqip-modern'
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

export async function downscaleImage(inFilePath: string) {
  try {
    const { metadata } = await lqip(inFilePath)
    return metadata.dataURIBase64
  } catch (error) {
    if (process.env.NODE_ENV === PRODUCTION) {
      logger.error(error.message)
      throw error
    } else {
      logger.warn(error.message)
    }
  }
}

export function getDate() {
  const today = new Date()
  const year = today.getFullYear()
  const month = (today.getMonth() + 1).toString().padStart(2, '0')
  const day = today.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getGitHash(path: string) {
  const gitPath = p.join(path, '.git')
  const gitHeadPath = p.join(gitPath, 'HEAD')
  if (fs.existsSync(gitHeadPath)) {
    const rev = fs.readFileSync(gitHeadPath).toString().trim().split(/.*[: ]/).slice(-1)[0];
    if (rev.indexOf('/') === -1) {
      return rev;
    } else {
      return fs.readFileSync(p.join(gitPath, rev)).toString().trim();
    }
  }
  return ""
}
