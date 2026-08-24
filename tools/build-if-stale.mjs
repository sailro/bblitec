// `npm run build`, with the up-to-date check tsc cannot provide.
//
// `build` used to be `clean:dist && tsc` unconditionally, so every
// `npm run scene -- ...` paid a clean 3.9 s compile — and the canonical
// validation sequence paid it four times — for sources that had not
// moved (`--incremental` alone is useless because the clean deletes the
// buildinfo). This script stamps the compiler's inputs into
// `dist/.build-stamp` and SKIPS the clean+tsc when the stamp matches;
// anything else — a missing stamp, an unreadable one, a changed file, a
// new file, a deleted file, a different TypeScript version — rebuilds
// exactly the way `build` always has and then writes the stamp. Every
// uncertain case falls through to the rebuild, so the failure mode is
// "rebuild more", never "run stale dist". `npm run clean:dist` still
// deletes dist (stamp included), which forces the next build cold.
//
// The stamp is computed BEFORE compiling and written only after tsc
// succeeds: a file edited mid-compile then differs from the stamp and
// the next run rebuilds, which is the correct direction.
//
// The dist-lock interplay is untouched: the rebuild path runs
// `tools/clean-dist.mjs`, which still refuses to delete `dist/` under a
// live `scene-command` run; the skip path touches nothing.
//
// Plain JavaScript on purpose: it runs before tsc, so it cannot import
// anything out of `dist/`.
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const stampPath = join(root, "dist", ".build-stamp");

/** Every file under `directory`, as sorted repo-relative forward-slash
 *  paths. All files, not just `.ts`: a stray input rebuilding more is
 *  cheap, a missed input running stale dist is not. */
function listFiles(directory, prefix, out) {
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        const path = join(directory, entry.name);
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            listFiles(path, relative, out);
        } else {
            out.push({ path, relative });
        }
    }
    return out;
}

/**
 * The compiler-input stamp: one line per file (`path\tsize\tmtimeMs`)
 * over src/, test/, tsconfig.json and package.json, prefixed with a
 * format version and the TypeScript compiler's own version — an
 * `npm install` that moves tsc changes the emitted JavaScript with no
 * source edit at all. Returns undefined when anything cannot be
 * statted, which the caller treats as "rebuild".
 */
function computeStamp() {
    const files = [];
    for (const directory of ["src", "test"]) {
        listFiles(join(root, directory), directory, files);
    }
    for (const single of ["tsconfig.json", "package.json"]) {
        files.push({ path: join(root, single), relative: single });
    }
    let typescriptVersion;
    try {
        typescriptVersion = JSON.parse(
            readFileSync(
                join(root, "node_modules", "typescript", "package.json"),
                "utf8",
            ),
        ).version;
    } catch {
        return undefined;
    }
    const lines = [`v1 typescript=${typescriptVersion}`];
    files.sort((left, right) =>
        left.relative < right.relative ? -1 : 1,
    );
    for (const file of files) {
        let stats;
        try {
            stats = statSync(file.path);
        } catch {
            return undefined;
        }
        lines.push(`${file.relative}\t${stats.size}\t${stats.mtimeMs}`);
    }
    return createHash("sha256")
        .update(lines.join("\n"))
        .digest("hex");
}

function run(scriptOrBin, args) {
    const result = spawnSync(process.execPath, [scriptOrBin, ...args], {
        stdio: "inherit",
        cwd: root,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}

const stamp = computeStamp();
if (
    stamp !== undefined &&
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8").trim() === stamp
) {
    console.log("build: dist is up to date (skipped clean + tsc).");
    process.exit(0);
}

run(join(root, "tools", "clean-dist.mjs"), []);
run(join(root, "node_modules", "typescript", "bin", "tsc"), [
    "-p",
    join(root, "tsconfig.json"),
]);
if (stamp !== undefined) {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(stampPath, `${stamp}\n`);
}
