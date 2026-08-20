/**
 * The reached post-process effects, and what each one asks of a pass.
 *
 * Every effect Babylon Lite ships is one `createPostProcessTask` with a
 * different `_shader` record, so the pass itself needs no per-effect code:
 * what differs is the composed WGSL, which textures bind after the source, and
 * which scalars the effect's `writeUniforms` reads. This table states only
 * what the *record* needs, and each row is checked against the pin —
 * `PostProcessLowerer` asserts every default against the pinned `??` fallback
 * and emits the uniform writer out of the pinned `writeUniforms` body,
 * refusing a parameter this table does not carry.
 *
 * What the table deliberately does NOT decide is which options reach the
 * composer. Those are forwarded whole, because the pin owns the question of
 * which of them its text branches on: a list here would silently stop
 * forwarding an option the pin starts reading, and the deployed stage would
 * compose against a default the scene did not ask for.
 *
 * `params` is a storage order, not a layout: the uniform layout belongs to the
 * pin's writer, which the lowerer emits. What the order fixes is the native
 * record's parameter vector, so a scene-code setter and the emitted writer
 * name the same slot.
 */

/** One scalar the effect's own `params` object carries. */
export interface PostProcessParamSlot {
    /** The path the pinned `writeUniforms` reads it through. */
    path: string;
    /** The pin's own `??` fallback for it. */
    fallback: number;
    /**
     * A slot the pin fills from the pass rather than from the config. The
     * chromatic aberration's screen size is the only one: its factory
     * overrides `record` to take the source attachment's extent, so the value
     * cannot exist before the swapchain does.
     */
    runtime?: "sourceWidth" | "sourceHeight";
}

export interface PostProcessEffect {
    /**
     * The Babylon Lite entry point scene code calls, which is also the name
     * the pinned module exports its factory under.
     */
    intrinsic: string;
    /** The pinned module it lives in, by its own source path. */
    module: string;
    /** The scalars the effect's `writeUniforms` reads, in storage order. */
    params: readonly PostProcessParamSlot[];
    /** The config options naming textures that bind after the source. */
    extraTextures: readonly string[];
    /** Whether `writeUniforms` reads the camera's near and far planes. */
    usesCamera: boolean;
}

export const POST_PROCESS_EFFECTS: readonly PostProcessEffect[] = [
    {
        intrinsic: "createBlurPostProcessTask",
        module: "src/post-process/blur.ts",
        // `kernel` carries no slot: it decides how many taps the vertex stage
        // carries and what each weighs, so it reaches the composed text rather
        // than a uniform — which is also why the pin rebuilds the module when
        // it changes.
        params: [
            { path: "direction.x", fallback: 1 },
            { path: "direction.y", fallback: 0 },
        ],
        extraTextures: [],
        usesCamera: false,
    },
    {
        intrinsic: "createChromaticAberrationPostProcessTask",
        module: "src/post-process/chromatic-aberration.ts",
        params: [
            { path: "aberrationAmount", fallback: 30 },
            { path: "screenWidth", fallback: 1, runtime: "sourceWidth" },
            { path: "screenHeight", fallback: 1, runtime: "sourceHeight" },
            { path: "direction.x", fallback: 0.707 },
            { path: "direction.y", fallback: 0.707 },
            { path: "radialIntensity", fallback: 0 },
            { path: "centerPosition.x", fallback: 0.5 },
            { path: "centerPosition.y", fallback: 0.5 },
        ],
        extraTextures: [],
        usesCamera: false,
    },
    {
        intrinsic: "createBlackAndWhitePostProcessTask",
        module: "src/post-process/black-and-white.ts",
        params: [{ path: "degree", fallback: 1 }],
        extraTextures: [],
        usesCamera: false,
    },
    {
        intrinsic: "createAnaglyphPostProcessTask",
        module: "src/post-process/anaglyph.ts",
        params: [],
        extraTextures: ["leftTexture"],
        usesCamera: false,
    },
    {
        intrinsic: "createCircleOfConfusionPostProcessTask",
        module: "src/post-process/circle-of-confusion.ts",
        params: [
            { path: "lensSize", fallback: 50 },
            { path: "fStop", fallback: 1.4 },
            { path: "focusDistance", fallback: 2000 },
            { path: "focalLength", fallback: 50 },
        ],
        extraTextures: ["depthTexture"],
        usesCamera: true,
    },
];

/**
 * The settings `createPostProcessTask` reads itself, which every effect
 * shares. Anything else on a descriptor belongs to the effect and is
 * forwarded to its factory.
 */
export const POST_PROCESS_PASS_SETTINGS: readonly string[] = [
    "name",
    "sourceTexture",
    "sourceSamplingMode",
    "targetTexture",
    "alphaMode",
    "viewport",
    "clear",
];

export function postProcessEffect(
    intrinsic: string,
): PostProcessEffect | undefined {
    return POST_PROCESS_EFFECTS.find(
        (effect) => effect.intrinsic === intrinsic,
    );
}

/** The `lib`-relative module the pinned package ships the effect in. */
export function pinnedEffectModule(effect: PostProcessEffect): string {
    return effect.module.replace(/^src\//, "").replace(/\.ts$/, ".js");
}

/**
 * The option a slot is written from. A vector option contributes one slot per
 * component, so `direction.x` reads `direction` and takes `x`.
 */
export function slotOption(slot: PostProcessParamSlot): {
    option: string;
    component?: "x" | "y";
} {
    const dot = slot.path.indexOf(".");
    if (dot < 0) {
        return { option: slot.path };
    }
    return {
        option: slot.path.slice(0, dot),
        component: slot.path.slice(dot + 1) as "x" | "y",
    };
}
