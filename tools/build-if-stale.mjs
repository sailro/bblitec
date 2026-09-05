// Reuse dist only when compiler inputs match and every recorded output exists.
// Stamp inputs before compiling; publish the output inventory only on success.
// clean-dist refuses rebuilding underneath a live scene-command process.
// Plain JavaScript because this wrapper runs before TypeScript compilation.
import { createHash } from "node:crypto";
import {
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
 * over src/, test/, tsconfig.json, package.json and package-lock.json,
 * prefixed with a
 * format version and both TypeScript versions. The Go compiler emits
 * this project while the legacy JavaScript package remains the runtime
 * compiler API used by bblitec itself. An `npm install` can move either
 * dependency without a source edit. Returns undefined when anything
 * cannot be statted, which the caller treats as "rebuild".
 */
function computeStamp() {
    const files = [];
    for (const directory of ["src", "test"]) {
        listFiles(join(root, directory), directory, files);
    }
    for (const single of [
        "tsconfig.json",
        "package.json",
        "package-lock.json",
    ]) {
        files.push({ path: join(root, single), relative: single });
    }
    let nativeCompilerVersion;
    let compilerApiVersion;
    try {
        nativeCompilerVersion = JSON.parse(
            readFileSync(
                join(
                    root,
                    "node_modules",
                    "@typescript",
                    "native",
                    "package.json",
                ),
                "utf8",
            ),
        ).version;
        compilerApiVersion = JSON.parse(
            readFileSync(
                join(root, "node_modules", "typescript", "package.json"),
                "utf8",
            ),
        ).version;
    } catch {
        return undefined;
    }
    const lines = [
        `v2 native=${nativeCompilerVersion} api=${compilerApiVersion}`,
    ];
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

function canReuse(stamp) {
    if (stamp === undefined) return false;
    try {
        const recorded = JSON.parse(readFileSync(stampPath, "utf8"));
        return recorded.version === 1 && recorded.input === stamp &&
            Array.isArray(recorded.outputs) && recorded.outputs.length > 0 &&
            recorded.outputs.every((relative) =>
                typeof relative === "string" && relative !== "" &&
                statSync(join(root, "dist", relative)).isFile());
    } catch {
        return false;
    }
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
if (canReuse(stamp)) {
    console.log("build: dist is up to date (skipped clean + tsc).");
    process.exit(0);
}

run(join(root, "tools", "clean-dist.mjs"), []);
run(
    join(
        root,
        "node_modules",
        "@typescript",
        "native",
        "bin",
        "tsc",
    ),
    ["-p", join(root, "tsconfig.json")],
);
if (stamp !== undefined) {
    mkdirSync(join(root, "dist"), { recursive: true });
    const outputs = listFiles(join(root, "dist"), "", [])
        .map(({ relative }) => relative).sort();
    writeFileSync(stampPath, JSON.stringify({ version: 1, input: stamp, outputs }) + "\n");
}
