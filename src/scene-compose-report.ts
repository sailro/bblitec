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
 * It needs `scene -- capture <id>` to have run, because the browser's
 * fragments are what it compares against. With no capture it composes anyway
 * and reports the variant set, which is still the useful half when sizing a
 * scene.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

/** The browser's PBR fragments, by capture file name. */
function capturedFragments(scene: string): Map<string, string> {
    const directory = join("artifacts", "capture", scene, "shaders");
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

export async function runComposeReport(
    idOrSource: string,
    scenes: readonly { id: string }[],
    resolve: (idOrSource: string) => { id: string },
): Promise<void> {
    const selected = idOrSource === "all"
        ? scenes
        : [resolve(idOrSource)];
    let anyGap = false;
    for (const scene of selected) {
        const gap = await reportScene(scene.id);
        anyGap ||= gap;
    }
    if (anyGap) {
        process.exitCode = 1;
    }
}

async function reportScene(scene: string): Promise<boolean> {
    const document = sceneGlbDocument(scene);
    const materials = Array.isArray(document?.["materials"])
        ? (document["materials"] as JsonObject[])
        : [];
    if (materials.length === 0) {
        console.log(`${scene}: no glTF materials.`);
        return false;
    }
    const captured = capturedFragments(scene);
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
                : "no capture — run `scene -- capture` to compare"),
    );
    let matched = 0;
    let gaps = 0;
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
            const mine = variant.fragmentWgsl.split("\n");
            let reach = 0;
            for (const [, text] of captured) {
                const theirs = text.split("\n");
                let line = 0;
                while (
                    line < mine.length &&
                    line < theirs.length &&
                    mine[line] === theirs[line]
                ) {
                    line++;
                }
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
            console.log(
                `  ok   ${JSON.stringify(name)} [${key}] == ${hit.file}` +
                    `  (${hit.label})`,
            );
            continue;
        }
        if (captured.size === 0) {
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
        const mine = composed.split("\n");
        for (const [file, text] of captured) {
            const theirs = text.split("\n");
            let line = 0;
            while (
                line < mine.length &&
                line < theirs.length &&
                mine[line] === theirs[line]
            ) {
                line++;
            }
            if (line > best.lines) {
                best = {
                    lines: line,
                    file,
                    mine: mine.slice(line, line + 2),
                    theirs: theirs.slice(line, line + 2),
                };
            }
        }
        console.log(
            `       closest ${best.file}, diverges at line ${best.lines + 1}:`,
        );
        console.log(`         ours   ${JSON.stringify(best.mine)}`);
        console.log(`         theirs ${JSON.stringify(best.theirs)}`);
    }
    if (captured.size > 0) {
        console.log(
            `  ${matched}/${materials.length} compose byte-identically to ` +
                "the browser's own fragment",
        );
    }
    return gaps > 0;
}
