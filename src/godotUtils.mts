import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { whichTrySync } from "@kinda-ok/convenient-node/dist/which.mjs";
import {
	flatpakExistsSync,
	getFlatpackRunCommand,
} from "@kinda-ok/convenient-node/dist/flatpakExists.mjs";

const defaultPaths = [
	`godot`,
	`/usr/bin/godot`,
	`/usr/local/bin/godot`,
	`${homedir()}/bin/godot`,
	`${homedir()}/.bin/godot`,
	`${homedir()}/.local/share/hourglass/versions/4.1/godot`,
];

export const getGodotPath = (...additional: (string | undefined)[]) => {
	const binary = whichTrySync([...additional, ...defaultPaths]);
	if (binary) {
		return binary;
	}
	if (flatpakExistsSync(`org.godotengine.Godot`)) {
		return getFlatpackRunCommand(`org.godotengine.Godot`, [
			`--branch=stable`,
			`--arch=x86_64`,
			`--command=godot`,
			`--file-forwarding`,
		]);
	}
	return undefined;
};

class GodotNotFoundError extends Error {
	code = "ENOENT";
	constructor(paths: (string|undefined)[]) {
		const message = `Godot was not found in:\n - ${paths.join('\n - ')}\nDid you try setting GODOT_PATH?`;
		super(message);
		this.name = "GodotNotFoundError";
	}
}

export const getGodotPathOrDie = (...additional: (string | undefined)[]) => {
	const path = getGodotPath(process.env.GODOT_PATH, ...additional);
	if (typeof path === "undefined") {
		throw new GodotNotFoundError([process.env.GODOT_PATH, ...additional, ...defaultPaths]);
	}
	return path;
};

export const spawnGodot4 = (godotProjectDirPath: string, ...args: string[]) =>
	spawnSync(
		getGodotPathOrDie(),
		["--path", godotProjectDirPath, "--headless", ...args],
		{ encoding: "utf-8" }
	);
