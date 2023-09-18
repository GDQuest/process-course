import * as fs from "fs"
import p from "path"
import pino from "pino"
import { logger, buildRelease, setLogger, processAll, watchAll, processContent, processGodotProjects, watchContent, watchGodotProjects } from "./index.mts"

type Args = Record<string, string | boolean> & {
  _: {
    executable: string,
    path: string,
    options: string[]
  },
  rest: string[],
}

runCli()

function help(args: Args) {
  console.log([
    "",
    "Preprocessor for GDQuest Courses",
    "",
    "Processes the course content into the format compatible with the new GDSchool platform.",
    "",
    "USAGE:",
    `${p.basename(args._.path)} [options] [path]`,
    "",
    "options:",
    `  ${args._.options.join("\n  ")}`,
    "",
    "if path isn't specified, the current directory will be used",
    "",
  ].join("\n"))
}

export function runCli() {
  setLogger(pino({
    name: "processCourse",
    level: "info",
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        ignore: "pid,hostname",
        translateTime: "HH:MM:ss",
      },
    },
  }))

  const args = readArgs({
    A: ["watchAll", "run in watch mode"],
    C: ["watchContent", "run in watch content mode"],
    G: ["watchGodot", "run in watch Godot projects mode"],
    a: ["processAll", "process all (content & godot projects)"],
    b: ["buildRelease", "build zip release. Implies '-a'"],
    c: ["processContent", "process content"],
    g: ["processGodot", "process godot projects"],
    h: ["help", "this text"],
    v: ["verbose", "set verbosity"],
  })

  const workingDirPath = args.rest.length > 0 ? fs.realpathSync(args.rest[0]) : process.cwd()
  const contentDirPath = p.join(workingDirPath, "content")
  const outputDirPath = p.join(workingDirPath, "content-processed")

  if (args.help) {
    help(args)
    process.exit(0)
  }

  if (args.verbose) {
    logger.level = "debug"
  }

  if (args.buildRelease || args.watchAll) {
    args.processAll = true
  }

  if (args.processAll && !(args.processContent || args.processGodot)) {
    processAll(workingDirPath, contentDirPath, outputDirPath)
  }

  if (args.processContent) {
    processContent(workingDirPath, contentDirPath, outputDirPath)
  }

  if (args.processGodot) {
    processGodotProjects(workingDirPath, outputDirPath)
  }

  if (args.buildRelease) {
    const releasesDirPath = p.join(workingDirPath, "content-releases")
    buildRelease(workingDirPath, outputDirPath, releasesDirPath)
    process.exit(0)
  }

  if (args.watchAll && !(args.watchContent || args.watchGodot)) {
    watchAll(workingDirPath, contentDirPath, outputDirPath)
  }

  if (args.watchContent) {
    watchContent(workingDirPath, contentDirPath, outputDirPath)
  }

  if (args.watchGodot) {
    watchGodotProjects(workingDirPath, outputDirPath)
  }
}

export function readArgs(expand?: Record<string, [string, string]>) {
  return process.argv.slice(2).reduce(
    (acc, str) => {
      if (!str.startsWith("-")) {
        acc.rest.push(str)
      } else {
        const { dashes, isNegated, key, val } = str.match(
          /(?<dashes>-+)(?<isNegated>no-)?(?<key>[^=]*)(?:=(?<val>.*))?/
        )?.groups || { dashes: "-", isNegated: "", key: str, val: "" }
        const keyword = dashes.length == 1 && expand && key in expand ? expand[key][0] : key
        const value = isNegated
          ? false
          : typeof val === 'undefined' || val === ""
            ? true
            : val.toLowerCase() === "true"
              ? true
              : val.toLowerCase() === "false"
                ? false
                : val
        acc[keyword] = value
      }
      return acc
    },
    {
      _: {
        executable: process.argv[0],
        path: process.argv[1],
        options: expand && Object
          .entries(expand)
          .map(([abbr, [opt, desc]]) => `-${abbr}, --${opt.padEnd(16)}${desc}`) || []
      },
      rest: [],
    } as Args
  )
}
