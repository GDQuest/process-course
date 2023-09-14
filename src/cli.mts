import * as fs from "fs"
import p from "path"
import pino from "pino"
import { setLogger, processContent } from "./index.mts"

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
    b: ["build", "process the files"],
    h: ["help", "this text"],
    w: ["watch", "run in watch mode"],
    z: ["zip", "build release version and zip results"],
  })

  const workingDirPath = args.rest.length > 0 ? fs.realpathSync(args.rest[0]) : process.cwd()

  if (args.help) {
    help(args)
    process.exit(0)
  } else if (args.build) {
    processContent(workingDirPath)
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
          .map(([abbr, [opt, desc]]) => `-${abbr}, --${opt}\t${desc}`) || []
      },
      rest: [],
    } as Args
  )
}
