import * as fs from "fs"
import * as fsExtra from "fs-extra"
import p from "path"
import pino, { Logger } from "pino"
import { serialize } from "next-mdx-remote/serialize"
import { visit } from "unist-util-visit"
import * as utils from "./new-utils.mts"

const COURSES_ROOT_PATH = "/courses"
const MD_EXT = ".md"
const JSON_EXT = ".json"
const INDEX_FILE = "_index.md"
const SECTION_REGEX = /\d+\..+/
const MDX_SERIALIZE_OPTIONS = {
  mdxOptions: {
    remarkPlugins: [],
  },
  parseFrontmatter: true,
}
export const PRODUCTION = "production"

export let logger = pino({ name: "processCourse" })

export function processContent(workingDirPath: string) {
  const contentDirPath = p.join(workingDirPath, "content")
  const outputDirPath = p.join(workingDirPath, "content-processed")
  processSections(contentDirPath, outputDirPath)
  processMarkdownFiles(contentDirPath, outputDirPath)
  processOtherFiles(contentDirPath, outputDirPath)
}

export function processSections(contentDirPath: string, outputDirPath: string) {
  [contentDirPath, ...utils.fsFind(
    contentDirPath,
    false,
    (path: string) =>
      fs.lstatSync(path).isDirectory() && SECTION_REGEX.test(p.basename(path))
  )].forEach((inDirPath) => {
    processSection(contentDirPath, outputDirPath, inDirPath)
  })
}

export async function processSection(contentDirPath: string, outputDirPath: string, inDirPath: string) {
  let content = ""
  const inFilePath = p.join(inDirPath, INDEX_FILE)
  const outFilePath = p
    .join(outputDirPath, inFilePath.replace(contentDirPath, ""))
    .replace(MD_EXT, JSON_EXT)

  const inFileExists = utils.checkFileExists(inFilePath)
  if (inFileExists && utils.isFileAOlderThanB(outFilePath, inFilePath)) {
    content = fs.readFileSync(inFilePath, "utf8")
  } else if (!inFileExists) {
    const defaultName = p.basename(inDirPath).replace(/^\d+\./, "")
    content = [
      "---",
      `title: "PLACEHOLDER TITLE (missing _index.md): ${defaultName.replace(/-/, " ")}"`,
      `slug: ${defaultName}`,
      "---",
      "",
    ].join("\n")
  }

  const doWriteFile = content.length > 0
  if (doWriteFile) {
    const serialized = await serialize(
      content,
      {
        ...MDX_SERIALIZE_OPTIONS,
        mdxOptions: {
          remarkPlugins: [remarkProcessSection(inFilePath)],
        },
      },
    )
    fsExtra.ensureDirSync(p.dirname(outFilePath))
    fs.writeFileSync(outFilePath, JSON.stringify(serialized))
  }
}

export function remarkProcessSection(inFilePath: string) {
  const inDirPath = p.dirname(inFilePath)
  return () => async (tree, vFile) => {
    const imagePathPrefix = p.posix.join(
      COURSES_ROOT_PATH,
      await getSlugPathUp(p.dirname(inDirPath)),
      vFile.data.matter.slug,
    )

    if (vFile.data.matter.hasOwnProperty("thumbnail")) {
      const filePath = p.join(inDirPath, vFile.data.matter.thumbnail)
      utils.checkFileExists(
        filePath,
        `Couldn't find required '${filePath}' for '${inFilePath}' in frontmatter`
      )
      vFile.data.matter.thumbnail = p.posix.join(imagePathPrefix, vFile.data.matter.thumbnail)
    }

    visit(tree, rewriteImagePathsVisitor(inFilePath, imagePathPrefix))
  }
}

export function processMarkdownFiles(contentDirPath: string, outputDirPath: string) {
  utils.fsFind(
    contentDirPath,
    true,
    (path: string) => p.extname(path) === MD_EXT && p.basename(path) !== INDEX_FILE
  ).forEach((inFilePath) => {
    processMarkdownFile(contentDirPath, outputDirPath, inFilePath)
  })
}

export async function processMarkdownFile(contentDirPath: string, outputDirPath: string, inFilePath: string) {
  const outFilePath = p
    .join(outputDirPath, inFilePath.replace(contentDirPath, ""))
    .replace(MD_EXT, JSON_EXT)
  const doWriteFile = utils.isFileAOlderThanB(outFilePath, inFilePath)
  if (doWriteFile) {
    const serialized = await serialize(
      fs.readFileSync(inFilePath, "utf8"),
      {
        ...MDX_SERIALIZE_OPTIONS,
        mdxOptions: {
          remarkPlugins: [remarkProcessMarkdownFile(inFilePath)],
        },
      },
    )

    fsExtra.ensureDirSync(p.dirname(outFilePath))
    fs.writeFileSync(outFilePath, JSON.stringify(serialized))
  }
}

export function remarkProcessMarkdownFile(inFilePath: string) {
  return () => async (tree, vFile) => {
    const imagePathPrefix = p.posix.join(
      COURSES_ROOT_PATH,
      await getSlugPathUp(p.dirname(inFilePath)),
    )
    visit(tree, rewriteImagePathsVisitor(inFilePath, imagePathPrefix))
  }
}

export function processOtherFiles(contentDirPath: string, outputDirPath: string) {
  utils.fsFind(
    contentDirPath,
    true,
    (path: string) => fs.lstatSync(path).isFile() && p.extname(path) !== MD_EXT
  ).forEach((inFilePath) => {
    processOtherFile(contentDirPath, outputDirPath, inFilePath)
  })
}

export function processOtherFile(contentDirPath: string, outputDirPath: string, inFilePath: string) {
  const outFilePath = p.join(outputDirPath, inFilePath.replace(contentDirPath, ""))
  const doWriteFile = utils.isFileAOlderThanB(outFilePath, inFilePath)
  if (doWriteFile) {
    fsExtra.ensureDirSync(p.dirname(outFilePath))
    fs.copyFileSync(inFilePath, outFilePath)
  }
}

export async function getSlugPathUp(dirPath: string) {
  let partialResult: string[] = []
  while (true) {
    const inFilePath = p.join(dirPath, INDEX_FILE)
    dirPath = p.dirname(dirPath)

    if (fs.existsSync(inFilePath)) {
      const serialized = await serialize(
        fs.readFileSync(inFilePath, "utf8"),
        { parseFrontmatter: true },
      )

      if (serialized.frontmatter.hasOwnProperty("slug")) {
        partialResult.push(serialized.frontmatter.slug)
      }
    } else {
      break
    }
  }
  return p.posix.join(...partialResult.reverse());
}

export function rewriteImagePathsVisitor(inFilePath: string, imagePathPrefix: string) {
  const inDirPath = p.dirname(inFilePath)
  return (node) => {
    let checkFilePath = ""
    if (node.type === "image") {
      checkFilePath = p.join(inDirPath, node.url)
      node.url = p.posix.join(imagePathPrefix, node.url)
    } else if (node.type === "mdxJsxFlowElement" && node.name === "img") {
      node.attributes
        .filter((attr) => attr.name === "src")
        .forEach((attr) => {
          checkFilePath = p.join(inDirPath, attr.value)
          attr.value = p.posix.join(imagePathPrefix, attr.value)
        })
    }

    if (checkFilePath.length > 0) {
      utils.checkFileExists(
        checkFilePath,
        `Couldn't find required '${checkFilePath}' for '${inFilePath}' at line '${node.position.start.line}' relative to frontmatter`
      )
    }
  }
}

export function extractTextBetweenAnchors(content: string, anchorName: string) {
  const anchorPattern = new RegExp(
    `(?:#|\\/\\/)\\s*ANCHOR:\\s*\\b${anchorName}\\b\\s*\\r?\\n(.*?)\\s*(?:#|\\/\\/)\\s*END:\\s*\\b${anchorName}\\b`,
    "gms"
  )
  const match = anchorPattern.exec(content)
  if (!match[1]) {
    throw Error(`No matching '${anchorName}' anchor found`)
  }
  return match[1]
}

export function setLogger(newLogger: Logger) {
  logger = newLogger
}
