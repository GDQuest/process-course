#!/usr/bin/env node
import "ulog";
import { realpathSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	parseArgs,
	bool,
	number,
} from "@kinda-ok/convenient/dist/parseArgs.mjs";
import {
	logger,
	buildRelease,
	processAll,
	watchAll,
	processContent,
	processGodotProjects,
	watchContent,
	watchGodotProjects,
} from "./index.mjs";
import { red } from "@kinda-ok/convenient-node/dist/cliColors.mjs";

const makeUsage = (file: string) => `
  USAGE:
  ${file} [options] [SOURCE] DESTINATION
`;

const help = (file: string, options: string[]) => {
	console.log(`
  Preprocessor for GDQuest Courses
  
  Processes the course content into the format compatible with the new GDSchool platform.
  
${makeUsage(file)}
  
  EXAMPLES:
    Process all content in the current directory to an existing "out" directory
    ${file} -pc out
  
    Process all content in the current directory and create an "out" directory
    ${file} -pc -mk out
  
    Watch all files in "in" and create an "out" directory
    ${file} -w -mk in out

  If 'SOURCE' isn't specified, the current directory will be used.
  it is assumed a 'content' directory can be found inside the working dir.
  
  options:
    ${options.join("\n    ")},

  For processing Godot, an instance of Godot 4 is necessary. Either make sure
  it's on the $PATH, or specify the environment variable GODOT_EXE.

  NOTE: At least one option needs to be provided.
`);
};

const error = (file: string, message: string) => {
	console.error(red`\n  ` + message);
	console.error(makeUsage(file));
	console.error(`use --help or -h for more explanations`);
	process.exit(1);
};

export async function runCli() {
	const { optionsDocs, options, file, rest, unknown } = parseArgs(
		process.argv,
		{
			watchAll: ["w", "run in watch mode", bool()],
			watchContent: ["wc", "run in watch content mode", bool()],
			watchGodot: ["wg", "run in watch Godot projects mode", bool()],
			processAll: ["p", "process all (content & godot projects)", bool()],
			processContent: ["pc", "process content", bool()],
			processGodot: ["pg", "process godot projects", bool()],
			buildRelease: ["b", "build zip release", bool()],
			mkdir: [
				"mk",
				"create destination directories if they don't exist",
				bool(),
			],
			explain: ["e", "TODO: Explain what will happen before doing it", bool()],
			verbose: ["v", "sets log level to 4 (LOG)", bool()],
			help: ["h", "this text", bool()],
			logLevel: [
				"ll",
				[
					"set verbosity from TRACE (6) to ERROR (1).",
					"See https://www.npmjs.com/package/ulog#levels",
				],
				number(2, 1, 6),
			],
		}
	);

	//@ts-expect-error We do not have the TS API of ulog, which adds those constants
	logger.level = options.verbose ? options.LOG : options.logLevel;

	logger.debug(options);

	if (unknown.length) {
		error(file, `ERROR: invalid option(s) -- '${unknown.join("', '")}'`);
	}

	if (options.help) {
		help(file, optionsDocs);
		process.exit(0);
	}

	if (rest.length === 0) {
		error(
			file,
			`ERROR: You need to provide at least one path for the output, or two paths for input and output`
		);
	}

	if (options.explain) {
		error(file, `Explain not implemented yet!`);
	}

	const ensure = (path: string, dieOnError: boolean) => {
		try {
			const realPath = realpathSync(path);
			if (!existsSync(path)) {
				throw new Error(`Path ${path} does not exist`);
			}
			return realPath;
		} catch (e) {
			if (dieOnError) {
				error(file, `could not find or access "${path}"`);
			} else {
				logger.warn(`Dir ${path} does not exist. It will be created`);
				try {
					mkdirSync(path, { recursive: true });
					return realpathSync(path);
				} catch (e) {
					error(file, `could not create the directory "${path}"`);
				}
			}
		}
	};

	const [workingDirPath, outputDirPath] =
		rest.length > 1 ? [rest[0], rest[1]] : [process.cwd(), rest[0]];

	ensure(workingDirPath, true);
	const contentDirPath = join(workingDirPath, "content");
	ensure(contentDirPath, true);

	ensure(outputDirPath, !options.mkdir);

	const releasesDirPath = join(workingDirPath, "content-releases");

	logger.info({
		workingDirPath,
		outputDirPath,
		contentDirPath,
		releasesDirPath,
	});

	if (options.buildRelease || options.watchAll) {
		options.processAll = true;
		options.processContent = false;
		options.processGodot = false;
	}

	if (options.watchContent) {
		options.processContent = true;
	}

	if (options.watchGodot) {
		options.processGodot = true;
	}

	if (options.processAll && !(options.processContent || options.processGodot)) {
		await processAll(workingDirPath, contentDirPath, outputDirPath);
	}

	if (options.processContent) {
		await processContent(workingDirPath, contentDirPath, outputDirPath);
	}

	if (options.processGodot) {
		processGodotProjects(workingDirPath, outputDirPath);
	}

	if (options.buildRelease) {
		ensure(releasesDirPath, !options.mkdir);
		buildRelease(workingDirPath, outputDirPath, releasesDirPath);
	}

	if (options.watchAll && !(options.watchContent || options.watchGodot)) {
		watchAll(workingDirPath, contentDirPath, outputDirPath);
	}

	if (options.watchContent) {
		watchContent(workingDirPath, contentDirPath, outputDirPath);
	}

	if (options.watchGodot) {
		watchGodotProjects(workingDirPath, outputDirPath);
	}
}

runCli();
