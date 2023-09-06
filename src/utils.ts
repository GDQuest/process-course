import fs from 'fs-extra'
import path, { join } from 'path'
import slugifyLib from 'slugify'

export function slugify(str: string) {
  return slugifyLib(str, {
    replacement: '-',
    lower: true,
    strict: true,
  })
}

// export async function loopOverFolders(parentFolderPath, callback) {
//   const folderNames = fs.readdirSync(parentFolderPath)
//   for (const folderName of folderNames) {
//     const folderPath = `${parentFolderPath}/${folderName}`
//     if (!fs.lstatSync(folderPath).isDirectory()) continue // ignore files, like .DS_Store
//     await callback(folderPath, folderName)
//   }
// }

// export async function loopOverFiles(parentFolderPath, callback) {
//   const fileNames = fs.readdirSync(parentFolderPath)
//   for (const fileName of fileNames) {
//     const filePath = `${parentFolderPath}/${fileName}`
//     if (fs.lstatSync(filePath).isDirectory()) continue // ignore folders
//     await callback(filePath, fileName)
//   }
// }

export function copyFiles(folderIn: string, folderOut: string) {
  if (!fs.existsSync(folderIn)) return
  // console.log('Copying files', { folderIn, folderOut })
  ensureDirExists(folderOut)
  fs.copySync(folderIn, folderOut)
  // console.log('Files copied')
}

export function deleteIfExists(folderPath: string) {
  fs.rmSync(folderPath, { recursive: true, force: true })
}

export function ensureDirExists(filePath: string, isDirectory = false) {
  var currentDirName = path.dirname(filePath)
  // By default I'm checking whether the folder containing this file exists.
  // Use this flag if I want it to pass a path to a directory, not a path to a file.
  if (isDirectory) currentDirName = filePath
  if (fs.existsSync(currentDirName)) return true
  ensureDirExists(currentDirName) // check nested dir
  fs.mkdirSync(currentDirName) // create folder for this one
}

export function readJson(path: string) {
  const text = fs.readFileSync(path, 'utf8')
  const parsed = JSON.parse(text)
  return parsed
}

export function saveJson(path: string, object) {
  ensureDirExists(path)
  fs.writeFileSync(path, JSON.stringify(object, null, 2))
}

export function readText(path: string) {
  const str = fs.readFileSync(path, 'utf8')
  return str
}

export function saveText(path: string, str: string) {
  ensureDirExists(path)
  fs.writeFileSync(path, str)
}

export function getRandomInt(min: number, max: number) {
  min = Math.ceil(min)
  max = Math.floor(max)
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// https://stackoverflow.com/questions/2450954/how-to-randomize-shuffle-a-javascript-array
// The de-facto unbiased shuffle algorithm is the Fisher-Yates (aka Knuth) Shuffle.
export function shuffle(array: []) {
  if (!array) return []
  let currentIndex = array.length
  // While there remain elements to shuffle.
  while (currentIndex > 0) {
    // Pick a remaining element.
    const randomIndex = Math.floor(Math.random() * currentIndex)
    currentIndex--
    // And swap it with the current element.
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]]
  }

  return array
}

/** smallest arg parser 
 * suitable for simple flags.
 * Attempts to generate help for options 
*/
export function readArgs (expand?: Record<string, [string, string]>) {
  return process.argv.slice(2).reduce(
    (acc, str) => {
      if (str[0] != "-") {
        acc.rest.push(str);
      } else {
        const { dashes, negation, key, val } = str.match(
          /(?<dashes>-+)(?<negation>no-)?(?<key>[^=]*)(?:=(?<val>.*))?/
        )?.groups || { dashes:"-", negation: "", key: str, val: "" };
        const keyword = dashes.length == 1 && expand && key in expand ? expand[key][0] : key;
        const value = negation
          ? false
          : typeof val === 'undefined' || val === ""
          ? true
          : val.toLowerCase() === "true"
          ? true
          : val.toLowerCase() === "false"
          ? false
          : val;
        acc[keyword] = value;
      }
      return acc;
    },
    {
      _: {
        executable: process.argv[0],
        path: process.argv[1],
        help: expand && Object.entries(expand).map(([abbr, [opt, desc]])=>`-${abbr}, --${opt}\t${desc}`) || []
      },
      rest: [],
    } as Record<string, string|boolean> & {
      _: {
        executable: string,
        path: string,
        help: string[]
      },
      rest: string[],
    }
  )
}

export function getDate() {
  const today = new Date()
  const year = today.getFullYear()
  const month = (today.getMonth() + 1).toString().padStart(2, '0')
  const day = today.getDate().toString().padStart(2, '0')
  const formattedDate = `${year}-${month}-${day}`
  return formattedDate
}

/**
 * Returns a git hash. Fails silently
 * @param root The root where `.git` should be found
 * @returns a string representing the hash, or an empty string in case of errors
 */
export function getGitHash(root = process.cwd()) {
  const gitPath = join(root, '.git')
  const gitHeadPath = join(gitPath,'/HEAD')
  if(fs.existsSync(gitHeadPath)){
    const rev = fs.readFileSync(gitHeadPath).toString().trim().split(/.*[: ]/).slice(-1)[0];
    if (rev.indexOf('/') === -1) {
      return rev;
    } else {
      return fs.readFileSync(join(gitPath, rev)).toString().trim();
    }
  }
  return ""
}