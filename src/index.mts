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
import { MDXRemoteSerializeResult } from "next-mdx-remote"
import * as utils from "./utils.mts"

type RemarkVisitedNodes = {
  images: any[],
  links: any[],
}

type RehypeVisitedNodes = { headings: any[] }

type Index = {
  frontmatter: any,
  content: string,
}
type LessonTOC = {
  headingType: "h1" | "h2" | "h3",
  title: string,
  link: string,
}
type LessonPrevNext = {
  title: string,
  url: string,
}
type Lesson = {
  serializedMDX: MDXRemoteSerializeResult,
  url: string,
  title: string,
  slug: string,
  toc: LessonTOC[],
  free: boolean,
  draft: boolean,
  prev?: LessonPrevNext,
  next?: LessonPrevNext,
}
type SectionLesson = {
  outPath: string,
  in: string,
  out: Lesson,
}
type Section = {
  title: string,
  lessons: SectionLesson[],
}
type CacheLessonEntry = {
  in: string,
  out: Lesson,
}
type Cache = {
  index: Record<string, Index>,
  lessons: Record<string, CacheLessonEntry>,
}

const COURSE_ROOT_PATH = "/course"
const COURSES_ROOT_PATH = "/courses"
const PUBLIC_DIR = "public"
const MD_EXT = ".md"
const JSON_EXT = ".json"
const IN_INDEX_FILE = `_index${MD_EXT}`
const OUT_INDEX_FILE = `index${JSON_EXT}`
const OUT_INDEX_SEARCH_FILE = `index-search${JSON_EXT}`
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

let cache: Cache = {
  index: {},
  lessons: {},
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
    if (["add", "addDir"].includes(eventName)) {
      return
    }
    console.log(eventName, inPath)
    if (eventName === "unlink" || eventName === "unlinkDir") {
      fse.removeSync(p.join(outputDirPath, p.relative(contentDirPath, inPath)))
      if (p.basename(inPath) === IN_INDEX_FILE) {
        delete cache.index[p.dirname(inPath)]
      } else if (p.extname(inPath) === MD_EXT) {
        delete cache.lessons[inPath]
      } else if (eventName === "unlinkDir") {
        utils.fsFind(inPath, {
          nodir: true,
          traverseAll: true,
          filter: ({ path }) => p.extname(path) === MD_EXT
        }).forEach((path) => delete cache.lessons[path])
      }
    } else if (eventName === "change") {
      if (p.basename(inPath) === IN_INDEX_FILE) {
        indexSection(p.dirname(inPath))
      } else if (p.extname(inPath) === MD_EXT) {
        processMarkdownFile(inPath, workingDirPath, outputDirPath)
          .then(() => { processFinal(contentDirPath, outputDirPath) })
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
    watcher.on("all", (eventName) => {
      if (["add", "addDir"].includes(eventName)) {
        return
      }
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
  processMarkdownFiles(workingDirPath, contentDirPath, outputDirPath)
    .then(() => processFinal(contentDirPath, outputDirPath))
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

export function buildRelease(
  workingDirPath: string,
  outputDirPath: string,
  releasesDirPath: string,
) {
  const slug = Object.values(cache.index)[0].frontmatter.slug
  const outFilePath = p.join(
    releasesDirPath,
    `${slug}-${utils.getDate()}-${utils.getGitHash(workingDirPath)}.zip`
  );
  logger.debug(`Saving the processed course ${slug} at ${outFilePath}`);
  fse.ensureDirSync(releasesDirPath);
  const zip = new AdmZip()
  zip.addLocalFolder(outputDirPath)
  zip.writeZip(outFilePath)
}

export function indexSection(inDirPath: string) {
  let inFileContent = ""
  const inFilePath = p.join(inDirPath, IN_INDEX_FILE)
  if (utils.checkPathExists(inFilePath)) {
    inFileContent = fs.readFileSync(inFilePath, "utf8")
  } else {
    const defaultName = p.basename(inDirPath).replace(/^\d+\./, "")
    inFileContent = [
      "---",
      `title: "PLACEHOLDER TITLE (missing _index.md): ${defaultName.replace(/-/, " ")}"`,
      `slug: ${defaultName}`,
      "---",
      "",
    ].join("\n")
  }

  if (inFileContent !== "") {
    const { data: frontmatter, content } = matter(inFileContent)
    frontmatter.slug ??= slugify(frontmatter.title as string, SLUGIFY_OPTIONS)
    cache.index[inDirPath] = { frontmatter, content }
  }
}

export async function processFinal(contentDirPath: string, outputDirPath: string) {
  const { frontmatter, content } = cache.index[contentDirPath]
  let outFilePath = p.join(outputDirPath, OUT_INDEX_FILE)

  const sections = getCacheSections(outputDirPath)
  updateLessonsPrevNext(sections)

  const toc = generateCourseTOC(sections)
  const thumbnailPath = p.resolve(contentDirPath, frontmatter.thumbnail)
  fse.ensureDirSync(p.dirname(outFilePath))
  fs.writeFileSync(outFilePath, JSON.stringify({
    title: frontmatter.title,
    slug: frontmatter.slug,
    description: frontmatter.description,
    tagline: frontmatter.tagline,
    salesPoints: frontmatter.salesPoints,
    lastUpdated: frontmatter.lastUpdated,
    godotVersion: frontmatter.godotVersion,
    courseDuration: frontmatter.courseDuration,
    thumbnail: p.posix.join(COURSES_ROOT_PATH, frontmatter.slug, p.posix.normalize(p.relative(contentDirPath, thumbnailPath))),
    thumbnailPlaceholder: await utils.downscaleImage(thumbnailPath),
    video: frontmatter.video,
    draft: frontmatter.draft || false,
    price: frontmatter.price || 0,
    tags: (frontmatter.tags || []).map((tag: string) => ({ name: tag, slug: slugify(tag, SLUGIFY_OPTIONS), })),
    order: frontmatter.order || 0, // for sorting courses in browse page
    difficulty: frontmatter.difficulty || 1, // for sorting courses in browse page
    releaseDate: frontmatter.releaseDate || new Date("2000-01-01").toString(),
    saleEnd: frontmatter.saleEnd,
    saleCoupon: frontmatter.saleCoupon,
    saleDiscount: frontmatter.saleDiscount || 0,
    banner: frontmatter.banner,
    copy: await getSerialized(new VFile(content), frontmatter),
    firstLessonUrl: toc[0].lessons[0].url,
    toc,
  }))

  outFilePath = p.join(outputDirPath, OUT_INDEX_SEARCH_FILE)
  fs.writeFileSync(outFilePath, JSON.stringify(
    Object.entries(cache.lessons).map(([inFilePath, lesson]) => {
      const [courseSlug, sectionSlug, slug] = getMarkdownFileSlugs(lesson.out.slug, inFilePath)
      return {
        courseSlug,
        sectionSlug,
        slug,
        url: lesson.out.url,
        title: lesson.out.title,
        text: lesson.in,
      }
    })
  ))
}

export async function processMarkdownFiles(workingDirPath: string, contentDirPath: string, outputDirPath: string) {
  const inFilePaths = utils.fsFind(
    contentDirPath,
    {
      nodir: true,
      traverseAll: true,
      filter: ({ path }) => p.extname(path) === MD_EXT && p.basename(path) !== IN_INDEX_FILE
    }
  )
  for (const inFilePath of inFilePaths) {
    await processMarkdownFile(inFilePath, workingDirPath, outputDirPath)
  }
}

export async function processMarkdownFile(inFilePath: string, workingDirPath: string, outputDirPath: string) {
  const { data: frontmatter, content } = getMatter(fs.readFileSync(inFilePath, "utf8"))
  frontmatter.slug ??= slugify(frontmatter.title as string, SLUGIFY_OPTIONS)
  if (process.env.NODE_ENV === PRODUCTION && frontmatter.draft) {
    return
  }
  const slugs = getMarkdownFileSlugs(frontmatter.slug, inFilePath)
  const outFilePath = getMarkdownFileOutPath(slugs, outputDirPath)
  const doWriteFile = utils.isFileAOlderThanB(outFilePath, inFilePath)
  if (doWriteFile) {
    let vFile = new VFile(content)
    const serializedMDX = await getSerialized(
      vFile,
      frontmatter,
      [remarkProcessMarkdownFile(inFilePath, workingDirPath)],
      [rehypeProcessMarkdownFile],
    )
    const out: Lesson = {
      serializedMDX,
      url: p.posix.join(COURSE_ROOT_PATH, ...slugs),
      title: frontmatter.title,
      slug: frontmatter.slug,
      toc: vFile.data.toc as LessonTOC[],
      free: frontmatter.free || false,
      draft: frontmatter.draft || false,
    }

    fse.ensureDirSync(p.dirname(outFilePath))
    fs.writeFileSync(outFilePath, JSON.stringify(out))
    cache.lessons[inFilePath] = { in: content, out }
  } else if (!cache.lessons.hasOwnProperty(inFilePath)) {
    cache.lessons[inFilePath] = {
      in: content,
      out: JSON.parse(fs.readFileSync(outFilePath, "utf8")),
    }
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

    generateLessonTOC(visited.headings, vFile)
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
    result.push(cache.index[dirPath].frontmatter.slug)
    dirPath = p.dirname(dirPath)
  }
  return result.reverse()
}

export function getMarkdownFileSlugs(slug: string, inFilePath: string) {
  return [...getSlugs(p.dirname(inFilePath)), slug]
}

export function getMarkdownFileOutPath(slugs: string[], outputDirPath: string) {
  return `${p.join(outputDirPath, ...slugs.slice(1))}${JSON_EXT}`
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

export function generateLessonTOC(nodes: any[], vFile) {
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

export function getCacheSections(outputDirPath: string) {
  return Object.entries(cache.index).slice(1)
    .map(([inDirPath, data]) => ({
      title: data.frontmatter.title,
      lessons: Object.entries(cache.lessons)
        .filter(([path]) => path.startsWith(inDirPath))
        .map(([path, lesson]) => ({
          outPath: getMarkdownFileOutPath(getMarkdownFileSlugs(lesson.out.slug, path), outputDirPath),
          in: lesson.in,
          out: lesson.out,
        }))
    }))
}

export function generateCourseTOC(sections: Section[]) {
  return sections.map((section) => ({
    ...section,
    lessons: section.lessons.map((lesson) => ({
      title: lesson.out.title,
      slug: lesson.out.slug,
      url: lesson.out.url,
      draft: lesson.out.draft,
      free: lesson.out.free,
    })),
  }))
}

export function updateLessonsPrevNext(sections: Section[]) {
  sections.forEach((section, sectionIndex) =>
    section.lessons.forEach((lesson, lessonIndex: number) => {
      let prevLesson = section.lessons[lessonIndex - 1] || null
      let nextLesson = section.lessons[lessonIndex + 1] || null

      if (!prevLesson && sectionIndex > 0) {
        const prevSection = sections[sectionIndex - 1]
        prevLesson = prevSection.lessons[prevSection.lessons.length - 1]
      }

      if (!nextLesson && sectionIndex < sections.length - 1) {
        const nextSection = sections[sectionIndex + 1]
        nextLesson = nextSection.lessons[0]
      }

      lesson.out.prev = null
      if (prevLesson) {
        lesson.out.prev = { title: prevLesson.out.title, url: prevLesson.out.url }
      }

      lesson.out.next = null
      if (nextLesson) {
        lesson.out.next = { title: nextLesson.out.title, url: nextLesson.out.url }
      }
      fs.writeFileSync(lesson.outPath, JSON.stringify(lesson.out))
    })
  )
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

export function getMatter(source: string) {
  return matter(source
    .replace(HTML_COMMENT_REGEX, "")
    .replace(GDSCRIPT_CODEBLOCK_REGEX, "$1$3")
  )
}

export function setLogger(newLogger: Logger) {
  logger = newLogger
}
