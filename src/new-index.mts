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

export async function processSection(contentDirPath: string, outputDirPath: string, dirPath: string) {
  let content = ""
  const inFilePath = p.join(dirPath, INDEX_FILE)
  const outFilePath = p
    .join(outputDirPath, inFilePath.replace(contentDirPath, ""))
    .replace(MD_EXT, JSON_EXT)

  const inFileExists = utils.checkFileExists(inFilePath)
  if (inFileExists && utils.isFileAOlderThanB(outFilePath, inFilePath)) {
    content = fs.readFileSync(inFilePath, "utf8")
  } else if (!inFileExists) {
    const defaultName = p.basename(dirPath).replace(/^\d+\./, "")
    content = [
      "---",
      `title: "PLACEHOLDER TITLE (missing _index.md): ${defaultName.replace(/-/, " ")}"`,
      `slug: ${defaultName}`,
      "---",
      "",
    ].join("\n")
  }

  if (content.length > 0) {
    fsExtra.ensureDirSync(p.dirname(outFilePath))
    const serialized = await serialize(
      content,
      {
        ...MDX_SERIALIZE_OPTIONS,
        mdxOptions: {
          remarkPlugins: [remarkProcessSection(dirPath, inFilePath)],
        },
      },
    )
    fs.writeFileSync(outFilePath, JSON.stringify(serialized))
  }
}

function remarkProcessSection(dirPath: string, inFilePath: string) {
  return () => async (tree, vFile) => {
    const slug = p.posix.join(await getSlugPathUp(p.resolve(dirPath, "..")), vFile.data.matter.slug)
    const imagePathPrefix = p.posix.join(COURSES_ROOT_PATH, slug)
    if (vFile.data.hasOwnProperty("matter") && vFile.data.matter.hasOwnProperty("thumbnail")) {
      const filePath = p.join(dirPath, vFile.data.matter.thumbnail)
      utils.checkFileExists(
        filePath,
        `Couldn't find required '${filePath}' for '${inFilePath}' at in frontmatter`
      )
      vFile.data.matter.thumbnail = p.posix.join(imagePathPrefix, vFile.data.matter.thumbnail)
    }

    visit(tree, (node) => {
      let checkFilePath = ""
      if (node.type === "image") {
        checkFilePath = p.join(dirPath, node.url)
        node.url = p.posix.join(imagePathPrefix, node.url)
      } else if (node.type === "mdxJsxFlowElement" && node.name === "img") {
        node.attributes
          .filter((attr) => attr.name === "src")
          .forEach((attr) => {
            checkFilePath = p.join(dirPath, attr.value)
            attr.value = p.posix.join(imagePathPrefix, attr.value)
          })
      }

      if (checkFilePath.length > 0) {
        utils.checkFileExists(
          checkFilePath,
          `Couldn't find required '${checkFilePath}' for '${inFilePath}' at line '${node.position.start.line}'`
        )
      }
    })
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


export async function getSlugPathUp(dirPath: string) {
  let partialResult: string[] = []
  while (true) {
    const filePath = p.join(dirPath, INDEX_FILE)
    dirPath = p.resolve(dirPath, "..")

    if (fs.existsSync(filePath)) {
      const serialized = await serialize(
        fs.readFileSync(filePath, "utf8"),
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

export function setLogger(newLogger: Logger) {
  logger = newLogger
}
