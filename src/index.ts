import * as dotenv from "dotenv";
dotenv.config();
import { statSync, lstatSync, readdirSync, existsSync, rmSync } from "fs-extra";
import { basename, extname, join } from "path";
import matter from "gray-matter";
import {
  copyFiles,
  readText,
  saveText,
  ensureDirExists,
  readJson,
  saveJson,
  slugify,
  readArgs,
  getDate,
  getGitHash,
} from "./utils";
import watchFiles from "node-watch";
import { zip } from "zip-a-folder";
import pino from "pino";

let logger = pino({
  name: "processCourse",
});

let config;

export async function runFromCli() {
  const args = readArgs({
    w: ["watch", "run in watch mode"],
    h: ["help", "this text"],
    b: ["build", "process the files"],
    z: ["zip", "build release version and zip results"],
  });

  const help = () =>
    logger.debug(`
  Preprocessor for GDQuest Courses

  Processes the course content into the format compatible with the new GDSchool platform.

  USAGE:

  ${args._.path.split("/").pop()} [options] [path]

  options:
  ${args._.help.join("\n  ")}

  if path isn't specified, the current directory will be used
`);

  if (args.help) {
    help();
    process.exit(0);
  }

  const WORKING_DIR = args.rest.length > 0 ? args.rest[0] : process.cwd();
  const CONTENT_DIR = join(WORKING_DIR, `content`);
  const OUTPUT_DIR = join(WORKING_DIR, `content-processed`);
  const RELEASES_DIR = join(WORKING_DIR, `content-releases`);

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
  });

  if (args.watch) {
    watch(WORKING_DIR, CONTENT_DIR, OUTPUT_DIR, RELEASES_DIR);
  } else {
    if (args.build) {
      await processFiles(WORKING_DIR, CONTENT_DIR, OUTPUT_DIR, RELEASES_DIR);
      process.exit(0);
    }
    if (args.zip) {
      logger.debug("Release Build");
      await buildRelease(WORKING_DIR, CONTENT_DIR, OUTPUT_DIR, RELEASES_DIR);
      process.exit(0);
    } else {
      logger.warn("no valid option passed");
      help();
      process.exit(1);
    }
  }
}

export async function watch(
  WORKING_DIR: string,
  CONTENT_DIR: string,
  OUTPUT_DIR: string,
  RELEASES_DIR: string
) {
  const [watchList] = await processFiles(
    WORKING_DIR,
    CONTENT_DIR,
    OUTPUT_DIR,
    RELEASES_DIR
  );
  const files = [...watchList.keys()];
  logger.info("awaiting changes...");
  watchFiles(files, (evt, filename) => {
    if (evt === "update") {
      const fn = watchList.get(filename);
      if (fn) {
        const stats = fn();
        logger.info("updated", stats.output);
      }
    }
  });
}

export async function processFiles(
  WORKING_DIR: string,
  CONTENT_DIR: string,
  OUTPUT_DIR: string,
  RELEASES_DIR: string
) {
  loadConfig(WORKING_DIR);
  const watchList = new Map<string, () => ProcessedFile>();
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  const course = processCourse(CONTENT_DIR, WORKING_DIR, OUTPUT_DIR);
  watchList.set(course.input, () =>
    processCourse(CONTENT_DIR, WORKING_DIR, OUTPUT_DIR)
  );
  // Copy all files to the output folder
  //copyFiles(CONTENT_DIR, OUTPUT_DIR)

  // Loop over sections
  for (const sectionDirName of readdirSync(CONTENT_DIR)) {
    const section = processSection(CONTENT_DIR, OUTPUT_DIR, sectionDirName);
    if (!section) {
      continue;
    }
    logger.debug(`Processing section: ${sectionDirName}`);
    const sectionIndexPath = join(section.input, "_index.md");
    existsSync(sectionIndexPath) &&
      watchList.set(sectionIndexPath, () =>
        processSection(CONTENT_DIR, OUTPUT_DIR, sectionDirName)
      );
    // Loop over lessons
    for (const lessonFileName of readdirSync(section.input)) {
      const lesson = processLesson(lessonFileName, course, section);
      if (!lesson) {
        continue;
      }
      watchList.set(lesson.input, () =>
        processLesson(lessonFileName, course, section)
      );
      logger.debug(`Processing lesson: ${lessonFileName}`);
    }
  }
  return [watchList, course] as const;
}

export async function buildRelease(
  WORKING_DIR: string,
  CONTENT_DIR: string,
  OUTPUT_DIR: string,
  RELEASES_DIR: string
) {
  const [, course] = await processFiles(
    WORKING_DIR,
    CONTENT_DIR,
    OUTPUT_DIR,
    RELEASES_DIR
  );
  const fileName = join(
    RELEASES_DIR,
    `${course.frontmatter.slug}-${getDate()}-${getGitHash(WORKING_DIR)}.zip`
  );
  logger.debug(`Compressing the processed course ${course.frontmatter.slug}`);
  logger.debug(`saving to ${fileName}`);
  ensureDirExists(fileName);
  await zip(OUTPUT_DIR, fileName);
}

type ProcessedFile = ProcessedCourse | ProcessedLesson | ProcessedSection;

type ProcessedCourse = ReturnType<typeof processCourse>;
export function processCourse(
  CONTENT_DIR: string,
  WORKING_DIR: string,
  OUTPUT_DIR: string
) {
  const input = join(CONTENT_DIR, `_index.md`);
  const output = join(OUTPUT_DIR, `_index.md`);
  let text = readText(input);
  const { data: frontmatter } = matter(text);
  logger.info("Course frontmatter", frontmatter);
  // Copy all files to the output folder
  // Find all code files in Godot project folders, so that I can later use them to replace include shortcodes inside codeblocks
  const codeFiles = indexCodeFiles(WORKING_DIR);
  const lessonFiles = indexLessonFiles(CONTENT_DIR); // needed to create links with shortcodes like {{ link lesson-slug subheading }}
  // Process the content of the landing page
  text = rewriteImagePaths(text, `/courses/${frontmatter.slug}`);
  saveText(output, text);
  return { frontmatter, codeFiles, lessonFiles, text, input, output };
}

type ProcessedSection = ReturnType<typeof processSection>;
export function processSection(CONTENT_DIR, OUTPUT_DIR, name) {
  const input = join(CONTENT_DIR, name);

  if (!lstatSync(input).isDirectory()) return; // ignore files
  if (name === "images") return; // ignore the folder containing images for the landing page
  const output = join(OUTPUT_DIR, name);
  logger.debug(`Processing section: ${name}`);
  let text = getIndexFileStringContentFromDir(input);
  const { data: frontmatter } = matter(text);
  saveText(join(output, `_index.md`), text);
  return { input, output, name, frontmatter, text };
}

type ProcessedLesson = ReturnType<typeof processLesson>;
export function processLesson(
  lessonFileName: string,
  course: ProcessedCourse,
  section: ProcessedSection
) {
  const input = join(section.input, lessonFileName);
  const output = join(section.output, lessonFileName);
  if (lstatSync(input).isDirectory()) return; // ignore directories containing images, files, etc.
  if (["_index.md", ".DS_Store"].includes(lessonFileName)) return; // ignore section index and .DS_Store files
  let text = readText(input);
  const { data: frontmatter } = matter(text);

  // Process the content of the lesson - rewrite image paths, replace shortcodes, etc.
  const imagePathPrefix = `/courses/${course.frontmatter.slug}/${section.frontmatter.slug}`;
  text = rewriteImagePaths(text, imagePathPrefix);
  text = processCodeblocks(text, lessonFileName, course.codeFiles);

  // let lessonUrl = `/course/${courseFrontmatter.slug}/${sectionFrontmatter.slug}/${lessonFrontmatter.slug}`
  text = rewriteLinks(
    text,
    `/course/${course.frontmatter.slug}`,
    course.lessonFiles
  );
  // Saving the processed lesson
  saveText(output, text);
  return { input, output, text, frontmatter };
}

export function parseConfig(config) {
  return config.split("\n").reduce((output, line) => {
    const match = line.match(/(\w+)\s*=\s*"([^"]+)"/);
    if (match) {
      const [_, key, values] = match;
      output[key] = values.split(",").map((value) => value.trim());
    }
    return output;
  }, {});
}

/**
 * Extracts the contents of the `_index.md` file if it exists.
 * If the file does not exist, an empty string is returned in dev environments.
 * An error is thrown in prod environments
 * @param dir The directory you're working in
 */
export function getIndexFileStringContentFromDir(dir: string) {
  // TODO: memoize this so the function can be reused without reloading the entire file, but NOT when using `watch`
  const sectionIndexPath = join(dir, "_index.md");
  const defaultName = basename(dir).replace(/^\d+\./, "");
  const defaultPlaceHolder = `
---
title: "PLACEHOLDER TITLE (missing _index.md): ${defaultName.replace(/-/, " ")}"
slug: "${defaultName}"
---
`;
  if (!existsSync(sectionIndexPath)) {
    const error = new Error(`could not find _index.md file in ${dir}`);
    if (process.env.NODE_ENV === "production") {
      throw error;
    }
    logger.warn(error.message);
    return defaultPlaceHolder;
  }
  return readText(sectionIndexPath) || defaultPlaceHolder;
}

//
export function rewriteLinks(lessonText, courseUrl, lessonFiles) {
  // TODO - some links have anchor tags linking to subheadings, like {{ link Lesson subheading }}
  // const linkRegex = /{{\s*link\s+([^\s{}]+)\s*}}/g
  const linkRegex = /{{\s*link\s+([\w-]+)\s*([\w-]*)\s*}}/g;

  // In the future, we should have shortcodes like {{ link lesson-slug subheading }}
  // Then, we'd replace such shortcodes with links like this: [Lesson Title](/course/section-slug/lesson-slug#subheading)
  // But, the way Node Essentails course is written, the shortcodes are like this: {{ link LessonFileName subheading }}
  lessonText = lessonText.replace(linkRegex, (match, fileName, headingSlug) => {
    const lesson = lessonFiles.find((lesson) => lesson.fileName === fileName);
    let fullPath = `${courseUrl}/${lesson.sectionSlug}/${lesson.slug}`;
    if (headingSlug) fullPath += `#${headingSlug}`;
    const modifiedLink = `[${fileName}](${fullPath})`;
    return modifiedLink;
  });
  return lessonText;
}

// Replace image paths to absolute ones.
export function rewriteImagePaths(lessonText, imagePathPrefix) {
  const markdownImagePathRegex = /!\[(.*?)\]\((.+?)\)/g;
  lessonText = lessonText.replace(
    markdownImagePathRegex,
    (match, altText, imagePath) => {
      const modifiedImagePath = `${imagePathPrefix}/${imagePath}`;
      return `![${altText}](${modifiedImagePath})`;
    }
  );
  const htmlImagePathRegex = /<img src="(.+?)"(.+?)\/>/g;
  lessonText = lessonText.replace(
    htmlImagePathRegex,
    (match, imagePath, attributes) => {
      const modifiedImagePath = `${imagePathPrefix}/${imagePath}`;
      return `<img src="${modifiedImagePath}"${attributes}/>`;
    }
  );
  const thumbnailImagePathRegex = /^thumbnail:\s*(.*)$/gm;
  lessonText = lessonText.replace(
    thumbnailImagePathRegex,
    (match, imagePath, attributes) => {
      const modifiedImagePath = `${imagePathPrefix}/${imagePath}`;
      return `thumbnail: ${modifiedImagePath}`;
    }
  );
  return lessonText;
}

export function processCodeblocks(lessonText, lessonFileName, codeFiles) {
  // Add filenames to codeblocks, like ```gdscript:/path/to/file/FileName.gd
  lessonText = addFilenamesToCodeblocks(lessonText, codeFiles);
  // Replace includes with code. Include looks like this: {{ include FileName.gd anchor_name }}
  const includeRegex = /{{\s*include\s+([^\s]+)(?:\s+([^\s]+))?\s*}}/g;
  lessonText = lessonText.replace(includeRegex, (match, fileName, anchor) => {
    let updatedContent = `This line replaces the include for ${fileName}, ${anchor}`; // just for testing
    // Find the code file by name so I could read its content
    let foundFiles = codeFiles.filter(
      (codeFile) => codeFile.fileName === fileName
    );
    // If the file path is absolute, use it as is
    if (fileName.includes("/")) {
      let filePath = fileName.replaceAll('"', "");
      foundFiles = codeFiles.filter((codeFile) =>
        codeFile.filePath.includes(filePath)
      );
    }
    if (foundFiles.length === 0) {
      let errorMessage = `Code file not found.\n`;
      errorMessage += `Lesson: ${lessonFileName}\n`;
      errorMessage += `File Name: ${fileName}.\n`;
      errorMessage += `Found files:\n`;
      throw new Error(errorMessage);
    }
    if (foundFiles.length > 1) {
      let errorMessage = `Multiple code files with the same name found.\n`;
      errorMessage += `Lesson: ${lessonFileName}\n`;
      errorMessage += `File Name: ${fileName}.\n`;
      errorMessage += `Found files:\n`;
      errorMessage += foundFiles.map((file) => file.filePath).join("\n") + "\n";
      errorMessage += `Use a complete file path to disambiguate.`;
      throw new Error(errorMessage);
    }
    let codeFilePath = foundFiles[0]?.filePath;

    let codeText = readText(codeFilePath);
    updatedContent = codeText;
    // If it has anchor tags, extract the text between them
    try {
      if (anchor) updatedContent = extractTextBetweenAnchors(codeText, anchor);
    } catch (error) {
      let errorMessage = `Error extracting text between anchors.\n`;
      errorMessage += `Lesson: ${lessonFileName}\n`;
      errorMessage += `Anchor: ${anchor}\n`;
      errorMessage += `Code file: ${codeFilePath}\n`;
      throw new Error(errorMessage);
    }
    updatedContent = removeAnchorTags(updatedContent);
    // updatedContent = trimBlankLines(updatedContent)
    return updatedContent;
  });
  return lessonText;
}

export function addFilenamesToCodeblocks(lessonText, codeFiles) {
  const regex = /(```gdscript)(\s*\n)(\{\{\s*include\s+([^}\s]+))/g;
  lessonText = lessonText.replace(regex, (match, p1, p2, p3, fileName) => {
    let relativeFilePath = codeFiles.find(
      (codeFile) => codeFile.fileName === fileName
    )?.relativeFilePath;
    // If instead of the file name the path to the file was provided, like:
    // {{ include godot-complete-demos/ObstacleCourse_Part2/pickups/Pickup.gd apply_effect }}
    if (fileName.includes("/"))
      relativeFilePath = `${fileName.split("/").at(-1)}`; // .split('/').slice(1).join('/')

    return `${p1}:${relativeFilePath}${p2}${p3}`;
  });
  return lessonText;
}

export function extractTextBetweenAnchors(content, anchorName) {
  const anchorPattern = new RegExp(
    `(?:#|\\/\\/)\\s*ANCHOR:\\s*\\b${anchorName}\\b\\s*\\r?\\n(.*?)\\s*(?:#|\\/\\/)\\s*END:\\s*\\b${anchorName}\\b`,
    "gms"
  );
  const match = anchorPattern.exec(content);
  if (!match || !match[1]) throw new Error("No matching anchor found.");
  return match[1];
}

export function removeAnchorTags(content) {
  // const anchorPattern = /#\s*(ANCHOR:|END:).*\n?\s*/gm
  const anchorPattern = /^.*#(ANCHOR|END).*\r?\n?/gm;
  return content.replace(anchorPattern, "").trimEnd();
}

export function trimBlankLines(str) {
  // Use regular expression to replace blank lines at the beginning and end of the string
  return str.replace(/^\s*[\r\n]/gm, "").replace(/\s*[\r\n]$/gm, "");
}

export function indexCodeFiles(WORKING_DIR: string) {
  if (!config.godotProjectDirs || !config.godotProjectDirs.length) {
    return [];
  }
  // Loop over all folders in this project, find ones that have a project.godot file in them
  let godotProjectFolders = [];
  searchFiles(WORKING_DIR, (currentPath, fileName) => {
    if (fileName === "project.godot") {
      let folderName = currentPath.split("/").at(-1);
      logger.debug(
        "Godot project folder",
        folderName,
        config.godotProjectDirs,
        config.godotProjectDirs.includes(folderName)
      );
      if (config.godotProjectDirs) {
        const shouldBeIncluded = config.godotProjectDirs.find((d) =>
          d.includes(folderName)
        );
        if (!shouldBeIncluded) return;
      }
      logger.debug("Found Godot project:", currentPath, folderName);
      godotProjectFolders.push(currentPath);
    }
  });
  type CodeFile = {
    fileName: string;
    filePath: string;
    godotProjectFolder: string;
    /* Path relative to godot project folder, used to add the path to the script at the top of the code block */
    relativeFilePath: string;
  };
  // Loop over all files in Godot project folders, find ones that have a .gd or .shader extension
  let codeFiles: CodeFile[] = [];
  for (let godotProjectFolder of godotProjectFolders) {
    searchFiles(godotProjectFolder, (currentPath, fileName) => {
      const fileExt = extname(fileName);
      const filePath = join(currentPath, fileName);
      // const folderName = currentPath.split('/').at(-1)
      // if (config.ignoreDirs && config.ignoreDirs.includes(folderName)) return
      if ([".gd", ".shader"].includes(fileExt)) {
        if ([".shader"].includes(fileExt))
          logger.debug("Found shader", fileName);
        // logger.debug(godotProjectFolder, filePath);
        codeFiles.push({
          fileName,
          filePath,
          godotProjectFolder,
          // Path relative to godot project folder, used to add the path to the script at the top of the code block
          relativeFilePath: filePath.replace(godotProjectFolder, ""),
        });
      }
    });
  }
  return codeFiles;
}

// To create links with shortcodes like {{ link lesson-slug subheading }}
export function indexLessonFiles(CONTENT_DIR: string) {
  type LessonFile = {
    slug: string;
    sectionSlug: string;
    fileName: string;
  };
  let allLessons: LessonFile[] = [];
  const sectionFolderNames = readdirSync(CONTENT_DIR);
  for (let sectionFolderName of sectionFolderNames) {
    if (["images", ".DS_Store", "_index.md"].includes(sectionFolderName))
      continue;

    const sectionFolderPath = join(CONTENT_DIR, sectionFolderName);
    const sectionIndex = getIndexFileStringContentFromDir(sectionFolderPath);
    const { data: sectionFrontmatter } = matter(sectionIndex);
    const lessonFileNames = readdirSync(sectionFolderPath);
    for (let lessonFileName of lessonFileNames) {
      // logger.debug('[indexLessonFiles] ', lessonFileName)
      const lessonFilePath = `${sectionFolderPath}/${lessonFileName}`;
      if (lstatSync(lessonFilePath).isDirectory()) continue;
      if ([".DS_Store"].includes(lessonFileName)) continue;
      let lessonText = readText(lessonFilePath);
      const { data: frontmatter, content } = matter(lessonText);
      // logger.debug('[indexLessonFiles] frontmatter ', frontmatter)
      let lesson = {
        slug: slugify(frontmatter.title), // frontmatter.slug,
        sectionSlug: sectionFrontmatter.slug,
        fileName: lessonFileName.replace(".md", ""),
      };
      allLessons.push(lesson);
    }
  }
  logger.debug("Indexed lessons", allLessons);
  return allLessons;
}

export function searchFiles(currentPath, callback) {
  const files = readdirSync(currentPath);
  for (let fileName of files) {
    const filePath = join(currentPath, fileName);
    if (statSync(filePath).isDirectory()) {
      if (config.ignoreDirs && config.ignoreDirs.includes(fileName)) continue;
      searchFiles(filePath, callback);
    } else {
      callback(currentPath, fileName);
    }
  }
}

export function loadConfig(WORKING_DIR: string) {
  try {
    config = readText(`${WORKING_DIR}/course.cfg`);
  } catch (e) {
    logger.debug("No course.cfg file found in the course directory.");
  }
  config = config ? parseConfig(config) : {};
}
