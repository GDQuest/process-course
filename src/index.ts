import * as dotenv from 'dotenv'
dotenv.config()
import fs from 'fs-extra'
import path from 'path'
import matter from 'gray-matter'
import { copyFiles, readText, saveText, ensureDirExists, readJson, saveJson } from './utils'
import { zip } from 'zip-a-folder'

const WORKING_DIR = process.cwd() // + `/learn-to-code-from-zero-test`
const CONTENT_DIR = `${WORKING_DIR}/content-gdschool`
const OUTPUT_DIR = `${WORKING_DIR}/content-gdschool-processed`
const RELEASES_DIR = `${WORKING_DIR}/content-gdschool-releases`

async function main() {
  let courseIndexText = readText(`${CONTENT_DIR}/_index.md`)
  const { data: courseFrontmatter } = matter(courseIndexText)
  // Copy all files to the output folder
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
  copyFiles(CONTENT_DIR, OUTPUT_DIR)
  // Find all code files in Godot project folders, so that I can later use them to replace include shortcodes inside codeblocks
  const codeFiles = indexCodeFiles()

  // Process the content of the landing page
  courseIndexText = rewriteImagePaths(courseIndexText, `/courses/${courseFrontmatter.slug}`)
  saveText(`${OUTPUT_DIR}/_index.md`, courseIndexText)

  // Loop over sections
  for (const sectionDirName of fs.readdirSync(OUTPUT_DIR)) {
    const sectionDirPath = `${OUTPUT_DIR}/${sectionDirName}`
    if (!fs.lstatSync(sectionDirPath).isDirectory()) continue // ignore files
    if (sectionDirName === 'images') continue // ignore the folder containing images for the landing page
    console.log(`Processing section: ${sectionDirName}`)
    let sectionIndexText = readText(`${sectionDirPath}/_index.md`)
    const { data: sectionFrontmatter } = matter(sectionIndexText)

    // Loop over lessons
    for (const lessonFileName of fs.readdirSync(sectionDirPath)) {
      const lessonFilePath = `${sectionDirPath}/${lessonFileName}`
      if (fs.lstatSync(lessonFilePath).isDirectory()) continue // ignore directories containing images, files, etc.
      if (['_index.md', '.DS_Store'].includes(lessonFileName)) continue // ignore section index and .DS_Store files
      console.log(`Processing lesson: ${lessonFileName}`)
      let lessonText = readText(lessonFilePath)

      // Process the content of the lesson - rewrite image paths, replace shortcodes, etc.
      const imagePathPrefix = `/courses/${courseFrontmatter.slug}/${sectionFrontmatter.slug}`
      lessonText = rewriteImagePaths(lessonText, imagePathPrefix)
      lessonText = processCodeblocks(lessonText, lessonFileName, codeFiles)

      // Saving the processed lesson, in place.
      saveText(lessonFilePath, lessonText)
    }
  }
  console.log('Compressing the processed course');
  const fileName = `${RELEASES_DIR}/${courseFrontmatter.slug}-${getDate()}.zip`
  ensureDirExists(fileName)
  await zip(OUTPUT_DIR, fileName)
}

// Replace image paths to absolute ones.
function rewriteImagePaths(lessonText, imagePathPrefix) {
  const markdownImagePathRegex = /!\[\]\((.+?)\)/g
  lessonText = lessonText.replace(markdownImagePathRegex, (match, imagePath) => {
    const modifiedImagePath = `${imagePathPrefix}/${imagePath}`
    return `![](${modifiedImagePath})`
  })
  const htmlImagePathRegex = /<img src="(.+?)"(.+?)\/>/g
  lessonText = lessonText.replace(htmlImagePathRegex, (match, imagePath, attributes) => {
    const modifiedImagePath = `${imagePathPrefix}/${imagePath}`
    return `<img src="${modifiedImagePath}"${attributes}/>`
  })
  const thumbnailImagePathRegex = /^thumbnail:\s*(.*)$/gm
  lessonText = lessonText.replace(thumbnailImagePathRegex, (match, imagePath, attributes) => {
    const modifiedImagePath = `${imagePathPrefix}/${imagePath}`
    return `thumbnail: ${modifiedImagePath}`
  })
  return lessonText
}

function processCodeblocks(lessonText, lessonFileName, codeFiles) {
  // Add filenames to codeblocks, like ```gdscript:/path/to/file/FileName.gd
  lessonText = addFilenamesToCodeblocks(lessonText, codeFiles)
  // Replace includes with code. Include looks like this: {{ include FileName.gd anchor_name }}
  const includeRegex = /{{\s*include\s+([^\s]+)(?:\s+([^\s]+))?\s*}}/g
  lessonText = lessonText.replace(includeRegex, (match, fileName, anchor) => {
    let updatedContent = `This line replaces the include for ${fileName}, ${anchor}` // just for testing
    // Find the code file by name so I could read its content
    let codeFilePath = codeFiles.find((codeFile) => codeFile.fileName === fileName)?.filePath
    // If the file path is absolute, use it as is
    if (fileName.includes('/')) codeFilePath = WORKING_DIR + '/' + fileName

    if (!codeFilePath) throw new Error(`Code file not found: ${lessonFileName} ${fileName}`)

    let codeText = readText(codeFilePath)
    updatedContent = codeText
    // If it has anchor tags, extract the text between them
    if (anchor) updatedContent = extractTextBetweenAnchors(codeText, anchor)
    updatedContent = removeAnchorTags(updatedContent)
    // updatedContent = trimBlankLines(updatedContent)
    return updatedContent
  })
  return lessonText
}

function addFilenamesToCodeblocks(lessonText, codeFiles) {
  const regex = /(```gdscript)(\s*\n)(\{\{\s*include\s+([^}\s]+))/g
  lessonText = lessonText.replace(regex, (match, p1, p2, p3, fileName) => {
    let relativeFilePath = codeFiles.find((codeFile) => codeFile.fileName === fileName)?.relativeFilePath
    // If instead of the file name the path to the file was provided, like:
    // {{ include godot-complete-demos/ObstacleCourse_Part2/pickups/Pickup.gd apply_effect }}
    if (fileName.includes('/')) relativeFilePath = `${fileName.split('/').at(-1)}` // .split('/').slice(1).join('/')

    return `${p1}:${relativeFilePath}${p2}${p3}`
  })
  return lessonText
}

function extractTextBetweenAnchors(content, anchorName) {
  const anchorPattern = new RegExp(
    `(?:#|\\/\\/)\\s*ANCHOR:\\s*\\b${anchorName}\\b\\s*\\r?\\n(.*?)\\s*(?:#|\\/\\/)\\s*END:\\s*\\b${anchorName}\\b`,
    'gms'
  )
  const match = anchorPattern.exec(content)
  if (!match || !match[1]) throw new Error('No matching anchor found.')
  return match[1]
}

function removeAnchorTags(content) {
  // const anchorPattern = /#\s*(ANCHOR:|END:).*\n?\s*/gm
  const anchorPattern = /^.*#(ANCHOR|END).*\r?\n?/gm
  return content.replace(anchorPattern, '').trimEnd()
}

function trimBlankLines(str) {
  // Use regular expression to replace blank lines at the beginning and end of the string
  return str.replace(/^\s*[\r\n]/gm, '').replace(/\s*[\r\n]$/gm, '')
}

function indexCodeFiles() {
  // Loop over all folders in this project, find ones that have a project.godot file in them
  let godotProjectFolders = []
  searchFiles(WORKING_DIR, (currentPath, fileName) => {
    if (fileName === 'project.godot') {
      // console.log('Found Godot project:', currentPath)
      godotProjectFolders.push(currentPath)
    }
  })
  // Loop over all files in Godot project folders, find ones that have a .gd or .shader extension
  let codeFiles = []
  for (let godotProjectFolder of godotProjectFolders) {
    searchFiles(godotProjectFolder, (currentPath, fileName) => {
      const fileExt = path.extname(fileName)
      const filePath = path.join(currentPath, fileName)
      if (['.gd', '.shader'].includes(fileExt)) {
        // console.log(godotProjectFolder, filePath);
        codeFiles.push({
          fileName,
          filePath,
          godotProjectFolder,
          // Path relative to godot project folder, used to add the path to the script at the top of the code block
          relativeFilePath: filePath.replace(godotProjectFolder, ''),
        })
      }
    })
  }
  return codeFiles
}

function searchFiles(currentPath, callback) {
  const files = fs.readdirSync(currentPath)
  for (let fileName of files) {
    const filePath = path.join(currentPath, fileName)
    if (fs.statSync(filePath).isDirectory()) {
      searchFiles(filePath, callback)
    } else {
      callback(currentPath, fileName)
    }
  }
}

function getDate() {
  const today = new Date()
  const year = today.getFullYear()
  const month = (today.getMonth() + 1).toString().padStart(2, '0')
  const day = today.getDate().toString().padStart(2, '0')
  const formattedDate = `${year}-${month}-${day}`
  return formattedDate
}

main()
