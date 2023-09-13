import * as fs from "fs"
import * as fse from "fs-extra/esm"
import p from "path"
import pino, { Logger } from "pino"
import remarkGfm from "remark-gfm"
import remarkUnwrapImages from "remark-unwrap-images"
import rehypeSlug from "rehype-slug"
import rehypeCodeTitles from "rehype-code-titles"
import rehypePrism from "rehype-prism-plus"
import rehypeAutolinkHeadings from "rehype-autolink-headings"
import { serialize } from "next-mdx-remote/serialize"
import { visit } from "unist-util-visit"
import { zip } from "zip-a-folder"
import * as utils from "./new-utils.mts"

type VisitedNodes = {
  images: any[],
  links: any[],
}

const COURSE_ROOT_PATH = "/course"
const COURSES_ROOT_PATH = "/courses"
const MD_EXT = ".md"
const JSON_EXT = ".json"
const INDEX_FILE = "_index.md"
const GODOT_PROJECT_FILE = "project.godot"
const GODOT_PLUGGED_DIR = `.plugged${p.sep}`
const SECTION_REGEX = /\d+\..+/

let cache = {}

export const PRODUCTION = "production"

export let logger = pino({ name: "processCourse" })

export async function processContent(workingDirPath: string) {
  const contentDirPath = p.join(workingDirPath, "content")
  const outputDirPath = p.join(workingDirPath, "content-processed")
  const processedParts = await Promise.all([
    processSections(workingDirPath, contentDirPath, outputDirPath),
    processMarkdownFiles(workingDirPath, contentDirPath, outputDirPath),
    processOtherFiles(workingDirPath, contentDirPath, outputDirPath),
    processGodotProjects(workingDirPath, outputDirPath)
  ])
  cache = Object.assign(cache, ...processedParts)
}

export async function processSections(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  let result = {}
  const inDirPaths = [contentDirPath, ...utils.fsFind(
    contentDirPath,
    false,
    (path: string) =>
      fs.lstatSync(path).isDirectory() && SECTION_REGEX.test(p.basename(path))
  )]
  for (const inDirPath of inDirPaths) {
    result = { ...result, ...await processSection(inDirPath, workingDirPath, contentDirPath, outputDirPath) }
  }
  return result
}

export async function processSection(inDirPath: string, workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  let result = {}
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
    const serialized = await getSerialized(
      content,
      [remarkProcessSection(inFilePath, workingDirPath)]
    )
    fse.ensureDirSync(p.dirname(outFilePath))
    fs.writeFileSync(outFilePath, JSON.stringify(serialized))
    result = { ...result, [outFilePath]: serialized }
  }
  return result
}

export function remarkProcessSection(inFilePath: string, workingDirPath: string) {
  const inDirPath = p.dirname(inFilePath)
  return () => async (tree, vFile) => {
    const imagePathPrefix = p.posix.join(
      COURSES_ROOT_PATH,
      ...await getSlugsUp(p.dirname(inDirPath)),
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

    let visited: VisitedNodes = {
      images: [],
      links: [],
    }
    visit(tree, visitor(visited))

    rewriteImagePaths(visited.images, inFilePath, imagePathPrefix)
    rewriteLinks(visited.links, inFilePath, workingDirPath)
  }
}

export async function processMarkdownFiles(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  let result = {}
  const inFilePaths = utils.fsFind(
    contentDirPath,
    true,
    (path: string) => p.extname(path) === MD_EXT && p.basename(path) !== INDEX_FILE
  )
  for (const inFilePath of inFilePaths) {
    result = { ...result, ...await processMarkdownFile(inFilePath, workingDirPath, contentDirPath, outputDirPath) }
  }
  return result
}

export async function processMarkdownFile(inFilePath: string, workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  let result = {}
  const outFilePath = p
    .join(outputDirPath, inFilePath.replace(contentDirPath, ""))
    .replace(MD_EXT, JSON_EXT)
  const doWriteFile = utils.isFileAOlderThanB(outFilePath, inFilePath)
  if (doWriteFile) {
    const serialized = await getSerialized(
      fs.readFileSync(inFilePath, "utf8"),
      [remarkProcessMarkdownFile(inFilePath, workingDirPath)]
    )
    fse.ensureDirSync(p.dirname(outFilePath))
    fs.writeFileSync(outFilePath, JSON.stringify(serialized))
    result = { ...result, [outFilePath]: serialized }
  }
  return result
}

export function remarkProcessMarkdownFile(inFilePath: string, workingDirPath: string) {
  return () => async (tree, vFile) => {
    const imagePathPrefix = p.posix.join(
      COURSES_ROOT_PATH,
      ...await getSlugsUp(p.dirname(inFilePath)),
    )

    let visited: VisitedNodes = {
      images: [],
      links: [],
    }
    visit(tree, visitor(visited))

    await Promise.all([
      rewriteImagePaths(visited.images, inFilePath, imagePathPrefix),
      rewriteLinks(visited.links, inFilePath, workingDirPath),
    ])
  }
}

export function processOtherFiles(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  let result = {}
  const inFilePaths = utils.fsFind(
    contentDirPath,
    true,
    (path: string) => fs.lstatSync(path).isFile() && p.extname(path) !== MD_EXT
  )
  for (const inFilePath of inFilePaths) {
    result = { ...result, ...processOtherFile(inFilePath, workingDirPath, contentDirPath, outputDirPath) }
  }
  return result
}

export function processOtherFile(inFilePath: string, workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  let result = {}
  const outFilePath = p.join(outputDirPath, inFilePath.replace(contentDirPath, ""))
  const doWriteFile = utils.isFileAOlderThanB(outFilePath, inFilePath)
  if (doWriteFile) {
    fse.ensureDirSync(p.dirname(outFilePath))
    fs.copyFileSync(inFilePath, outFilePath)
    result = { ...result, [outFilePath]: inFilePath }
  }
  return result
}

export async function getSlugsUp(dirPath: string) {
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
  return partialResult.reverse();
}

export function visitor(visited: VisitedNodes) {
  return (node) => {
    if (node.type === "image" || (node.type === "mdxJsxFlowElement" && node.name === "img")) {
      visited.images.push(node)
    } else if (node.type === "link" && p.extname(node.url) === MD_EXT) {
      visited.links.push(node)
    }
  }
}

export function rewriteImagePaths(nodes: any[], inFilePath: string, imagePathPrefix: string) {
  for (let node of nodes) {
    const inDirPath = p.dirname(inFilePath)
    let checkFilePath = ""
    if (node.type === "image") {
      checkFilePath = p.join(inDirPath, node.url)
      node.url = p.posix.join(imagePathPrefix, node.url)
    } else if (node.type === "mdxJsxFlowElement" && node.name === "img") {
      node.attributes
        .filter((attr) => attr.name === "src")
        .map((attr) => {
          checkFilePath = p.join(inDirPath, attr.value)
          return { ...attr, value: p.posix.join(imagePathPrefix, attr.value) }
        })
    }

    if (checkFilePath.length > 0) {
      utils.checkFileExists(
        checkFilePath,
        `Couldn't find required '${checkFilePath}' for '${inFilePath}' at line ${node.position.start.line} relative to frontmatter`
      )
    }
  }
}

export function rewriteLinks(nodes: any[], inFilePath: string, workingDirPath: string) {
  const inDirPath = p.dirname(inFilePath)
  for (let node of nodes) {
    let checkFilePath = ""
    if (node.url.startsWith(COURSE_ROOT_PATH)) {
      checkFilePath = p.join(workingDirPath, "..", node.url.replace(COURSE_ROOT_PATH, ""))
    } else {
      checkFilePath = p.resolve(inDirPath, node.url)
      utils.checkFileExists(checkFilePath)
    }

    utils.checkFileExists(checkFilePath, `Couldn't find required '${checkFilePath}' for '${inFilePath}' at line ${node.position.start.line} relative to frontmatter`)
    node.url = node.url.replace(MD_EXT, "")
  }
}

export async function processGodotProjects(workingDirPath: string, outputDirPath: string) {
  const godotProjectDirPaths = utils
    .fsFind(
      workingDirPath,
      true,
      (path: string) =>
        p.basename(path) === GODOT_PROJECT_FILE && !path.includes(GODOT_PLUGGED_DIR)
    ).map((path: string) => p.dirname(path))
  const outTmpDirPath = p.join(outputDirPath, "tmp")
  await Promise.all(
    godotProjectDirPaths.map(async (godotProjectDirPath: string) => {
      const godotProjectDirName = p.basename(godotProjectDirPath)
      const godotPluggedDirPath = p.join(godotProjectDirPath, GODOT_PLUGGED_DIR)
      const outDirPath = p.join(outputDirPath, "public", godotProjectDirName)
      const outGodotPluggedDirPath = p.join(outTmpDirPath, godotProjectDirName, GODOT_PLUGGED_DIR)
      const zipFilePath = `${outDirPath}.zip`
      if (fs.existsSync(godotPluggedDirPath)) {
        fse.ensureDirSync(p.dirname(outGodotPluggedDirPath))
        fse.moveSync(godotPluggedDirPath, outGodotPluggedDirPath, { overwrite: true })
      }

      fse.ensureDirSync(p.dirname(outDirPath))
      await zip(godotProjectDirPath, zipFilePath)

      if (fs.existsSync(outGodotPluggedDirPath)) {
        fse.moveSync(outGodotPluggedDirPath, godotPluggedDirPath, { overwrite: true })
      }
    })
  )
  fse.removeSync(outTmpDirPath)
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

export async function getSerialized(source: string, remarkPlugins = [], rehypePlugins = []) {
  const result = await serialize(
    source,
    {
      mdxOptions: {
        development: process.env.NODE_ENV !== PRODUCTION,
        remarkPlugins: [
          remarkGfm,
          remarkUnwrapImages,
          ...remarkPlugins
        ],
        rehypePlugins: [
          rehypeSlug,
          rehypeCodeTitles,
          rehypePrism,
          [rehypeAutolinkHeadings, { properties: { className: ['header-link'] } }],
          ...rehypePlugins
        ],
      },
      parseFrontmatter: true,
    },
  )
  result.scope = result.frontmatter
  return result
}

export function setLogger(newLogger: Logger) {
  logger = newLogger
}
