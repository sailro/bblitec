import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { compiledShaderArtifactExtensions } from "./generated-tree.js";

export interface ValidationSceneInput {
    id: string;
    output: string;
    source: string;
    title: string;
}

interface CompletedStage {
    input: string;
    output: string;
}

export interface ValidationCheckpoint {
    compile?: CompletedStage;
    shaders?: CompletedStage;
    version: 1;
}

function filesUnder(path: string): string[] {
    if (!existsSync(path)) return [];
    const stat = statSync(path);
    if (stat.isFile()) return [path];
    const files: string[] = [];
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = resolve(path, entry.name);
        if (entry.isDirectory()) files.push(...filesUnder(child));
        else if (entry.isFile()) files.push(child);
    }
    return files;
}

function hashEntries(entries: readonly string[]): string {
    return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function contentFingerprint(paths: readonly string[]): string {
    const entries: string[] = [];
    const roots = [...new Set(paths.map((path) => resolve(path)))].sort();
    for (const root of roots) {
        if (!existsSync(root)) {
            entries.push(`${root}\tmissing`);
            continue;
        }
        for (const file of filesUnder(root).sort()) {
            entries.push(
                `${file}\t${createHash("sha256")
                    .update(readFileSync(file))
                    .digest("hex")}`,
            );
        }
    }
    return hashEntries(entries);
}

function metadataFingerprint(
    roots: readonly string[],
    include: (relativePath: string) => boolean,
): string {
    const entries: string[] = [];
    const uniqueRoots = [
        ...new Set(roots.map((path) => resolve(path))),
    ].sort();
    for (const root of uniqueRoots) {
        if (!existsSync(root)) {
            entries.push(`${root}\tmissing`);
            continue;
        }
        for (const file of filesUnder(root).sort()) {
            const path = relative(root, file).replaceAll("\\", "/");
            if (!include(path)) continue;
            const stat = statSync(file);
            entries.push(`${root}/${path}\t${stat.size}\t${stat.mtimeMs}`);
        }
    }
    return hashEntries(entries);
}

function isCompiledShaderOutput(path: string): boolean {
    return (
        compiledShaderArtifactExtensions.some((extension) =>
            path.endsWith(extension),
        ) ||
        path === "shader-compiler.json" ||
        path.endsWith("/shader-compiler.json")
    );
}

/** Inputs whose bytes determine generated scene output. */
export function validationCompileInput(
    scenes: readonly ValidationSceneInput[],
    browserPath: string,
    repositoryRoot = process.cwd(),
): string {
    const sourceDirectories = scenes.map((scene) =>
        dirname(resolve(scene.source)),
    );
    const browser = statSync(browserPath);
    const content = contentFingerprint([
        resolve(repositoryRoot, "dist", ".build-stamp"),
        resolve(repositoryRoot, "package-lock.json"),
        resolve(repositoryRoot, "upstream"),
        ...sourceDirectories,
    ]);
    return hashEntries([
        content,
        `${resolve(browserPath)}\t${browser.size}\t${browser.mtimeMs}`,
        ...scenes.map((scene) =>
            JSON.stringify({
                id: scene.id,
                output: resolve(scene.output),
                source: resolve(scene.source),
                title: scene.title,
            }),
        ),
        `CHROME_PATH=${process.env.CHROME_PATH ?? ""}`,
        `BBLITE_BAKE_CACHE=${process.env.BBLITE_BAKE_CACHE ?? ""}`,
    ]);
}

/** Generated files owned by compilation, excluding shader-derived outputs. */
export function validationCompileOutput(
    scenes: readonly ValidationSceneInput[],
): string {
    return metadataFingerprint(
        scenes.map((scene) => scene.output),
        (path) => !isCompiledShaderOutput(path),
    );
}

function toolIdentity(path: string | undefined): string {
    if (!path || !existsSync(path)) return "missing";
    const stat = statSync(path);
    return `${resolve(path)}\t${stat.size}\t${stat.mtimeMs}`;
}

export function validationShaderInput(
    compileOutput: string,
    target: string,
    tools: { dxc: string | undefined; tint: string | undefined },
    repositoryRoot = process.cwd(),
): string {
    return hashEntries([
        compileOutput,
        target,
        toolIdentity(tools.dxc),
        toolIdentity(tools.tint),
        contentFingerprint([
            resolve(repositoryRoot, "tools", "compile-shaders.ps1"),
        ]),
    ]);
}

/** Target compiler products, excluding the WGSL sources from generation. */
export function validationShaderOutput(
    scenes: readonly ValidationSceneInput[],
): string {
    return metadataFingerprint(
        scenes.map((scene) => resolve(scene.output, "upstream", "shaders")),
        isCompiledShaderOutput,
    );
}

export function readValidationCheckpoint(
    path: string,
): ValidationCheckpoint {
    if (!existsSync(path)) return { version: 1 };
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as Partial<
            ValidationCheckpoint
        >;
        return value.version === 1
            ? (value as ValidationCheckpoint)
            : { version: 1 };
    } catch {
        return { version: 1 };
    }
}

export function writeValidationCheckpoint(
    path: string,
    checkpoint: ValidationCheckpoint,
): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`);
    renameSync(temporary, path);
}
