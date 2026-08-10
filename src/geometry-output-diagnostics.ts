import {
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
    captureSuiteReference,
    type SuiteSourceTransform,
} from "./capture-suite-reference.js";
import {
    defaultExecutable,
    runNative,
} from "./parity-scene.js";
import {
    compareImages,
    generateDiffMap,
} from "./parity.js";
import { resolveScene } from "./scene-registry.js";

interface GeometryDiagnosticResult {
    task: string;
    reference: string;
    actual: string;
    diff: string;
    mad: number;
    maxDiff: number;
}

const copyTaskPattern =
    /    addTask\(scene, createCopyToTextureTask\(\{[\s\S]*?    \}, engine, scene\)\);\r?\n/g;

function geometryCopyTasks(source: string): string[] {
    const result: string[] = [];
    for (const match of source.matchAll(copyTaskPattern)) {
        const name = match[0].match(/name:\s*"([^"]+-impostor-[^"]+)"/)?.[1];
        if (name) result.push(name);
    }
    return result;
}

function fullScreenCopyTransform(selected: string): SuiteSourceTransform {
    return (source) => source.replace(
        copyTaskPattern,
        (block) => {
            const name = block.match(/name:\s*"([^"]+)"/)?.[1];
            if (!name?.includes("-impostor-")) return block;
            if (name !== selected) return "";
            return block.replace(
                /viewport:\s*\{[^}]+\}/,
                "viewport: { x: 0, y: 0, width: 1, height: 1 }",
            );
        },
    );
}

function taskSlug(task: string): string {
    return task.slice(task.indexOf("-impostor-") + "-impostor-".length);
}

export async function runGeometryOutputDiagnostics(
    idOrSource: string,
    recaptureReference: boolean,
): Promise<void> {
    const scene = resolveScene(idOrSource);
    const source = readFileSync(resolve(scene.source), "utf8");
    const tasks = geometryCopyTasks(source);
    if (tasks.length === 0) {
        throw new Error(
            `Scene '${scene.id}' has no geometry-output copy tasks.`,
        );
    }
    const outputDirectory = resolve(
        "artifacts",
        "parity",
        scene.id,
        "geometry",
    );
    mkdirSync(outputDirectory, { recursive: true });
    const results: GeometryDiagnosticResult[] = [];
    for (const task of tasks) {
        const slug = taskSlug(task);
        const reference = resolve(
            outputDirectory,
            `${slug}-lite.png`,
        );
        const actual = resolve(
            outputDirectory,
            `${slug}-native.png`,
        );
        const diff = resolve(
            outputDirectory,
            `${slug}-diff.png`,
        );
        await captureSuiteReference(
            scene.source,
            reference,
            recaptureReference,
            fullScreenCopyTransform(task),
        );
        runNative(
            defaultExecutable(scene.buildDirectory),
            actual,
            true,
            { BBLITE_COPY_TASK: task },
        );
        const comparison = compareImages(actual, reference);
        generateDiffMap(actual, reference, diff);
        results.push({
            task,
            reference,
            actual,
            diff,
            mad: comparison.mad,
            maxDiff: comparison.maxDiff,
        });
        console.log(
            `${scene.id} ${slug}: MAD=${comparison.mad.toFixed(3)}, ` +
                `max=${comparison.maxDiff}`,
        );
    }
    const report = resolve(outputDirectory, "report.json");
    writeFileSync(
        report,
        `${JSON.stringify({ scene: scene.id, results }, null, 2)}\n`,
    );
    console.log(`Report: ${report}`);
}
