import * as fs from "fs"
import * as fse from "fs-extra/esm"
import * as chokidar from "chokidar"
import p from "path"
import AdmZip from "adm-zip"
import pino, { Logger } from "pino"
import matter, { GrayMatterFile } from "gray-matter"
import remarkGfm from "remark-gfm"
import remarkUnwrapImages from "remark-unwrap-images"
import rehypeSlug from "rehype-slug"
import rehypeCodeTitles from "rehype-code-titles"
import rehypePrism from "rehype-prism-plus"
import rehypeAutolinkHeadings from "rehype-autolink-headings"
import slugify from "slugify"
import { serialize } from "next-mdx-remote/serialize"
import { visit } from "unist-util-visit"
import * as utils from "./utils.mts"
import { exec, execFile, execFileSync } from "child_process"

type VisitedNodes = {
  images: any[],
  links: any[],
}

const COURSE_ROOT_PATH = "/course"
const COURSES_ROOT_PATH = "/courses"
const PUBLIC_DIR = "public"
const MD_EXT = ".md"
const JSON_EXT = ".json"
const INDEX_FILE = "_index.md"
const GODOT_EXE = "godot"
const GODOT_PRACTICE_BUILD = ["addons", "gdquest_practice_framework", "build.gd"]
const GODOT_PROJECT_FILE = "project.godot"
const GODOT_IGNORED = [".plugged", ".git", ".gitattributes", ".gitignore"]
const SECTION_REGEX = /\d+\..+/

export const PRODUCTION = "production"

export let logger = pino({ name: "processCourse" })

export function watchAll(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  watchContent(workingDirPath, contentDirPath, outputDirPath)
  watchGodotProjects(workingDirPath, outputDirPath)
}

export function watchContent(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  const watcher = chokidar.watch(contentDirPath, { ignored: "*~" })
  watcher.on("all", (eventName, inPath) => {
    if (eventName === "unlink" || eventName === "unlinkDir") {
      fse.removeSync(p.join(outputDirPath, p.relative(contentDirPath, inPath)))
    } else if (eventName === "change") {
      if (p.basename(inPath) === INDEX_FILE) {
        processSection(p.dirname(inPath), workingDirPath, contentDirPath, outputDirPath)
      } else if (p.extname(inPath) === MD_EXT) {
        processMarkdownFile(inPath, workingDirPath, contentDirPath, outputDirPath)
      } else {
        processOtherFile(inPath, workingDirPath, contentDirPath, outputDirPath)
      }
    }
  })
}

export function watchGodotProjects(workingDirPath: string, outputDirPath: string) {
  const godotProjectDirPaths = utils.fsFind(
    workingDirPath,
    false,
    (path: string) => fs.existsSync(p.join(path, GODOT_PROJECT_FILE))
  )
  for (const godotProjectDirPath of godotProjectDirPaths) {
    const watcher = chokidar.watch(
      godotProjectDirPath,
      { ignored: ["*~", ...GODOT_IGNORED.map((path) => `**/${path}`)] }
    )
    watcher.on("all", () => {
      processGodotProject(godotProjectDirPath, outputDirPath)
    })
  }
}

export function processAll(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  // processContent(workingDirPath, contentDirPath, outputDirPath)
  processGodotProjects(workingDirPath, outputDirPath)
}

export function processContent(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  processSections(workingDirPath, contentDirPath, outputDirPath)
  processMarkdownFiles(workingDirPath, contentDirPath, outputDirPath)
  processOtherFiles(workingDirPath, contentDirPath, outputDirPath)
}

export function processSections(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  const inDirPaths = [contentDirPath, ...utils.fsFind(
    contentDirPath,
    false,
    (path: string) => fs.lstatSync(path).isDirectory() && SECTION_REGEX.test(p.basename(path))
  )]
  for (const inDirPath of inDirPaths) {
    processSection(inDirPath, workingDirPath, contentDirPath, outputDirPath)
  }
}

export async function processSection(inDirPath: string, workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  let content = ""
  const inFilePath = p.join(inDirPath, INDEX_FILE)
  const outFilePath = p
    .join(outputDirPath, p.relative(contentDirPath, inFilePath))
    .replace(MD_EXT, JSON_EXT)

  const inFileExists = utils.checkPathExists(inFilePath)
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
  }
}

export function remarkProcessSection(inFilePath: string, workingDirPath: string) {
  const inDirPath = p.dirname(inFilePath)
  return () => (tree, vFile) => {
    const imagePathPrefix = p.posix.join(
      COURSES_ROOT_PATH,
      ...getSlugsUp(p.dirname(inDirPath)),
      vFile.data.matter.slug,
    )

    if (vFile.data.matter.hasOwnProperty("thumbnail")) {
      const filePath = p.join(inDirPath, vFile.data.matter.thumbnail)
      utils.checkPathExists(
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

export function processMarkdownFiles(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  const inFilePaths = utils.fsFind(
    contentDirPath,
    true,
    (path: string) => p.extname(path) === MD_EXT && p.basename(path) !== INDEX_FILE
  )
  for (const inFilePath of inFilePaths) {
    processMarkdownFile(inFilePath, workingDirPath, contentDirPath, outputDirPath)
  }
}

export async function processMarkdownFile(inFilePath: string, workingDirPath: string, contentDirPath: string, outputDirPath: string) {
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
  }
}

export function remarkProcessMarkdownFile(inFilePath: string, workingDirPath: string) {
  return () => (tree, vFile) => {
    const imagePathPrefix = p.posix.join(
      COURSES_ROOT_PATH,
      ...getSlugsUp(p.dirname(inFilePath)),
    )

    let visited: VisitedNodes = {
      images: [],
      links: [],
    }
    visit(tree, visitor(visited))

    rewriteImagePaths(visited.images, inFilePath, imagePathPrefix)
    rewriteLinks(visited.links, inFilePath, workingDirPath)
  }
}

export function processOtherFiles(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  const inFilePaths = utils.fsFind(
    contentDirPath,
    true,
    (path: string) => fs.lstatSync(path).isFile() && p.extname(path) !== MD_EXT
  )
  for (const inFilePath of inFilePaths) {
    processOtherFile(inFilePath, workingDirPath, contentDirPath, outputDirPath)
  }
}

export function processOtherFile(inFilePath: string, workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  const outFilePath = p.join(outputDirPath, inFilePath.replace(contentDirPath, ""))
  const doWriteFile = utils.isFileAOlderThanB(outFilePath, inFilePath)
  if (doWriteFile) {
    fse.ensureDirSync(p.dirname(outFilePath))
    fs.copyFileSync(inFilePath, outFilePath)
  }
}

export function getSlugsUp(dirPath: string) {
  type FrontMatter = GrayMatterFile<string> & {
    data: {
      title?: string,
      slug?: string
    }
  }

  let partialResult: string[] = []
  while (true) {
    const inFilePath = p.join(dirPath, INDEX_FILE)
    dirPath = p.dirname(dirPath)

    if (fs.existsSync(inFilePath)) {
      const { data: frontmatter }: FrontMatter = matter(fs.readFileSync(inFilePath, "utf8"))
      frontmatter.data
      if (frontmatter.hasOwnProperty("slug")) {
        partialResult.push(frontmatter.slug)
      } else if (frontmatter.hasOwnProperty("title")) {
        partialResult.push(slugify(frontmatter.title, {
          replacement: "-",
          lower: true,
          strict: true,
        }))
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
      try {
        new URL(node.url)
      } catch {
        visited.links.push(node)
      }
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
      utils.checkPathExists(
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
    }

    utils.checkPathExists(checkFilePath, `Couldn't find required '${checkFilePath}' for '${inFilePath}' at line ${node.position.start.line} relative to frontmatter`)
    node.url = node.url.replace(MD_EXT, "")
  }
}

export function processGodotProjects(workingDirPath: string, outputDirPath: string) {
  const godotProjectDirPaths = utils.fsFind(
    workingDirPath,
    false,
    (path: string) => fs.existsSync(p.join(path, GODOT_PROJECT_FILE))
  )
  for (const godotProjectDirPath of godotProjectDirPaths) {
    processGodotProject(godotProjectDirPath, outputDirPath)
  }
}

export function processGodotProject(godotProjectDirPath: string, outputDirPath: string) {
  const outDirPath = p.join(outputDirPath, PUBLIC_DIR, `${p.basename(godotProjectDirPath)}.zip`)
  if (!utils.isFileAOlderThanB(outDirPath, godotProjectDirPath)) {
    return
  }

  const godotProjectFilePaths = utils.fsFind(
    godotProjectDirPath,
    true,
    (path: string) =>
      fs.lstatSync(path).isFile() && !GODOT_IGNORED.some((dir: string) => path.includes(`${dir}`))
  )

  if (godotProjectFilePaths.length > 0) {
    const godotPracticeBuildPath = p.join(godotProjectDirPath, ...GODOT_PRACTICE_BUILD)
    if (fs.existsSync(godotPracticeBuildPath)) {
      logger.info(execFileSync(GODOT_EXE, ["--path", godotProjectDirPath, "--headless", "--script", godotPracticeBuildPath]).toString("utf8"))
    }

    const zip = new AdmZip()
    for (const godotProjectFilePath of godotProjectFilePaths) {
      const zipDirPath = p.relative(godotProjectDirPath, p.dirname(godotProjectFilePath))
      zip.addLocalFile(godotProjectFilePath, zipDirPath)
    }
    fse.ensureDirSync(p.dirname(outDirPath))
    zip.writeZip(outDirPath)
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
