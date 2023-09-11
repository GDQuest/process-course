import * as fs from "fs"
import * as fsExtra from "fs-extra"
import p from "path"
import matter from "gray-matter"
import pino, { Logger } from "pino"
// import { Logger } from "pino"
import slugify from "slugify"
import * as utils from "./new-utils.mjs"

const MD_EXT = ".md"
const INDEX_FILE = "_index.md"
const SECTION_REGEX = /\d+\..+/
const MARKDOWN_IMAGE_PATH_REGEX = /!\[(.*?)\]\((.+?)\)/g
const HTML_IMAGE_PATH_REGEX = /<img src="(.+?)"(.+?)\/>/g
const THUMBNAIL_IMAGE_PATH_REGEX = /^thumbnail:\s*(.*)$/gm

let logger: Logger = pino({
  name: "processCourse",
})

export function processContent(workingDirPath: string) {
  const contentDirPath = p.join(workingDirPath, "content")
  const outputDirPath = p.join(workingDirPath, "content-processed")
  processSections(contentDirPath, outputDirPath)
}

export function processSections(contentDirPath: string, outputDirPath: string) {
  const dirPaths = [contentDirPath, ...utils.fsFind(
    contentDirPath,
    false,
    (path: string) =>
      fs.lstatSync(path).isDirectory() && SECTION_REGEX.test(p.basename(path))
  )]
  for (const dirPath of dirPaths) {
    processSection(contentDirPath, outputDirPath, dirPath)
  }
}

export function processSection(contentDirPath: string, outputDirPath: string, dirPath: string) {
  const inFilePath = p.join(dirPath, INDEX_FILE)
  const outFilePath = p.join(outputDirPath, inFilePath.replace(contentDirPath, ""))
  fsExtra.ensureDirSync(p.dirname(outFilePath))
  if (fs.existsSync(inFilePath)) {
    if (utils.isFileAOlderThanB(outFilePath, inFilePath)) {
      let content = fs.readFileSync(inFilePath, "utf8")
      content = rewriteImagePaths(content, inFilePath)
      fs.writeFileSync(outFilePath, content)
    }
  } else {
    const error = Error(`Could not find required '${inFilePath}' file.`)
    logger.error(error.message)
    if (process.env.NODE_ENV === "production") {
      throw error
    }

    const defaultName = p.basename(dirPath).replace(/^\d+\./, "")
    const defaultContent = [
      "---",
      `title: "PLACEHOLDER TITLE (missing _index.md): ${defaultName.replace(/-/, " ")}"`,
      `slug: "${defaultName}"`,
      "---",
      "",
    ].join("\n")
    fs.writeFileSync(outFilePath, defaultContent)
  }
}

export function processMarkdownFiles(contentDirPath: string, outputDirPath: string) {
  const filePaths = utils.fsFind(
    contentDirPath,
    true,
    (path: string) => p.extname(path) == MD_EXT
  )
  for (const filePath of filePaths) {
    processMarkdownFile(outputDirPath, filePath)
  }
}

export function processMarkdownFile(outputDirPath: string, filePath: string) {
}

function rewriteImagePaths(content: string, filePath: string) {
  const imagePathPrefix = p.join("/courses", getSlugPath(filePath, content))
  return content.replace(
    MARKDOWN_IMAGE_PATH_REGEX,
    (_, altText, imagePath) => `![${altText}](${p.join(imagePathPrefix, imagePath)})`
  ).replace(
    HTML_IMAGE_PATH_REGEX,
    (_, imagePath, attributes) => `<img src="${p.join(imagePathPrefix, imagePath)}"${attributes}/>`
  ).replace(
    THUMBNAIL_IMAGE_PATH_REGEX,
    (_, imagePath) => `thumbnail: ${p.join(imagePathPrefix, imagePath)}`
  )
}

export function getSlugPath(filePath: string, content?: string) {
  let partialResult: string[] = []
  let dirPath = p.dirname(filePath)
  while (true) {
    if (fs.existsSync(filePath)) {
      if (content === null) {
        content = fs.readFileSync(filePath, "utf8")
      }
      if (p.basename(filePath) === INDEX_FILE) {
        partialResult.push(matter(content).data.slug)
      } else if (p.extname(filePath) === MD_EXT) {
        partialResult.push(slugify(matter(content).data.title, {
          replacement: "-",
          lower: true,
          strict: true,
        }))
      }
    } else {
      break
    }
    dirPath = p.resolve(dirPath, "..")
    filePath = p.join(dirPath, INDEX_FILE)
    content = null
  }
  return p.join(...partialResult.reverse())
}


export function setLogger(newLogger: Logger) {
  logger = newLogger
}
