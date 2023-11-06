import * as fs from "fs"
import p from "path"
import klawSync from "klaw-sync"
import lqip from 'lqip-modern'
import { getLogger, logger, PRODUCTION } from "./index.mjs"

export function fsFind(path: string, klawOptions: klawSync.Options) {
  return klawSync(path, klawOptions).map(({ path }) => path) as string[]
}

export function isFileAOlderThanB(pathA: string, pathB: string) {
  return !fs.existsSync(pathA) || (fs.existsSync(pathA) && fs.lstatSync(pathA).mtimeMs < fs.lstatSync(pathB).mtimeMs)
}

export const logOrThrow = (logger: ReturnType<typeof getLogger>, errorMessage: string): void => {
	if (process.env.NODE_ENV === PRODUCTION) {
		const error = Error(errorMessage)
		logger.error(error.message)
		throw error
	} else {
		logger.error(errorMessage)
	}
}

export function checkPathExists(path: string, errorMessage: string, logger: ReturnType<typeof getLogger>) {
  let result = true
  if (!fs.existsSync(path)) {
    result = false
    logOrThrow(logger, errorMessage)
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
		const message = error instanceof Error ? error.message : 'Error downscaling image'
    if (process.env.NODE_ENV === PRODUCTION) {
      logger.error(message)
      throw error
    } else {
      logger.warn(message)
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
