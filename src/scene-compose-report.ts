/**
 * `scene -- compose <id>`: every material a scene loads, composed through
 * Babylon Lite's own pipeline and compared against the fragments the
 * instrumented browser capture recorded.
 *
 * This is the measurement that answers "is our feature derivation right", and
 * it answers it the only way that means anything: not by inspecting bits, but
 * by composing the whole fragment and checking it is byte-for-byte the one the
 * browser compiled. A mismatch prints the first differing line, which names
 * the arm — a missing `txfUV`, an `occlusion=orm.r` where the reference has
 * `occlusion=1.0`, a `vColor` varying nothing asked for.
 *
 * The browser's fragments are what it compares against, so the capture is
 * evidence and gets the staleness discipline `diff` applies before trusting
 * one: a capture from an older scene source, pose or pinned package is
 * recaptured (single scene) or excluded loudly (`all` — a sizing sweep is
 * not the place to launch a browser per scene). A single-scene run with no
 * capture at all captures one itself through the same entry point `scene --
 * capture` uses. With no capture (the `all` survey) it composes anyway and
 * reports the variant set, which is still the useful half when sizing a
 * scene.
 *
 * Beside the console output, a single-scene run writes a provenance-carrying
 * `compose-report.json` into the capture directory — the one sibling report
 * this tool never wrote.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import {
    captureShadersDirectory,
    defaultCaptureDirectory,
    writeReport,
} from "./parity-scene.js";
import {
    browserCaptureStaleness,
    runInstrumentedCapture,
} from "./capture-instrumented.js";
import type { SceneDefinition } from "./scene-registry.js";
import { divergence } from "./render-diff.js";
import {
    asObject,
    glbDocument,
    type JsonObject,
} from "./gltf-document.js";
import {
    gltfLinearImageProcessing,
    materialSubjects,
} from "./pinned-material-arms.js";
import { composePinnedPbrVariant } from "./pinned-pbr-variants.js";
import {
    pinnedSceneArms,
    pinnedSingleLightTypes,
    type PinnedSceneArm,
} from "./pinned-scene-arms.js";

/** The browser's PBR fragments, by capture file name. `--capture <dir>`
 *  reads a capture written somewhere other than
 *  `artifacts/capture/<scene>`. */
function capturedFragments(
    captureDirectory: string,
): Map<string, string> {
    const directory = captureShadersDirectory(captureDirectory);
    const fragments = new Map<string, string>();
    if (!existsSync(directory)) return fragments;
    for (const name of readdirSync(directory)) {
        const text = readFileSync(join(directory, name), "utf8");
        // The PBR ones: a fragment entry point that shades a base F0.
        if (!/@fragment/.test(text) || !/colorF0/.test(text)) continue;
        fragments.set(name, text);
    }
    return fragments;
}

/** The scene's materialized .glb, through the shared tolerant reader. */
function sceneGlbDocument(scene: string): JsonObject | undefined {
    const directory = join("generated", scene, "assets");
    if (!existsSync(directory)) return undefined;
    const glb = readdirSync(directory).find((name) => /\.glb$/i.test(name));
    if (!glb) return undefined;
    return glbDocument(join(directory, glb));
}

/** Whether the scene declares any glTF material — what decides if a
 *  capture is worth taking for it. */
function sceneHasGltfMaterials(scene: string): boolean {
    const document = sceneGlbDocument(scene);
    const materials = document?.["materials"];
    return Array.isArray(materials) && materials.length > 0;
}

const normalize = (text: string): string =>
    text.replace(/\s+/g, " ").trim();

/**
 * The scene-shaped half of the composer's input, as candidates rather than a
 * derivation.
 *
 * The light mode and the tone mapping are properties of the *scene*, not of
 * its asset, and guessing them from the asset is wrong in both directions:
 * Scene 39's glTF declares two `KHR_lights_punctual` lights and none of its
 * captured fragments composes a light path at all, and Scene 21 disables tone
 * mapping in scene code after `loadEnvironment` enabled it. So each
 * combination is composed and the one that reproduces the capture is
 * reported — which makes the tool *measure* the scene's light mode instead of
 * assuming it.
 *
 * The arms themselves come from `pinned-scene-arms.ts`, the same builder
 * generation composes its variant table from. Sweeping a different set than the
 * one emitted would make a byte-identical match here prove nothing about the
 * shaders in the generated tree.
 */
function sceneCandidates(): Promise<readonly PinnedSceneArm[]> {
    return pinnedSceneArms({
        lightKinds: pinnedSingleLightTypes,
        multiLight: true,
        noLight: true,
        toneMapping: [false, true],
        environment: true,
        fog: false,
    });
}

interface ComposeOptions {
    /** Read (and, single-scene, recapture into) this directory instead
     *  of `artifacts/capture/<id>`. */
    captureDirectory?: string;
    /** Pose override for the staleness check and any auto-capture —
     *  what `scene -- diagnose --seek` rides in on, so compose does not
     *  fight `diff` over which pose the shared capture holds. */
    seekSeconds?: number;
}

interface ComposeOutcome {
    matched: number;
    gaps: number;
}

export async function runComposeReport(
    idOrSource: string,
    scenes: readonly SceneDefinition[],
    resolve: (idOrSource: string) => SceneDefinition,
    options: ComposeOptions = {},
): Promise<ComposeOutcome> {
    const all = idOrSource === "all";
    const selected = all ? scenes : [resolve(idOrSource)];
    const outcome: ComposeOutcome = { matched: 0, gaps: 0 };
    for (const scene of selected) {
        const captureDirectory = resolvePath(
            options.captureDirectory ??
                defaultCaptureDirectory(scene.id),
        );
        const wantSeek =
            options.seekSeconds ??
            scene.parity?.referenceTimeSeconds ??
            null;
        let staleness = browserCaptureStaleness(
            scene,
            captureDirectory,
            { requireSeek: wantSeek },
        );
        // A scene with no glTF materials has nothing to compare a capture
        // against — capturing one for it would spend a browser launch on
        // a report that ends at "no glTF materials".
        const comparable = sceneHasGltfMaterials(scene.id);
        if (staleness !== undefined && !all && comparable) {
            // The diagnosis rung earns fresh evidence itself, through
            // the same entry point `scene -- capture` runs.
            if (staleness !== "missing") {
                console.log(
                    `${scene.id}: capture ${staleness}; recapturing.`,
                );
            } else {
                console.log(`${scene.id}: no capture; capturing.`);
            }
            await runInstrumentedCapture(idOrSource, {
                ...(options.seekSeconds !== undefined
                    ? { seekSeconds: options.seekSeconds }
                    : {}),
                outputDirectory: captureDirectory,
            });
            staleness = undefined;
        } else if (staleness !== undefined && staleness !== "missing") {
            // The survey sweep must not silently grade against stale
            // evidence — the capture is excluded and says why.
            console.log(
                `${scene.id}: capture ${staleness} — excluded; ` +
                    `recapture with 'scene -- capture ${scene.id}'.`,
            );
        }
        // "missing" is not exclusion: with no capture directory the
        // fragment read comes back empty on its own and the header says
        // "no capture", exactly as it always has.
        const result = await reportScene(
            scene.id,
            captureDirectory,
            staleness !== undefined && staleness !== "missing",
        );
        outcome.matched += result.matched;
        outcome.gaps += result.gaps;
        // The report artifact rides the single-scene diagnosis; the
        // survey sweep would scatter report files into capture
        // directories that do not exist.
        if (!all) {
            const reportPath = join(
                captureDirectory,
                "compose-report.json",
            );
            if (existsSync(captureDirectory)) {
                writeReport(
                    reportPath,
                    {
                        tool: "compose",
                        generatedDirectory: resolvePath(scene.output),
                    },
                    {
                        scene: scene.id,
                        materials: result.materials,
                        matched: result.matched,
                        gaps: result.gaps,
                        capturedFragments: result.capturedFragments,
                        subjects: result.subjects,
                    },
                );
                console.log(`Report: ${reportPath}`);
            }
        }
    }
    if (outcome.gaps > 0) {
        process.exitCode = 1;
    }
    return outcome;
}

/** One material's verdict, as the console prints it and the report
 *  records it. */
interface ComposeSubjectRow {
    name: string;
    /** The composed variant key of the nearest candidate. */
    key: string;
    status: "ok" | "gap" | "uncompared";
    /** The capture file the composition matched byte-for-byte. */
    matchedFile?: string;
    matchedLabel?: string;
    /** For a gap: the closest capture and the 1-based line where it
     *  stops agreeing — the line that names the arm. */
    divergence?: {
        closest: string;
        line: number;
        ours: string[];
        theirs: string[];
    };
}

async function reportScene(
    scene: string,
    captureDirectory: string,
    captureExcluded: boolean,
): Promise<{
    materials: number;
    matched: number;
    gaps: number;
    capturedFragments: number;
    subjects: ComposeSubjectRow[];
}> {
    const document = sceneGlbDocument(scene);
    const materials = Array.isArray(document?.["materials"])
        ? (document["materials"] as JsonObject[])
        : [];
    const empty = {
        materials: materials.length,
        matched: 0,
        gaps: 0,
        capturedFragments: 0,
        subjects: [] as ComposeSubjectRow[],
    };
    if (materials.length === 0) {
        console.log(`${scene}: no glTF materials.`);
        return empty;
    }
    const captured = captureExcluded
        ? new Map<string, string>()
        : capturedFragments(captureDirectory);
    const candidates = await sceneCandidates();
    // The subjects are generation's own construction — the animated-pointer
    // scans, the loader flags, the first-primitive mesh features — consumed
    // rather than duplicated, so this gate cannot drift from what generation
    // composes. The linear flag is its asset-side derivation: a scene renders
    // linear when any material transmits, because `set-transmission.ts`
    // retargets the frame graph's colour buffer — and the refraction fragment
    // composes its own image-processing arm then. The appended
    // default-material subject is generation's concern; the capture
    // comparison covers the declared materials, as it always has.
    const subjects = (
        await materialSubjects(document as JsonObject, {
            linearImageProcessing:
                gltfLinearImageProcessing(document as JsonObject),
        })
    ).filter((subject) => subject.index < materials.length);

    console.log(
        `${scene}: ${materials.length} material(s), ` +
            (captured.size > 0
                ? `${captured.size} captured PBR fragment(s)`
                : captureExcluded
                  ? "capture excluded as stale — composing uncompared"
                  : "no capture — run `scene -- capture` to compare"),
    );
    let matched = 0;
    let gaps = 0;
    const subjectRows: ComposeSubjectRow[] = [];
    for (const { index, name, input, uv2Mask, meshFeatures } of subjects) {
        const material = materials[index]!;

        let hit: { file: string; label: string } | undefined;
        let composed = "";
        let key = "";
        let closest = -1;
        for (const candidate of candidates) {
            const variant = await composePinnedPbrVariant(input, {
                ...candidate.options,
                meshFeatures,
                uv2Mask,
            });
            const body = normalize(variant.fragmentWgsl);
            // Keep the candidate that agrees with some capture for longest, not
            // the first one composed: the reported divergence line is only a
            // finding if it belongs to the nearest variant.
            let reach = 0;
            for (const [, text] of captured) {
                const { line } = divergence(variant.fragmentWgsl, text);
                if (line > reach) reach = line;
            }
            if (reach > closest) {
                closest = reach;
                composed = variant.fragmentWgsl;
                key = `${variant.fragmentKey} (${candidate.label})`;
            }
            for (const [file, text] of captured) {
                if (normalize(text) === body) {
                    hit = { file, label: candidate.label };
                    break;
                }
            }
            if (hit) break;
        }

        if (hit) {
            matched++;
            subjectRows.push({
                name,
                key,
                status: "ok",
                matchedFile: hit.file,
                matchedLabel: hit.label,
            });
            console.log(
                `  ok   ${JSON.stringify(name)} [${key}] == ${hit.file}` +
                    `  (${hit.label})`,
            );
            continue;
        }
        if (captured.size === 0) {
            subjectRows.push({ name, key, status: "uncompared" });
            console.log(`  --   ${JSON.stringify(name)} [${key}]`);
            continue;
        }
        // A material with no glTF extensions whose capture disagrees is the
        // one case this tool cannot answer: the scene built it, not the
        // asset. Scene 21's cloth is exactly that — `setPbrSheen` in scene
        // code, and its captured fragment carries `sheenParams` nothing in
        // the glTF explains. Say so rather than reporting a bare gap.
        const declaresExtensions =
            Object.keys(asObject(material["extensions"]) ?? {}).length > 0;
        if (!declaresExtensions) {
            console.log(
                `  ?    ${JSON.stringify(name)} [${key}] ` +
                    "declares no glTF extensions — if its captured fragment " +
                    "carries a layer, the scene built the material with a " +
                    "`setPbr*` call and this tool reads only the asset",
            );
        }
        gaps++;
        console.log(
            `  GAP  ${JSON.stringify(name)} [${key}] ` +
                `matches no captured fragment`,
        );
        // The closest capture by longest common prefix, and the line where it
        // stops agreeing. That line is the finding: it names the arm.
        let best = { lines: -1, file: "", mine: [""], theirs: [""] };
        for (const [file, text] of captured) {
            const { line, mineContext, theirsContext } = divergence(
                composed,
                text,
            );
            if (line > best.lines) {
                best = {
                    lines: line,
                    file,
                    mine: mineContext,
                    theirs: theirsContext,
                };
            }
        }
        console.log(
            `       closest ${best.file}, diverges at line ${best.lines + 1}:`,
        );
        console.log(`         ours   ${JSON.stringify(best.mine)}`);
        console.log(`         theirs ${JSON.stringify(best.theirs)}`);
        subjectRows.push({
            name,
            key,
            status: "gap",
            divergence: {
                closest: best.file,
                line: best.lines + 1,
                ours: best.mine,
                theirs: best.theirs,
            },
        });
    }
    if (captured.size > 0) {
        console.log(
            `  ${matched}/${materials.length} compose byte-identically to ` +
                "the browser's own fragment",
        );
    }
    return {
        ...empty,
        matched,
        gaps,
        capturedFragments: captured.size,
        subjects: subjectRows,
    };
}
