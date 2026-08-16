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
    gltfAnimatedExtensionTargets,
    gltfAnimatedMaterialPointers,
    gltfImageResolver,
    pinnedMaterialInputFromGltf,
} from "./pinned-material-input.js";
import {
    composePinnedPbrVariant,
    type PinnedComposeOptions,
} from "./pinned-pbr-variants.js";
import { importPinnedModule } from "./pinned-shader-composer.js";
import {
    pinnedMeshFeaturesFromPrimitive,
    skinnedMeshIndices,
} from "./pinned-mesh-features.js";

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined;

const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" ? value : undefined;

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

function glbDocument(scene: string): JsonObject | undefined {
    const directory = join("generated", scene, "assets");
    if (!existsSync(directory)) return undefined;
    const glb = readdirSync(directory).find((name) => /\.glb$/i.test(name));
    if (!glb) return undefined;
    const bytes = readFileSync(join(directory, glb));
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) {
        return undefined;
    }
    const length = bytes.readUInt32LE(12);
    return JSON.parse(
        bytes.subarray(20, 20 + length).toString("utf8"),
    ) as JsonObject;
}

const normalize = (text: string): string =>
    text.replace(/\s+/g, " ").trim();

/** A scene-shaped option set to try, and the name to report when it matches. */
interface SceneCandidate {
    label: string;
    options: PinnedComposeOptions;
}

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
 */
async function sceneCandidates(): Promise<readonly SceneCandidate[]> {
    const [bits, multiLight, toneMapping] = await Promise.all([
        importPinnedModule<{ PBR_HAS_ENV: number; PBR_HAS_TONEMAP: number }>(
            "material/pbr/pbr-flag-bits.js",
        ),
        importPinnedModule<{
            MULTI_LIGHT_STRUCTS: () => string;
            COMPUTE_PBR_LIGHT: string;
            getMultiLightLoop: () => string;
        }>("material/pbr/fragments/multilight-wgsl.js"),
        importPinnedModule<{
            StandardToneMapping: { helpersWGSL: string; callWGSL: string };
        }>("material/pbr/tone-mapping.js"),
    ]);
    // `pbr-renderable.ts` assembles these exactly this way when it needs the
    // multi-light path; supplying them any other way composes a different
    // fragment.
    const multi = {
        multiLightWgsl:
            multiLight.MULTI_LIGHT_STRUCTS() + multiLight.COMPUTE_PBR_LIGHT,
        multiLightLoop: multiLight.getMultiLightLoop(),
    };
    const tone = {
        toneMappingHelpers: toneMapping.StandardToneMapping.helpersWGSL,
        toneMappingCall: toneMapping.StandardToneMapping.callWGSL,
    };
    const candidates: SceneCandidate[] = [];
    for (const [toneLabel, toneFeature, toneOptions] of [
        ["", 0, {}],
        [" +tonemap", bits.PBR_HAS_TONEMAP, tone],
    ] as const) {
        for (const lightMode of [0, 2] as const) {
            candidates.push({
                label: `lights ${lightMode}${toneLabel}`,
                options: {
                    sceneFeatures: bits.PBR_HAS_ENV | toneFeature,
                    lightMode,
                    ...(lightMode === 2 ? multi : {}),
                    ...toneOptions,
                },
            });
        }
    }
    return candidates;
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
    const document = glbDocument(scene);
    const materials = Array.isArray(document?.["materials"])
        ? (document["materials"] as JsonObject[])
        : [];
    if (materials.length === 0) {
        console.log(`${scene}: no glTF materials.`);
        return false;
    }
    const captured = capturedFragments(scene);
    const record = document as JsonObject;
    const imageOf = gltfImageResolver(record);
    const animatedBaseColor = gltfAnimatedMaterialPointers(
        record,
        "pbrMetallicRoughness/baseColorFactor",
    );
    const animatedUvTransform = gltfAnimatedMaterialPointers(
        record,
        ".*/KHR_texture_transform/(?:offset|scale|rotation)",
    );
    const animatedEmissive = new Set([
        ...gltfAnimatedMaterialPointers(record, "emissiveFactor"),
        ...gltfAnimatedMaterialPointers(
            record,
            "extensions/KHR_materials_emissive_strength/emissiveStrength",
        ),
    ]);
    const animatedExtensions = gltfAnimatedExtensionTargets(record);
    const candidates = await sceneCandidates();
    // A scene renders linear when any material transmits, because
    // `set-transmission.ts` retargets the frame graph's colour buffer — and
    // the refraction fragment composes its own image-processing arm then.
    const linearImageProcessing = materials.some(
        (entry) =>
            (asNumber(
                asObject(
                    asObject(entry["extensions"])?.[
                        "KHR_materials_transmission"
                    ],
                )?.["transmissionFactor"],
            ) ?? 0) > 0,
    );
    const skinned = skinnedMeshIndices(record);
    // Which primitive each material is drawn by, for its mesh features: a
    // second UV set or a vertex-colour stream changes the composed fragment.
    const primitiveOf = new Map<number, { mesh: number; primitive: JsonObject }>();
    for (const [mesh, entry] of (
        Array.isArray(record["meshes"]) ? (record["meshes"] as JsonObject[]) : []
    ).entries()) {
        for (const primitive of Array.isArray(entry["primitives"])
            ? (entry["primitives"] as JsonObject[])
            : []) {
            const material = asNumber(primitive["material"]);
            if (material === undefined || primitiveOf.has(material)) continue;
            primitiveOf.set(material, { mesh, primitive });
        }
    }

    console.log(
        `${scene}: ${materials.length} material(s), ` +
            (captured.size > 0
                ? `${captured.size} captured PBR fragment(s)`
                : "no capture — run `scene -- capture` to compare"),
    );
    let matched = 0;
    let gaps = 0;
    for (const [index, material] of materials.entries()) {
        const input = pinnedMaterialInputFromGltf(material, {
            imageOf,
            linearImageProcessing,
            animatedBaseColorFactor: animatedBaseColor.has(index),
            animatedEmissive: animatedEmissive.has(index),
            animatedUvTransform: animatedUvTransform.has(index),
            ...(animatedExtensions.has(index)
                ? {
                    animatedExtensionTargets:
                        animatedExtensions.get(index)!,
                }
                : {}),
        });
        const uv2Mask = (input["_uv2Mask"] as number | undefined) ?? 0;
        const drawn = primitiveOf.get(index);
        const meshFeatures = drawn
            ? await pinnedMeshFeaturesFromPrimitive(drawn.primitive, {
                skinned: skinned.has(drawn.mesh),
            })
            : 0;
        const name = typeof material["name"] === "string"
            ? material["name"]
            : `material ${index}`;

        let hit: { file: string; label: string } | undefined;
        let composed = "";
        let key = "";
        for (const candidate of candidates) {
            const variant = await composePinnedPbrVariant(input, {
                ...candidate.options,
                meshFeatures,
                uv2Mask,
            });
            if (composed === "") {
                composed = variant.fragmentWgsl;
                key = variant.fragmentKey;
            }
            const body = normalize(variant.fragmentWgsl);
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
