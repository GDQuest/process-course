import * as fs from "fs"
import * as fse from "fs-extra"
import * as chokidar from "chokidar"
import p from "path"
import AdmZip from "adm-zip"
import pino, { Logger } from "pino"
import matter from "gray-matter"
import remarkGfm from "remark-gfm"
import remarkUnwrapImages from "remark-unwrap-images"
import rehypeSlug from "rehype-slug"
import rehypeCodeTitles from "rehype-code-titles"
import rehypePrism from "rehype-prism-plus"
import rehypeAutolinkHeadings from "rehype-autolink-headings"
import slugify from "slugify"
import { execFileSync } from "child_process"
import { serialize } from "next-mdx-remote/serialize"
import { visit } from "unist-util-visit"
import { VFile } from "vfile"
import * as utils from "./utils.mts"

type RemarkVisitedNodes = {
  images: any[],
  links: any[],
}

type RehypeVisitedNodes = { headings: any[] }

const COURSE_ROOT_PATH = "/course"
const COURSES_ROOT_PATH = "/courses"
const PUBLIC_DIR = "public"
const MD_EXT = ".md"
const JSON_EXT = ".json"
const IN_INDEX_FILE = `_index${MD_EXT}`
const OUT_INDEX_FILE = `index${JSON_EXT}`
const GODOT_EXE = "godot"
const GODOT_PRACTICE_BUILD = ["addons", "gdquest_practice_framework", "build.gd"]
const GODOT_PROJECT_FILE = "project.godot"
const GODOT_IGNORED = [".plugged", ".git", ".gitattributes", ".gitignore"]
const SECTION_REGEX = /\d+\..+/
const HTML_COMMENT_REGEX = /<\!--.*?-->/g
const GDSCRIPT_CODEBLOCK_REGEX = /(```gdscript:.*)(_v\d+)(.gd)/g

const SLUGIFY_OPTIONS = {
  replacement: "-",
  lower: true,
  strict: true,
}

export const PRODUCTION = "production"

let cache = {
  index: {},
}
export let logger = pino({ name: "processCourse" })

export function watchAll(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  watchContent(workingDirPath, contentDirPath, outputDirPath)
  watchGodotProjects(workingDirPath, outputDirPath)
}

export function watchContent(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  if (utils.isObjectEmpty(cache.index)) {
    indexSections(contentDirPath)
  }

  const watcher = chokidar.watch(contentDirPath, { ignored: "*~" })
  watcher.on("all", (eventName, inPath) => {
    if (eventName === "unlink" || eventName === "unlinkDir") {
      fse.removeSync(p.join(outputDirPath, p.relative(contentDirPath, inPath)))
    } else if (eventName === "change") {
      if (p.basename(inPath) === IN_INDEX_FILE) {
        indexSection(p.dirname(inPath))
      } else if (p.extname(inPath) === MD_EXT) {
        processMarkdownFile(inPath, workingDirPath, outputDirPath)
      } else {
        processOtherFile(inPath, contentDirPath, outputDirPath)
      }
    }
  })
}

export function watchGodotProjects(workingDirPath: string, outputDirPath: string) {
  const godotProjectDirPaths = utils.fsFind(
    workingDirPath,
    {
      depthLimit: 0,
      nofile: true,
      filter: ({ path }) => fs.existsSync(p.join(path, GODOT_PROJECT_FILE)),
    },
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
  processContent(workingDirPath, contentDirPath, outputDirPath)
  processGodotProjects(workingDirPath, outputDirPath)
}

export function processContent(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  indexSections(contentDirPath)
  processCourse(contentDirPath, outputDirPath)
  processMarkdownFiles(workingDirPath, contentDirPath, outputDirPath)
  processOtherFiles(contentDirPath, outputDirPath)
}

export function indexSections(contentDirPath: string) {
  const inDirPaths = [contentDirPath, ...utils.fsFind(
    contentDirPath,
    {
      depthLimit: 0,
      nofile: true,
      filter: ({ path }) => SECTION_REGEX.test(p.basename(path))
    }
  )]
  for (const inDirPath of inDirPaths) {
    indexSection(inDirPath)
  }
}

export function indexSection(inDirPath: string) {
  let content = ""
  const inFilePath = p.join(inDirPath, IN_INDEX_FILE)
  if (utils.checkPathExists(inFilePath)) {
    content = fs.readFileSync(inFilePath, "utf8")
  } else {
    const defaultName = p.basename(inDirPath).replace(/^\d+\./, "")
    content = [
      "---",
      `title: "PLACEHOLDER TITLE (missing _index.md): ${defaultName.replace(/-/, " ")}"`,
      `slug: ${defaultName}`,
      "---",
      "",
    ].join("\n")
  }

  if (content !== "") {
    const { data: frontmatter } = matter(content)
    frontmatter.slug ??= slugify(frontmatter.title as string, SLUGIFY_OPTIONS)
    cache.index = { ...cache.index, [inDirPath]: frontmatter }
  }
}

export function processCourse(contentDirPath: string, outputDirPath: string) {
  const frontmatter = cache.index[contentDirPath]
  const inFilePath = p.join(contentDirPath, IN_INDEX_FILE)
  const outFilePath = p.join(outputDirPath, OUT_INDEX_FILE)
  const doWriteFile = utils.isFileAOlderThanB(outFilePath, inFilePath)
  if (doWriteFile) {
    fse.ensureDirSync(p.dirname(outFilePath))
    fs.writeFileSync(outFilePath, JSON.stringify({
      title: frontmatter.title,
      slug: frontmatter.slug,
    }))
  }
}


export function processMarkdownFiles(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  const inFilePaths = utils.fsFind(
    contentDirPath,
    {
      nodir: true,
      traverseAll: true,
      filter: ({ path }) => p.extname(path) === MD_EXT && p.basename(path) !== IN_INDEX_FILE
    }
  )
  for (const inFilePath of inFilePaths) {
    processMarkdownFile(inFilePath, workingDirPath, outputDirPath)
  }
}

export async function processMarkdownFile(inFilePath: string, workingDirPath: string, outputDirPath: string) {
  const { data: frontmatter, content } = matter(fs.readFileSync(inFilePath, "utf8")
    .replace(HTML_COMMENT_REGEX, "")
    .replace(GDSCRIPT_CODEBLOCK_REGEX, "$1$3"))
  frontmatter.slug ??= slugify(frontmatter.title as string, SLUGIFY_OPTIONS)
  if (process.env.NODE_ENV === PRODUCTION && frontmatter.draft) {
    return
  }
  const slugs = getSlugs(p.dirname(inFilePath))
  const outFilePath = `${p.join(outputDirPath, ...slugs.slice(1), frontmatter.slug)}${JSON_EXT}`
  const doWriteFile = utils.isFileAOlderThanB(outFilePath, inFilePath)
  if (doWriteFile) {
    let vFile = new VFile(content)
    const serializedMDX = await getSerialized(
      vFile,
      frontmatter,
      [remarkProcessMarkdownFile(inFilePath, workingDirPath)],
      [rehypeProcessMarkdownFile],
    )

    const url = p.posix.join(COURSE_ROOT_PATH, ...slugs, frontmatter.slug)
    fse.ensureDirSync(p.dirname(outFilePath))
    fs.writeFileSync(outFilePath, JSON.stringify({
      url,
      slug: frontmatter.slug,
      serializedMDX,
      toc: vFile.data.toc,
      free: frontmatter.free || false,
      draft: frontmatter.draft || false,
      prev: null,
      next: null,
    }))
  }
}

export function remarkProcessMarkdownFile(inFilePath: string, workingDirPath: string) {
  return () => (tree) => {
    const imagePathPrefix = p.posix.join(
      COURSES_ROOT_PATH,
      ...getSlugs(p.dirname(inFilePath)),
    )
    let visited: RemarkVisitedNodes = {
      images: [],
      links: [],
    }
    visit(tree, remarkVisitor(visited))
    rewriteImagePaths(visited.images, inFilePath, imagePathPrefix)
    rewriteLinks(visited.links, inFilePath, workingDirPath)
  }
}

export function rehypeProcessMarkdownFile() {
  return (tree, vFile) => {
    let visited: RehypeVisitedNodes = { headings: [] }
    visit(tree, rehypeVisitor(visited))
    generateTOC(visited.headings, vFile)
  }
}

export function processOtherFiles(contentDirPath: string, outputDirPath: string) {
  const inFilePaths = utils.fsFind(
    contentDirPath,
    {
      nodir: true,
      filter: ({ path }) => p.extname(path) !== MD_EXT
    }
  )
  for (const inFilePath of inFilePaths) {
    processOtherFile(inFilePath, contentDirPath, outputDirPath)
  }
}

export function processOtherFile(inFilePath: string, contentDirPath: string, outputDirPath: string) {
  const outFilePath = p.join(outputDirPath, p.relative(contentDirPath, inFilePath))
  const doWriteFile = utils.isFileAOlderThanB(outFilePath, inFilePath)
  if (doWriteFile) {
    fse.ensureDirSync(p.dirname(outFilePath))
    fs.copyFileSync(inFilePath, outFilePath)
  }
}

export function getSlugs(dirPath: string) {
  let result: string[] = []
  while (cache.index.hasOwnProperty(dirPath)) {
    result.push(cache.index[dirPath].slug)
    dirPath = p.dirname(dirPath)
  }
  return result.reverse()
}

export function remarkVisitor(visited: RemarkVisitedNodes) {
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

export function rehypeVisitor(visited: RehypeVisitedNodes) {
  return (node) => {
    if (["h1", "h2", "h3"].includes(node.tagName)) {
      visited.headings.push(node)
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

    if (checkFilePath !== "") {
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
      checkFilePath = p.join(workingDirPath, "..", p.relative(COURSE_ROOT_PATH, node.url))
    } else {
      checkFilePath = p.resolve(inDirPath, node.url)
    }

    utils.checkPathExists(checkFilePath, `Couldn't find required '${checkFilePath}' for '${inFilePath}' at line ${node.position.start.line} relative to frontmatter`)
    node.url = node.url.replace(MD_EXT, "")
  }
}

export function generateTOC(nodes: any[], vFile) {
  vFile.data.toc = []
  for (const node of nodes) {
    for (const child of node.children) {
      if (child.type === "text") {
        vFile.data.toc.push({
          headingType: node.tagName,
          title: child.value,
          link: `#${node.properties.id}`,
        })
      }
    }
  }
}

export function processGodotProjects(workingDirPath: string, outputDirPath: string) {
  const godotProjectDirPaths = utils.fsFind(
    workingDirPath,
    {
      depthLimit: 0,
      nofile: true,
      filter: ({ path }) => fs.existsSync(p.join(path, GODOT_PROJECT_FILE)),
    },
  )
  for (const godotProjectDirPath of godotProjectDirPaths) {
    processGodotProject(godotProjectDirPath, outputDirPath)
  }
}

export function processGodotProject(godotProjectDirPath: string, outputDirPath: string) {
  const outDirPath = p.join(outputDirPath, PUBLIC_DIR, `${p.basename(godotProjectDirPath)}.zip`)
  const godotProjectFilePaths = utils.fsFind(
    godotProjectDirPath,
    {
      nodir: true,
      filter: ({ path }) =>
        !GODOT_IGNORED.some((dir: string) => path.includes(`${dir}`))
    })

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
  if (match !== null && !match[1]) {
    throw Error(`No matching '${anchorName}' anchor found`)
  }
  return match[1]
}

export async function getSerialized(vFile: VFile, frontmatter: Record<string, any>, remarkPlugins = [], rehypePlugins = []) {
  return await serialize(
    vFile,
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
      scope: frontmatter,
    },
  )
}

export function setLogger(newLogger: Logger) {
  logger = newLogger
}
