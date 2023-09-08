import * as dotenv from "dotenv"
import * as fs from "fs-extra"
import { dirname, basename, extname, join, sep } from "path"
import matter from "gray-matter"
import watchFiles from "node-watch"
import { zip } from "zip-a-folder"
import pino from "pino"
import {
  fsFind,
  readText,
  saveText,
  ensureDirExists,
  slugify,
  readArgs,
  getDate,
  getGitHash,
  deleteForced,
} from "./utils"

dotenv.config()

const GD_PLUG_DIR = `.plugged${sep}`

let logger = pino({
  name: "processCourse",
})

export async function runFromCli() {
  const args = readArgs({
    b: ["build", "process the files"],
    h: ["help", "this text"],
    w: ["watch", "run in watch mode"],
    z: ["zip", "build release version and zip results"],
  })

  const help = () =>
    console.log([
      "",
      "Preprocessor for GDQuest Courses",
      "",
      "Processes the course content into the format compatible with the new GDSchool platform.",
      "",
      "USAGE:",
      `${args._.path.split("/").pop()} [options] [path]`,
      "",
      "options:",
      `  ${args._.help.join("\n  ")}`,
      "",
      "if path isn't specified, the current directory will be used",
      "",
    ].join("\n"))

  if (args.help) {
    help()
    process.exit(0)
  }

  const WORKING_DIR = args.rest.length > 0 ? args.rest[0] : process.cwd()
  const CONTENT_DIR = join(WORKING_DIR, "content")
  const OUTPUT_DIR = join(WORKING_DIR, "content-processed")
  const RELEASES_DIR = join(WORKING_DIR, "content-releases")

  logger = pino({
    name: "processCourse",
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        ignore: "pid,hostname",
        translateTime: "HH:MM:ss",
      },
    },
  })

  if (args.watch) {
    logger.info("Watching course", WORKING_DIR)
    watch(WORKING_DIR, CONTENT_DIR, OUTPUT_DIR)
  } else if (args.build) {
    logger.info("Building course", WORKING_DIR)
    const [, course] = await processFiles(WORKING_DIR, CONTENT_DIR, OUTPUT_DIR )
    await processGodot(OUTPUT_DIR, course.codeFiles)
    process.exit(0)
  } else if (args.zip) {
    logger.info("Releasing course", WORKING_DIR)
    await buildRelease(WORKING_DIR, CONTENT_DIR, OUTPUT_DIR, RELEASES_DIR)
    process.exit(0)
  } else {
    logger.warn("No valid option passed")
    help()
    process.exit(1)
  }
}

export async function watch(workingDir: string, contentDir: string, outputDir: string) {
  const [watchList] = await processFiles(workingDir, contentDir, outputDir)
  const files = [...watchList.keys()]
  logger.info("Awaiting changes...")
  watchFiles(files, (evt, filename) => {
    if (evt === "update") {
      const fn = watchList.get(filename)
      if (fn) {
        const stats = fn()
        logger.info("updated", stats.output)
      }
    }
  })
}

export async function processFiles(workingDir: string, contentDir: string, outputDir: string) {
  const watchList = new Map<string, () => ProcessedFile>()
  deleteForced(outputDir)
  const course = processCourse(contentDir, workingDir, outputDir)
  watchList.set(course.input, () =>
    processCourse(contentDir, workingDir, outputDir)
  )
  // Copy all files to the output folder
  //copyFiles(CONTENTDIR, OUTPUTDIR)

  // Loop over sections
  for (const sectionDirName of fs.readdirSync(contentDir)) {
    const section = processSection(contentDir, outputDir, sectionDirName)
    if (!section) {
      continue
    }
    logger.debug(`Processing section: ${sectionDirName}`)
    const sectionIndexPath = join(section.input, "_index.md")
    if (fs.existsSync(sectionIndexPath)) {
      watchList.set(sectionIndexPath, () =>
        processSection(contentDir, outputDir, sectionDirName)
      )
    }
    // Loop over lessons
    for (const lessonFileName of fs.readdirSync(section.input)) {
      const lesson = processLesson(lessonFileName, course, section)
      if (!lesson) {
        continue
      }
      watchList.set(lesson.input, () =>
        processLesson(lessonFileName, course, section)
      )
      logger.debug(`Processing lesson: ${lessonFileName}`)
    }
  }
  return [watchList, course] as const
}

export async function buildRelease(workingDir: string, contentDir: string, outputDir: string, releasesDir: string) {
  const [, course] = await processFiles(workingDir, contentDir, outputDir)
  await processGodot(outputDir, course.codeFiles)
  const fileName = join(
    releasesDir,
    `${course.frontmatter.slug}-${getDate()}-${getGitHash(workingDir)}.zip`
  )
  logger.debug(`Compressing the processed course ${course.frontmatter.slug}`)
  logger.debug(`saving to ${fileName}`)
  ensureDirExists(fileName)
  await zip(outputDir, fileName)
}

type ProcessedFile = ProcessedCourse | ProcessedLesson | ProcessedSection

type ProcessedCourse = ReturnType<typeof processCourse>
export function processCourse(contentDir: string, workingDir: string, outputDir: string) {
  const input = join(contentDir, `_index.md`)
  const output = join(outputDir, `_index.md`)
  let text = readText(input)
  const { data: frontmatter } = matter(text)
  logger.trace("Course frontmatter", frontmatter)
  // Copy all files to the output folder
  // Find all code files in Godot project folders, so that I can later use them to replace include shortcodes inside codeblocks
  const codeFiles = indexCodeFiles(workingDir)
  const lessonFiles = indexLessonFiles(contentDir) // needed to create links with shortcodes like {{ link lesson-slug subheading }}
  // Process the content of the landing page
  text = rewriteImagePaths(text, `/courses/${frontmatter.slug}`)
  saveText(output, text)
  return { frontmatter, codeFiles, lessonFiles, text, input, output }
}

type ProcessedSection = ReturnType<typeof processSection>
export function processSection(contentDir: string, outputDir: string, name: string) {
  const input = join(contentDir, name)
  if (!fs.lstatSync(input).isDirectory() || name === "images") {
    return
  }
  const output = join(outputDir, name)
  logger.debug(`Processing section: ${name}`)
  let text = getIndexFileStringContentFromDir(input)
  const { data: frontmatter } = matter(text)
  saveText(join(output, `_index.md`), text)
  return { input, output, name, frontmatter, text }
}

type ProcessedLesson = ReturnType<typeof processLesson>
export function processLesson(lessonFileName: string, course: ProcessedCourse, section: ProcessedSection) {
  const input = join(section.input, lessonFileName)
  const output = join(section.output, lessonFileName)
  if (fs.lstatSync(input).isDirectory() || ["_index.md", ".DS_Store"].includes(lessonFileName)) {
    return
  }
  let text = readText(input)
  const { data: frontmatter } = matter(text)

  // Process the content of the lesson - rewrite image paths, replace shortcodes, etc.
  const imagePathPrefix = join(`/courses`, course.frontmatter.slug, section.frontmatter.slug)
  text = rewriteImagePaths(text, imagePathPrefix)
  text = processCodeblocks(text, lessonFileName, course.codeFiles)

  // let lessonUrl = join(`course`, courseFrontmatter.slug, sectionFrontmatter.slug, lessonFrontmatter.slug)
  text = rewriteLinks(
    text,
    `/course/${course.frontmatter.slug}`,
    course.lessonFiles
  )
  // Saving the processed lesson
  saveText(output, text)
  return { input, output, text, frontmatter }
}

export async function processGodot(outputDir: string, codeFiles: CodeFile[]) {
  const godotProjectDirs = [... new Set(codeFiles.map((c: CodeFile) => c.godotProjectFolder))]
  const outTmpDir = join(outputDir, "tmp")
  await Promise.all(
    godotProjectDirs.map(async (godotProjectDir: string) => {
      const godotProjectDirName = basename(godotProjectDir)
      const godotPluggedDir = join(godotProjectDir, GD_PLUG_DIR)
      const outDir = join(outputDir, "public", godotProjectDirName)
      const outGodotPluggedDir = join(outTmpDir, godotProjectDirName, GD_PLUG_DIR)
      const zipFile = `${outDir}.zip`
      if (fs.existsSync(godotPluggedDir)) {
        ensureDirExists(outGodotPluggedDir)
        fs.moveSync(godotPluggedDir, outGodotPluggedDir)
      }

      ensureDirExists(outDir)
      await zip(godotProjectDir, zipFile)

      if (fs.existsSync(outGodotPluggedDir)) {
        fs.moveSync(outGodotPluggedDir, godotPluggedDir)
      }
    })
  )
  deleteForced(outTmpDir)
}

/**
 * Extracts the contents of the `_index.md` file if it exists.
 * If the file does not exist, an empty string is returned in dev environments.
 * An error is thrown in prod environments
 * @param dir The directory you're working in
 */
export function getIndexFileStringContentFromDir(dir: string) {
  // TODO: memoize this so the function can be reused without reloading the entire file, but NOT when using `watch`
  // or see why it is called twice
  const sectionIndexPath = join(dir, "_index.md")
  const defaultName = basename(dir).replace(/^\d+\./, "")
  const defaultPlaceHolder = [
    "---",
    `title: "PLACEHOLDER TITLE (missing _index.md): ${defaultName.replace(/-/, " ")}"`,
    `slug: "${defaultName}"`,
    "",
    "",
  ].join("\n")

  if (!fs.existsSync(sectionIndexPath)) {
    const error = new Error(`could not find _index.md file in ${dir}`)
    if (process.env.NODE_ENV === "production") {
      throw error
    }
    logger.warn(error.message)
    return defaultPlaceHolder
  }
  return readText(sectionIndexPath) || defaultPlaceHolder
}

//
export function rewriteLinks(lessonText: string, courseUrl: string, lessonFiles: LessonFile[]) {
  // TODO - some links have anchor tags linking to subheadings, like {{ link Lesson subheading }}
  // const linkRegex = /{{\s*link\s+([^\s{}]+)\s*}}/g
  const linkRegex = /{{\s*link\s+([\w-]+)\s*([\w-]*)\s*}}/g

  // In the future, we should have shortcodes like {{ link lesson-slug subheading }}
  // Then, we'd replace such shortcodes with links like this: [Lesson Title](/course/section-slug/lesson-slug#subheading)
  // But, the way Node Essentails course is written, the shortcodes are like this: {{ link LessonFileName subheading }}
  lessonText = lessonText.replace(linkRegex, (_match, fileName, headingSlug) => {
    const lesson = lessonFiles.find((lesson) => lesson.fileName === fileName)
    let fullPath = join(courseUrl, lesson.sectionSlug, lesson.slug)
    if (headingSlug) fullPath += `#${headingSlug}`
    const modifiedLink = `[${fileName}](${fullPath})`
    return modifiedLink
  })
  return lessonText
}

// Replace image paths to absolute ones.
export function rewriteImagePaths(lessonText: string, imagePathPrefix: string) {
  const markdownImagePathRegex = /!\[(.*?)\]\((.+?)\)/g
  lessonText = lessonText.replace(
    markdownImagePathRegex,
    (_, altText, imagePath) => {
      const modifiedImagePath = `${imagePathPrefix}/${imagePath}`
      return `![${altText}](${modifiedImagePath})`
    }
  )
  const htmlImagePathRegex = /<img src="(.+?)"(.+?)\/>/g
  lessonText = lessonText.replace(
    htmlImagePathRegex,
    (_, imagePath, attributes) => {
      const modifiedImagePath = `${imagePathPrefix}/${imagePath}`
      return `<img src="${modifiedImagePath}"${attributes}/>`
    }
  )
  const thumbnailImagePathRegex = /^thumbnail:\s*(.*)$/gm
  lessonText = lessonText.replace(
    thumbnailImagePathRegex,
    (_, imagePath) => {
      const modifiedImagePath = `${imagePathPrefix}/${imagePath}`
      return `thumbnail: ${modifiedImagePath}`
    }
  )
  return lessonText
}

export function processCodeblocks(lessonText: string, lessonFileName: string, codeFiles: CodeFile[]) {
  // Add filenames to codeblocks, like ```gdscript:/path/to/file/FileName.gd
  lessonText = addFilenamesToCodeblocks(lessonText, codeFiles)
  // Replace includes with code. Include looks like this: {{ include FileName.gd anchor_name }}
  const includeRegex = /{{\s*include\s+([^\s]+)(?:\s+([^\s]+))?\s*}}/g
  lessonText = lessonText.replace(includeRegex, (_match, fileName, anchor) => {
    let updatedContent = `This line replaces the include for ${fileName}, ${anchor}` // just for testing
    // Find the code file by name so I could read its content
    let foundFiles = codeFiles.filter((codeFile) => codeFile.fileName === fileName)
    // If the file path is absolute, use it as is
    if (fileName.includes("/")) {
      let filePath = fileName.replaceAll('"', "")
      foundFiles = codeFiles.filter((codeFile) => codeFile.filePath.includes(filePath))
    }
    if (foundFiles.length === 0) {
      let errorMessage = [
        "Code file not found.",
        `Lesson: ${lessonFileName}`,
        "Found files:",
        "",
      ].join("\n")
      throw new Error(errorMessage)
    }
    if (foundFiles.length > 1) {
      let errorMessage = [
        "Multiple code files with the same name found.",
        `Lesson: ${lessonFileName}`,
        "Found files:",
        foundFiles.join("\n"),
        "",
        "Use a complete file path to disambiguate.",
      ].join("\n")
      throw new Error(errorMessage)
    }
    let codeFilePath = foundFiles[0]?.filePath

    let codeText = readText(codeFilePath)
    updatedContent = codeText
    // If it has anchor tags, extract the text between them
    try {
      if (anchor) updatedContent = extractTextBetweenAnchors(codeText, anchor)
    } catch (error) {
      let errorMessage = [
        "Error extracting text between anchors.",
        `Lesson: ${lessonFileName}`,
        `Anchor: ${anchor}`,
        `Code file: ${codeFilePath}`,
      ].join("\n")
      throw new Error(errorMessage)
    }
    updatedContent = removeAnchorTags(updatedContent)
    // updatedContent = trimBlankLines(updatedContent)
    return updatedContent
  })
  return lessonText
}

export function addFilenamesToCodeblocks(lessonText: string, codeFiles: CodeFile[]) {
  const regex = /(```gdscript)(\s*\n)(\{\{\s*include\s+([^}\s]+))/g
  lessonText = lessonText.replace(regex, (_, p1, p2, p3, fileName) => {
    let relativeFilePath = codeFiles.find(
      (codeFile) => codeFile.fileName === fileName
    )?.relativeFilePath
    // If instead of the file name the path to the file was provided, like:
    // {{ include godot-complete-demos/ObstacleCourse_Part2/pickups/Pickup.gd apply_effect }}
    if (fileName.includes("/"))
      relativeFilePath = `${fileName.split("/").at(-1)}` // .split('/').slice(1).join('/')

    return `${p1}:${relativeFilePath}${p2}${p3}`
  })
  return lessonText
}

export function extractTextBetweenAnchors(content: string, anchorName: string) {
  const anchorPattern = new RegExp(
    `(?:#|\\/\\/)\\s*ANCHOR:\\s*\\b${anchorName}\\b\\s*\\r?\\n(.*?)\\s*(?:#|\\/\\/)\\s*END:\\s*\\b${anchorName}\\b`,
    "gms"
  )
  const match = anchorPattern.exec(content)
  if (!match || !match[1]) throw new Error("No matching anchor found.")
  return match[1]
}

export function removeAnchorTags(content: string) {
  // const anchorPattern = /#\s*(ANCHOR:|END:).*\n?\s*/gm
  const anchorPattern = /^.*#(ANCHOR|END).*\r?\n?/gm
  return content.replace(anchorPattern, "").trimEnd()
}

export function trimBlankLines(str: string) {
  // Use regular expression to replace blank lines at the beginning and end of the string
  return str.replace(/^\s*[\r\n]/gm, "").replace(/\s*[\r\n]$/gm, "")
}

type CodeFile = {
  fileName: string
  filePath: string
  godotProjectFolder: string
  /* Path relative to godot project folder, used to add the path to the script at the top of the code block */
  relativeFilePath: string
}
export function indexCodeFiles(workingDir: string) {
  const findDirPredicate = (path: string) => !path.includes(GD_PLUG_DIR) && path.endsWith("project.godot")
  const findFilePredicate = (path: string) => !path.includes(GD_PLUG_DIR) && [".gd", ".shader"].includes(extname(path))
  const ignorePredicate = (path: string) => fs.statSync(path).isDirectory() && path.endsWith("node_modules")
  const godotProjectDirs = fsFind(workingDir, true, findDirPredicate, ignorePredicate).map((path: string) => dirname(path))
  return godotProjectDirs.reduce(
    (acc: CodeFile[], godotProjectFolder: string) => acc.concat(
      fsFind(godotProjectFolder, true, findFilePredicate, ignorePredicate)
        .map((filePath: string) => ({
          fileName: basename(filePath),
          filePath,
          godotProjectFolder,
          relativeFilePath: filePath.replace(godotProjectFolder, "")
        }))
    ),
    []
  )
}

type LessonFile = {
  slug: string
  sectionSlug: string
  fileName: string
}
// To create links with shortcodes like {{ link lesson-slug subheading }}
export function indexLessonFiles(contentDir: string) {
  let allLessons: LessonFile[] = []
  const sectionFolderNames = fs.readdirSync(contentDir)
  for (let sectionFolderName of sectionFolderNames) {
    if (["images", ".DS_Store", "_index.md"].includes(sectionFolderName)) {
      continue
    }

    const sectionFolderPath = join(contentDir, sectionFolderName)
    const sectionIndex = getIndexFileStringContentFromDir(sectionFolderPath)
    const { data: sectionFrontmatter } = matter(sectionIndex)
    const lessonFileNames = fs.readdirSync(sectionFolderPath)
    for (let lessonFileName of lessonFileNames) {
      // logger.debug('[indexLessonFiles] ', lessonFileName)
      const lessonFilePath = join(sectionFolderPath, lessonFileName)
      if (fs.lstatSync(lessonFilePath).isDirectory() || [".DS_Store"].includes(lessonFileName)) {
        continue
      }

      let lessonText = readText(lessonFilePath)
      const { data: frontmatter, } = matter(lessonText)
      // logger.debug('[indexLessonFiles] frontmatter ', frontmatter)
      let lesson = {
        slug: slugify(frontmatter.title), // frontmatter.slug,
        sectionSlug: sectionFrontmatter.slug,
        fileName: lessonFileName.replace(".md", ""),
      }
      allLessons.push(lesson)
    }
  }
  logger.debug("Indexed lessons", allLessons)
  return allLessons
}
