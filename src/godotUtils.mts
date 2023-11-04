import { homedir } from "node:os";
import { whichTrySync } from "@kinda-ok/convenient-node/dist/which.mjs";
import {
	flatpakExistsSync,
	getFlatpackRunCommand,
} from "@kinda-ok/convenient-node/dist/flatpakExists.mjs";

export const getGodotPath = (...additional: (string | undefined)[]) => {
	const binary = whichTrySync([
		...additional,
		`godot`,
		`/usr/bin/godot`,
		`/usr/local/bin/godot`,
		`${homedir()}/bin/godot`,
		`${homedir()}/.bin/godot`,
		`${homedir()}/.local/share/hourglass/versions/4.1/godot`,
	]);
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
