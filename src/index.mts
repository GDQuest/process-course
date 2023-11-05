import * as fs from "fs";
import * as fse from "fs-extra";
import * as chokidar from "chokidar";
import p from "path";
import AdmZip from "adm-zip";
import anylogger from "anylogger";
import matter from "gray-matter";
import remarkGfm from "remark-gfm";
import remarkUnwrapImages from "remark-unwrap-images";
import rehypeSlug from "rehype-slug";
import rehypeCodeTitles from "rehype-code-titles";
import rehypePrism from "rehype-prism-plus";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import slugify from "slugify";
import { execSync, spawnSync } from "child_process";
import type { MDXRemoteSerializeResult } from "next-mdx-remote";
import { serialize } from "next-mdx-remote/serialize";
import { visit, type BuildVisitor } from "unist-util-visit";
//import { markdownToTxt } from "markdown-to-txt"
import { VFile } from "vfile";
import * as utils from "./utils.mjs";
import { getGodotPathOrDie, spawnGodot4 } from "./godotUtils.mjs";
import type { Element } from "hast";
import type { Image, Link, Parent, Node, Heading } from "mdast";
import type {
	MdxJsxFlowElement,
	MdxJsxAttribute,
	MdxJsxExpressionAttribute,
} from "mdast-util-mdx-jsx";

type RemarkVisitedNodes = {
	images: (Image | MdxJsxFlowElement)[];
	links: Link[];
};

type SerializeOptions = Exclude<Parameters<typeof serialize>[1], undefined>;
type PluggableList = Exclude<
	Exclude<SerializeOptions["mdxOptions"], undefined>["remarkPlugins"],
	undefined | null
>;

type RehypeVisitedNodes = { headings: Heading[] };

type Index = {
	frontmatter: any;
	content: string;
};
type LessonTOC = {
	headingType: "h1" | "h2" | "h3";
	title: string;
	link: string;
};
type LessonPrevNext = {
	title: string;
	url: string;
};
type Lesson = {
	serializedMDX: MDXRemoteSerializeResult;
	url: string;
	title: string;
	slug: string;
	toc: LessonTOC[];
	free: boolean;
	draft: boolean;
	prev: LessonPrevNext | null;
	next: LessonPrevNext | null;
};
type SectionLesson = {
	outPath: string;
	in: string;
	out: Lesson;
};
type Section = {
	title: string;
	lessons: SectionLesson[];
};
type CacheLessonEntry = {
	in: string;
	out: Lesson;
};
type Cache = {
	index: Record<string, Index>;
	lessons: Record<string, CacheLessonEntry>;
	godotProjects: Record<string, string[]>;
};

/** The path to store the output courses on */
const COURSES_ROOT_FS_PATH = "/courses";
const OUT_COURSES_PATH = p.join(`content`, `json`, COURSES_ROOT_FS_PATH);
const PUBLIC_DIR = "public";
const MD_EXT = ".md";
const JSON_EXT = ".json";
const ZIP_EXT = ".zip";
const GDSCRIPT_EXT = ".gd";
const IN_INDEX_FILE = `_index${MD_EXT}`;
const OUT_INDEX_FILE = `index${JSON_EXT}`;
const OUT_INDEX_SEARCH_FILE = `index-search${JSON_EXT}`;
const GODOT_PRACTICE_BUILD = [
	"addons",
	"gdquest_practice_framework",
	"build.gd",
];
const GODOT_PROJECT_FILE = "project.godot";
const GODOT_IGNORED = [".plugged", ".git", ".gitattributes", ".gitignore"];
const SECTION_REGEX = /\d+\..+/;
const HTML_COMMENT_REGEX = /<\!--.*?-->/g;
const GDSCRIPT_CODEBLOCK_REGEX = /(```gdscript:.*)(_v\d+)(.gd)/g;
const CODEBLOCK_REGEX = /```[a-z]*\n[\s\S]*?\n```/g;
const INCLUDE_REGEX = /{{\s*include\s+([^\s]+)(?:\s+([^\s]+))?\s*}}/g;
const CODEBLOCK_INCLUDE_FILE_REGEX =
	/(```gdscript)(\s*\n)(\{\{\s*include\s+([^}\s]+))/g;
const OVERLY_LINE_BREAKS_REGEX = /\n{3,}/g;
const ANCHOR_TAGS_REGEX = /^.*#(ANCHOR|END).*\r?\n?/gm;

const SLUGIFY_OPTIONS = {
	replacement: "-",
	lower: true,
	strict: true,
};

export const PRODUCTION = "production";

let cache: Cache = {
	index: {},
	lessons: {},
	godotProjects: {},
};

const jsonPrettyPrint = (data: any) => JSON.stringify(data, null, 2)

export const logger = anylogger("processCourse");

export function watchAll(
	workingDirPath: string,
	contentDirPath: string,
	outputDirPath: string
) {
	watchContent(workingDirPath, contentDirPath, outputDirPath);
	watchGodotProjects(workingDirPath, outputDirPath);
}

export function watchContent(
	workingDirPath: string,
	contentDirPath: string,
	outputDirPath: string
) {
	indexSections(contentDirPath);
	indexGodotProjects(workingDirPath);
	const watcher = chokidar.watch(contentDirPath, { ignored: "**~" });
	watcher.on("ready", () => {
		watcher.on("all", (eventName, inPath) => {
			if (eventName === "unlink" || eventName === "unlinkDir") {
				if (p.basename(inPath) === IN_INDEX_FILE) {
					delete cache.index[p.dirname(inPath)];
				} else if (p.extname(inPath) === MD_EXT) {
					let outPath = getMarkdownFileOutPath(
						getMarkdownFileSlugs(cache.lessons[inPath].out.slug, inPath),
						outputDirPath
					);
					fs.rmSync(outPath, { force: true, recursive: true });
					delete cache.lessons[inPath];
					logger.debug(`Removing '${outPath}'`);

					outPath = p.dirname(outPath);
					if (fs.readdirSync(outPath).length === 0) {
						fs.rmSync(outPath, { force: true, recursive: true });
						logger.debug(`Also removing '${outPath}' because it's empty`);
					}
				}
			} else if (["add", "change"].includes(eventName)) {
				if (p.basename(inPath) === IN_INDEX_FILE) {
					indexSection(p.dirname(inPath));
				} else if (p.extname(inPath) === MD_EXT) {
					processMarkdownFile(inPath, workingDirPath, outputDirPath)
						.then(() => {
							processFinal(contentDirPath, outputDirPath);
						})
						.catch((reason) => logger.warn(reason));
				} else {
					processOtherFile(inPath, contentDirPath, outputDirPath);
				}
			}
		});
	});
}

export function watchGodotProjects(
	workingDirPath: string,
	outputDirPath: string
) {
	const godotProjectDirPaths = utils.fsFind(workingDirPath, {
		depthLimit: 0,
		nofile: true,
		filter: ({ path }) => fs.existsSync(p.join(path, GODOT_PROJECT_FILE)),
	});
	for (const godotProjectDirPath of godotProjectDirPaths) {
		const watcher = chokidar.watch(godotProjectDirPath, {
			ignored: [
				"**/practices/**",
				"**~",
				...GODOT_IGNORED.map((path) => `**/${path}`),
			],
		});
		watcher.on("ready", () => {
			watcher.on("all", () => {
				processGodotProject(godotProjectDirPath, outputDirPath);
			});
		});
	}
}

export async function processAll(
	workingDirPath: string,
	contentDirPath: string,
	outputDirPath: string
) {
	await processContent(workingDirPath, contentDirPath, outputDirPath);
	processGodotProjects(workingDirPath, outputDirPath);
}

export async function processContent(
	workingDirPath: string,
	contentDirPath: string,
	outputDirPath: string
) {
	indexSections(contentDirPath);
	indexGodotProjects(workingDirPath);
	await processMarkdownFiles(workingDirPath, contentDirPath, outputDirPath);
	//processFinal(contentDirPath, outputDirPath)
	//processOtherFiles(contentDirPath, outputDirPath)
}

export function indexSections(contentDirPath: string) {
	if (!utils.isObjectEmpty(cache.index)) {
		return;
	}
	const inDirPaths = [
		contentDirPath,
		...utils.fsFind(contentDirPath, {
			depthLimit: 0,
			nofile: true,
			filter: ({ path }) => SECTION_REGEX.test(p.basename(path)),
		}),
	];
	for (const inDirPath of inDirPaths) {
		indexSection(inDirPath);
	}
}

export function indexGodotProjects(workingDirPath: string) {
	if (!utils.isObjectEmpty(cache.godotProjects)) {
		return;
	}
	const godotProjectDirPaths = utils.fsFind(workingDirPath, {
		depthLimit: 0,
		nofile: true,
		filter: ({ path }) => fs.existsSync(p.join(path, GODOT_PROJECT_FILE)),
	});
	for (const godotProjectDirPath of godotProjectDirPaths) {
		indexGodotProject(godotProjectDirPath);
	}
}

export function indexGodotProject(godotProjectDirPath: string) {
	cache.godotProjects[godotProjectDirPath] = utils.fsFind(godotProjectDirPath, {
		nodir: true,
		traverseAll: true,
		filter: ({ path }) =>
			p.extname(path) === GDSCRIPT_EXT &&
			![...GODOT_IGNORED, "solutions"].some((dir) => path.includes(dir)),
	});
}

export function buildRelease(
	workingDirPath: string,
	outputDirPath: string,
	releasesDirPath: string
) {
	const slug = getCacheCourseSlug();
	const outFilePath = p.join(
		releasesDirPath,
		`${slug}-${utils.getDate()}-${utils.getGitHash(workingDirPath)}${ZIP_EXT}`
	);
	logger.debug(`Saving the processed course '${slug}' at '${outFilePath}'`);
	fse.ensureDirSync(releasesDirPath);
	const zip = new AdmZip();
	zip.addLocalFolder(outputDirPath);
	zip.writeZip(outFilePath);
}

export function indexSection(inDirPath: string) {
	let inFileContent = "";
	const inFilePath = p.join(inDirPath, IN_INDEX_FILE);
	if (utils.checkPathExists(inFilePath)) {
		inFileContent = fs.readFileSync(inFilePath, "utf8");
	} else {
		const defaultName = p.basename(inDirPath).replace(/^\d+\./, "");
		inFileContent = [
			"---",
			`title: "PLACEHOLDER TITLE (missing _index.md): ${defaultName.replace(
				/-/,
				" "
			)}"`,
			`slug: ${defaultName}`,
			"---",
			"",
		].join("\n");
	}

	if (inFileContent !== "") {
		let { data: frontmatter, content } = getMatter(inFileContent, inFilePath);
		content = content.trim();
		frontmatter.slug ??= slugify(frontmatter.title as string, SLUGIFY_OPTIONS);
		cache.index[inDirPath] = { frontmatter, content };
		logger.debug(`Indexed '${inFilePath}'`);
	}
}

export async function processFinal(
	contentDirPath: string,
	outputDirPath: string
) {
	const { frontmatter, content } = cache.index[contentDirPath];
	let outFilePath = p.join(
		outputDirPath,
		OUT_COURSES_PATH,
		frontmatter.slug,
		OUT_INDEX_FILE
	);
	logger.debug(`Processing '${outFilePath}'`);

	const sections = getCacheSections(outputDirPath);
	updateLessonsPrevNext(sections);

	const toc = generateCourseTOC(sections);
	const thumbnailPath = p.resolve(contentDirPath, frontmatter.thumbnail);
	fse.ensureDirSync(p.dirname(outFilePath));
	fs.writeFileSync(
		outFilePath,
		jsonPrettyPrint({
			title: frontmatter.title,
			slug: frontmatter.slug,
			description: frontmatter.description,
			tagline: frontmatter.tagline,
			salesPoints: frontmatter.salesPoints,
			lastUpdated: frontmatter.lastUpdated,
			godotVersion: frontmatter.godotVersion,
			courseDuration: frontmatter.courseDuration,
			thumbnail: p.posix.join(
				COURSES_ROOT_FS_PATH,
				frontmatter.slug,
				p.posix.normalize(p.relative(contentDirPath, thumbnailPath))
			),
			thumbnailPlaceholder: await utils.downscaleImage(thumbnailPath),
			video: frontmatter.video,
			draft: frontmatter.draft || false,
			price: frontmatter.price || 0,
			tags: (frontmatter.tags || []).map((tag: string) => ({
				name: tag,
				slug: slugify(tag, SLUGIFY_OPTIONS),
			})),
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
			sections,
		})
	);

	outFilePath = p.join(
		outputDirPath,
		OUT_COURSES_PATH,
		frontmatter.slug,
		OUT_INDEX_SEARCH_FILE
	);
	logger.debug(`Processing '${outFilePath}'`);
	fs.writeFileSync(
		outFilePath,
		jsonPrettyPrint(
			Object.entries(cache.lessons).map(([inFilePath, lesson]) => {
				const [courseSlug, sectionSlug, slug] = getMarkdownFileSlugs(
					lesson.out.slug,
					inFilePath
				);
				return {
					courseSlug,
					sectionSlug,
					slug,
					url: lesson.out.url,
					title: lesson.out.title,
					text: lesson.in,
				};
			})
		)
	);
}

export async function processMarkdownFiles(
	workingDirPath: string,
	contentDirPath: string,
	outputDirPath: string
) {
	const inFilePaths = utils.fsFind(contentDirPath, {
		nodir: true,
		traverseAll: true,
		filter: ({ path }) =>
			p.extname(path) === MD_EXT && p.basename(path) !== IN_INDEX_FILE,
	});
	for (const inFilePath of inFilePaths) {
		await processMarkdownFile(inFilePath, workingDirPath, outputDirPath);
	}
}

export function getGodotCodeFileDecoration(inPath: string) {
	inPath = p.posix.normalize(inPath);
	const doIncludeGodotProjectName = Object.keys(cache.godotProjects).length > 1;
	for (const godotProjectDirPath in cache.godotProjects) {
		for (const godotCodeFilePath of cache.godotProjects[godotProjectDirPath]) {
			if (p.posix.normalize(godotCodeFilePath).endsWith(inPath)) {
				return p.posix.join(
					p.sep,
					p.posix.relative(
						doIncludeGodotProjectName
							? p.posix.dirname(godotProjectDirPath)
							: godotProjectDirPath,
						godotCodeFilePath
					)
				);
			}
		}
	}
	return "";
}

export function addCodeBlocksFilename(content: string) {
	return content.replace(
		CODEBLOCK_INCLUDE_FILE_REGEX,
		(_, p1, p2, p3, file) => {
			return `${p1}:${getGodotCodeFileDecoration(file)}${p2}${p3}`;
		}
	);
}

export function replaceIncludes(content: string, inFilePath: string) {
	return content.replace(
		INCLUDE_REGEX,
		(match, file: string, anchor: string) => {
			let result = match;
			const codeFilePaths = Object.values(cache.godotProjects).reduce(
				(acc, codeFilePaths) =>
					acc.concat(
						codeFilePaths.filter((path) =>
							p.posix.normalize(path).endsWith(file)
						)
					),
				[]
			);
			let errorMessage = "";
			if (codeFilePaths.length === 0) {
				errorMessage = `code file not found for '${inFilePath}'`;
			} else if (codeFilePaths.length > 1) {
				errorMessage = [
					`multiple code files with the same name found for '${inFilePath}':`,
					...codeFilePaths,
				].join("\n");
			}

			for (const codeFilePath of codeFilePaths) {
				result = fs.readFileSync(codeFilePath, "utf8");
				if (anchor) {
					try {
						result = extractTextBetweenAnchors(result, anchor).replace(
							ANCHOR_TAGS_REGEX,
							""
						);
					} catch (error) {
						errorMessage = `error extracting text between anchors for '${inFilePath}' at '${codeFilePath}'`;
					}
				}
				break;
			}

			if (errorMessage) {
				errorMessage = `'{{ include ${file} ${anchor} }}' ${errorMessage}`;
				if (process.env.NODE_ENV === PRODUCTION) {
					logger.error(errorMessage);
					throw Error(errorMessage);
				} else {
					logger.warn(errorMessage);
				}
			}
			return result;
		}
	);
}

export async function processMarkdownFile(
	inFilePath: string,
	workingDirPath: string,
	outputDirPath: string
) {
	let { data: frontmatter, content } = getMatter(
		fs.readFileSync(inFilePath, "utf8"),
		inFilePath
	);
	let vFile = new VFile(content);

	content = //markdownToTxt(
		content
			.trim()
			.replace(CODEBLOCK_REGEX, "")
			.replace(OVERLY_LINE_BREAKS_REGEX, "\n\n");
	//)
	frontmatter.slug ??= slugify(frontmatter.title as string, SLUGIFY_OPTIONS);
	if (process.env.NODE_ENV === PRODUCTION && frontmatter.draft) {
		return;
	}
	const slugs = getMarkdownFileSlugs(frontmatter.slug, inFilePath);
	const outFilePath = getMarkdownFileOutPath(slugs, outputDirPath);
	const doWriteFile = utils.isFileAOlderThanB(outFilePath, inFilePath);
	if (doWriteFile) {
		logger.debug(`Processing '${outFilePath}'`);
		const serializedMDX = await getSerialized(
			vFile,
			frontmatter,
			[remarkProcessMarkdownFile(inFilePath, workingDirPath, outputDirPath)],
			[rehypeProcessMarkdownFile]
		);
		const out: Lesson = {
			serializedMDX,
			url: p.posix.join("/course", ...slugs),
			title: frontmatter.title,
			slug: frontmatter.slug,
			toc: vFile.data.toc as LessonTOC[],
			free: frontmatter.free || false,
			draft: frontmatter.draft || false,
			prev: null,
			next: null,
		};

		fse.ensureDirSync(p.dirname(outFilePath));
		fs.writeFileSync(outFilePath, jsonPrettyPrint(out));
		cache.lessons[inFilePath] = {
			in: content,
			out,
		};
	} else if (!cache.lessons.hasOwnProperty(inFilePath)) {
		cache.lessons[inFilePath] = {
			in: content,
			out: JSON.parse(fs.readFileSync(outFilePath, "utf8")),
		};
		logger.debug(`Cached '${outFilePath}'`);
	}
}

export function remarkProcessMarkdownFile(
	inFilePath: string,
	workingDirPath: string,
	outputDirPath: string
) {
	return () => (tree: Parent) => {
		const imagePathPrefix = p.posix.join(
			COURSES_ROOT_FS_PATH,
			...getSlugs(p.dirname(inFilePath))
		);

		let visited: RemarkVisitedNodes = {
			images: [],
			links: [],
		};
		visit(tree, remarkVisitor(visited));

		rewriteImagePaths(visited.images, inFilePath, imagePathPrefix);
		rewriteLinks(visited.links, inFilePath, workingDirPath, outputDirPath);
	};
}

export function rehypeProcessMarkdownFile() {
	return (tree: Parent, vFile: VFile) => {
		let visited: RehypeVisitedNodes = { headings: [] };
		visit(tree, rehypeVisitor(visited));

		generateLessonTOC(visited.headings, vFile);
	};
}

export function processOtherFiles(
	contentDirPath: string,
	outputDirPath: string
) {
	const inFilePaths = utils.fsFind(contentDirPath, {
		nodir: true,
		filter: ({ path }) => p.extname(path) !== MD_EXT,
	});
	for (const inFilePath of inFilePaths) {
		processOtherFile(inFilePath, contentDirPath, outputDirPath);
	}
}

export function processOtherFile(
	inFilePath: string,
	contentDirPath: string,
	outputDirPath: string
) {
	const slug = getCacheCourseSlug();
	const outFilePath = p.join(
		outputDirPath,
		PUBLIC_DIR,
		COURSES_ROOT_FS_PATH,
		slug,
		p.relative(contentDirPath, inFilePath)
	);
	const doWriteFile = utils.isFileAOlderThanB(outFilePath, inFilePath);
	if (doWriteFile) {
		fse.ensureDirSync(p.dirname(outFilePath));
		fs.copyFileSync(inFilePath, outFilePath);
	}
}

export function getSlugs(dirPath: string) {
	let result: string[] = [];
	while (cache.index.hasOwnProperty(dirPath)) {
		result.push(cache.index[dirPath].frontmatter.slug);
		dirPath = p.dirname(dirPath);
	}
	return result.reverse();
}

export function getMarkdownFileSlugs(slug: string, inFilePath: string) {
	return [...getSlugs(p.dirname(inFilePath)), slug];
}

export function getMarkdownFileOutPath(slugs: string[], outputDirPath: string) {
	return `${p.join(outputDirPath, OUT_COURSES_PATH, ...slugs)}${JSON_EXT}`;
}

const isImg = (node: Node): node is Image => node.type === "image";
const isLink = (node: Node): node is Link => node.type === "link";

export function remarkVisitor(visited: RemarkVisitedNodes) {
	const visitor: BuildVisitor<Parent> = (node) => {
		if (isImg(node) || isMdxImage(node)) {
			visited.images.push(node);
		} else if (isLink(node) && p.extname(node.url) === MD_EXT) {
			try {
				new URL(node.url);
			} catch {
				visited.links.push(node);
			}
		}
	};
	return visitor;
}

export function rehypeVisitor(visited: RehypeVisitedNodes) {
	return (node: Node) => {
		if (isHastHeading(node)) {
			visited.headings.push(node);
		}
	};
}

const isMdxJsxFlowElement = (node: Parent | Node): node is MdxJsxFlowElement =>
	node.type === "mdxJsxFlowElement";
const isMdxImage = (
	node: Parent | Node
): node is MdxJsxFlowElement & { name: "img" } =>
	isMdxJsxFlowElement(node) && node.name === "img";

const isMdxAttr = (
	attr: MdxJsxAttribute | MdxJsxExpressionAttribute
): attr is MdxJsxAttribute => "name" in attr;
const isMdxSrcAttr = (
	attr: MdxJsxAttribute | MdxJsxExpressionAttribute
): attr is MdxJsxAttribute & { name: "src" } =>
	isMdxAttr(attr) && attr.name === "src";

const isElement = (node: Node): node is Element => node.type === "element";

const getHastHeadingRank = (node: Element) => {
	const name = node.tagName.toLowerCase();
	const code =
		name.length === 2 && name.charCodeAt(0) === 104 /* `h` */
			? name.charCodeAt(1)
			: 0;
	return code > 48 /* `0` */ && code < 55 /* `7` */ ? code - 48 /* `0` */ : -1;
};

const isHastHeading = (node: Node): node is Heading =>
	isElement(node) && getHastHeadingRank(node) >= 0;

export function rewriteImagePaths(
	nodes: (Image | MdxJsxFlowElement)[],
	inFilePath: string,
	imagePathPrefix: string
) {
	for (let node of nodes) {
		const inDirPath = p.dirname(inFilePath);
		let checkFilePath = "";
		if (node.type === "image") {
			checkFilePath = p.join(inDirPath, node.url);
			node.url = p.posix.join(imagePathPrefix, node.url);
		} else if (isMdxImage(node)) {
			node.attributes.filter(isMdxSrcAttr).map((attr: MdxJsxAttribute) => {
				checkFilePath = p.join(inDirPath, attr.value + "");
				return {
					...attr,
					value: p.posix.join(imagePathPrefix, attr.value + ""),
				};
			});
		}

		if (checkFilePath !== "") {
			utils.checkPathExists(
				checkFilePath,
				`Couldn't find required '${checkFilePath}' for '${inFilePath}' at line ${node.position?.start.line} relative to frontmatter`
			);
		}
	}
}

export async function rewriteLinks(
	nodes: any[],
	inFilePath: string,
	workingDirPath: string,
	outputDirPath: string
) {
	const inDirPath = p.dirname(inFilePath);
	for (let node of nodes) {
		const [checkFilePath, anchor] = p.posix
			.resolve(inDirPath, node.url)
			.split("#");
		const doRewriteURL =
			utils.checkPathExists(
				checkFilePath,
				`Couldn't find required '${checkFilePath}' for '${inFilePath}' at line ${node.position.start.line} relative to frontmatter`
			) &&
			p.extname(checkFilePath) === MD_EXT &&
			p.basename(checkFilePath) !== IN_INDEX_FILE;
		if (doRewriteURL) {
			await processMarkdownFile(checkFilePath, workingDirPath, outputDirPath);
			node.url = cache.lessons[checkFilePath].out.url;
			if (anchor) {
				node.url = `${node.url}#${anchor}`;
			}
		}
	}
}

export function generateLessonTOC(nodes: any[], vFile: VFile) {
	const toc: LessonTOC[] = [];
	for (const node of nodes) {
		for (const child of node.children) {
			if (child.type === "text") {
				toc.push({
					headingType: node.tagName,
					title: child.value,
					link: `#${node.properties.id}`,
				});
			}
		}
	}
	vFile.data.toc = toc;
}

export function getCacheCourseSlug() {
	return utils.isObjectEmpty(cache.index)
		? ""
		: Object.values(cache.index)[0].frontmatter.slug;
}

export function getCacheSections(outputDirPath: string) {
	return Object.entries(cache.index)
		.slice(1)
		.map(([inDirPath, data]) => ({
			title: data.frontmatter.title,
			lessons: Object.entries(cache.lessons)
				.filter(([path]) => path.startsWith(inDirPath))
				.map(([path, lesson]) => ({
					outPath: getMarkdownFileOutPath(
						getMarkdownFileSlugs(lesson.out.slug, path),
						outputDirPath
					),
					in: lesson.in,
					out: lesson.out,
				})),
		}));
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
	}));
}

export function updateLessonsPrevNext(sections: Section[]) {
	sections.forEach((section, sectionIndex) =>
		section.lessons.forEach((lesson, lessonIndex: number) => {
			let prevLesson = section.lessons[lessonIndex - 1] || null;
			let nextLesson = section.lessons[lessonIndex + 1] || null;

			if (!prevLesson && sectionIndex > 0) {
				const prevSection = sections[sectionIndex - 1];
				prevLesson = prevSection.lessons[prevSection.lessons.length - 1];
			}

			if (!nextLesson && sectionIndex < sections.length - 1) {
				const nextSection = sections[sectionIndex + 1];
				nextLesson = nextSection.lessons[0];
			}

			lesson.out.prev = null;
			if (prevLesson) {
				lesson.out.prev = {
					title: prevLesson.out.title,
					url: prevLesson.out.url,
				};
			}

			lesson.out.next = null;
			if (nextLesson) {
				lesson.out.next = {
					title: nextLesson.out.title,
					url: nextLesson.out.url,
				};
			}
			fs.writeFileSync(lesson.outPath, jsonPrettyPrint(lesson.out));
		})
	);
}

const isExecutable = (path: string) =>
	!!(fs.statSync(path).mode & fs.constants.S_IXUSR);

export function processGodotProjects(
	workingDirPath: string,
	outputDirPath: string
) {
	indexGodotProjects(workingDirPath);
	for (const godotProjectDirPath in cache.godotProjects) {
		processGodotProject(godotProjectDirPath, outputDirPath);
	}
}

export function processGodotProject(
	godotProjectDirPath: string,
	outputDirPath: string
) {
	getGodotPathOrDie() // will throw if not found
	const slug = getCacheCourseSlug();
	const outDirPath = p.join(
		outputDirPath,
		PUBLIC_DIR,
		COURSES_ROOT_FS_PATH,
		slug,
		`${p.basename(godotProjectDirPath)}${ZIP_EXT}`
	);
	const godotProjectFilePaths = utils.fsFind(godotProjectDirPath, {
		nodir: true,
		filter: ({ path }) => !GODOT_IGNORED.some((dir) => path.includes(dir)),
	});

	if (godotProjectFilePaths.length > 0) {
		const godotPracticeBuildPath = p.join(
			godotProjectDirPath,
			...GODOT_PRACTICE_BUILD
		);
		if (fs.existsSync(godotPracticeBuildPath)) {
			logger.debug(
				spawnGodot4(godotProjectDirPath, "--script", godotPracticeBuildPath)
			);
		}

		const zip = new AdmZip();
		for (const godotProjectFilePath of godotProjectFilePaths) {
			const zipDirPath = p.relative(
				godotProjectDirPath,
				p.dirname(godotProjectFilePath)
			);
			zip.addLocalFile(godotProjectFilePath, zipDirPath);
		}
		fse.ensureDirSync(p.dirname(outDirPath));
		zip.writeZip(outDirPath);
	}
}

export function extractTextBetweenAnchors(content: string, anchorName: string) {
	const anchorPattern = new RegExp(
		`(?:#|\\/\\/)\\s*ANCHOR:\\s*\\b${anchorName}\\b\\s*\\r?\\n(.*?)\\s*(?:#|\\/\\/)\\s*END:\\s*\\b${anchorName}\\b`,
		"gms"
	);
	const match = anchorPattern.exec(content);
	if (match !== null && !match[1]) {
		throw Error(`No matching '${anchorName}' anchor found`);
	}
	return (match ?? [""])[1];
}

export async function getSerialized(
	vFile: VFile,
	frontmatter: Record<string, any>,
	remarkPlugins: PluggableList = [],
	rehypePlugins: PluggableList = []
) {
	return await serialize(vFile, {
		mdxOptions: {
			development: process.env.NODE_ENV !== PRODUCTION,
			remarkPlugins: [remarkGfm, remarkUnwrapImages, ...remarkPlugins],
			rehypePlugins: [
				rehypeSlug,
				rehypeCodeTitles,
				//@ts-ignore
				rehypePrism,
				[
					rehypeAutolinkHeadings,
					{ properties: { className: ["header-link"] } },
				],
				...rehypePlugins,
			],
		},
		scope: frontmatter,
	});
}

export function getMatter(source: string, inFilePath: string) {
	source = source.replace(HTML_COMMENT_REGEX, "");
	source = addCodeBlocksFilename(source).replace(
		GDSCRIPT_CODEBLOCK_REGEX,
		"$1$3"
	);
	source = replaceIncludes(source, inFilePath);
	return matter(source);
}
