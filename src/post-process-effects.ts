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
     * The Babylon Lite entry point that builds the pass, which is also the
     * name the pinned module exports its factory under.
     */
    intrinsic: string;
    /** The pinned module it lives in, by its own source path. */
    module: string;
    /**
     * The pinned function whose body declares this effect's `_shader`,
     * where that is not the entry point itself.
     *
     * Bloom's merge is the reached case: the composite writes its `_shader`
     * inline rather than calling a leaf factory, so the default it reads
     * and the `writeUniforms` that reads it are declared inside
     * `createBloomPostProcessTask`. Naming it keeps this row's own
     * `intrinsic` free to be a name of its own, which is what stops the
     * effect and composite tables from sharing a key.
     */
    declaredIn?: string;
    /** The scalars the effect's `writeUniforms` reads, in storage order. */
    params: readonly PostProcessParamSlot[];
    /**
     * The config options naming textures that bind after the source.
     *
     * Read only for a pass scene code creates. A composite's sub-pass is
     * handed its textures by the composite, so what it binds is whatever the
     * pin put in that pass's own `_shader.extraTextures` — observed, not
     * listed here.
     */
    extraTextures: readonly string[];
    /** Whether `writeUniforms` reads the camera's near and far planes. */
    usesCamera: boolean;
    /**
     * An entry point a composite reaches but scene code cannot: the pin marks
     * these `@internal`, and this port refuses them at the call site for the
     * same reason. The row exists because the pass still needs its writer.
     */
    internal?: true;
}

/**
 * A composite task: one entry point that builds several passes.
 *
 * The pin gives bloom and depth-of-field the same shape as every other
 * effect from the caller's side — one `addTask`, one `updateUniforms`, one
 * `outputTexture` — and inside, each is a fixed chain of ordinary passes over
 * intermediate targets it owns. Which passes, in which order, over which
 * textures, at which sizes, is decided entirely by the config, so generation
 * obtains all of it by running the factory rather than restating it. What this
 * table carries is only what running it cannot say: which entry points to
 * watch, and which of its options name a texture or a camera.
 */
export interface PostProcessComposite {
    /** The Babylon Lite entry point scene code calls. */
    intrinsic: string;
    /** The pinned module it lives in, by its own source path. */
    module: string;
    /**
     * The entry points the composite builds its passes through, by the
     * `lib`-relative module each is imported from.
     *
     * The observation seam rewrites the composite's own imports, so it sees a
     * pass only if the composite reached it through one of these -- and a
     * chain that ends on an unobserved pass is refused rather than composed
     * short: `runComposite` checks the composite's own `outputTexture`
     * against the last pass it saw. The seam is keyed by specifier rather
     * than by effect module, so `createPostProcessTask` itself is nameable
     * here like any leaf.
     */
    passes: Readonly<Record<string, readonly string[]>>;
    /**
     * A pass the composite builds by calling `createPostProcessTask` itself
     * rather than through a leaf effect module, by that observed symbol.
     *
     * Bloom's merge is the reached case: its `_shader` is written inline in
     * the composite's own body, so there is no leaf factory to read a
     * default off and no pass object publishing the scalar its
     * `writeUniforms` reads. Both live on the composite instead, which is
     * why the value names an effect row keyed by the composite's own
     * intrinsic -- the merge's parameters and its writer are the composite's.
     */
    inlinePass?: { symbol: string; effect: string };

    /** The config options naming textures the composite reads. */
    extraTextures: readonly string[];
    /** Whether any of its passes reads the camera's near and far planes. */
    usesCamera: boolean;
}

export const POST_PROCESS_COMPOSITES: readonly PostProcessComposite[] = [
    {
        intrinsic: "createDepthOfFieldPostProcessTask",
        module: "src/post-process/depth-of-field.ts",
        passes: {
            "./circle-of-confusion.js": [
                "createCircleOfConfusionPostProcessTask",
            ],
            "./depth-of-field-blur.js": [
                "createDepthOfFieldBlurPostProcessTask",
            ],
            "./depth-of-field-merge.js": [
                "createDepthOfFieldMergePostProcessTask",
            ],
        },
        extraTextures: ["depthTexture"],
        usesCamera: true,
    },
    {
        intrinsic: "createBloomPostProcessTask",
        module: "src/post-process/bloom.ts",
        passes: {
            "./extract-highlights.js": [
                "createExtractHighlightsPostProcessTask",
            ],
            "./blur.js": ["createBlurPostProcessTask"],
            // The merge, which the composite builds itself rather than
            // through a leaf module -- see `inlinePass` below.
            "../frame-graph/post-process-task.js": ["createPostProcessTask"],
        },
        inlinePass: {
            symbol: "createPostProcessTask",
            effect: "createBloomMergePostProcessTask",
        },
        // Bloom reads only its source: the blurred highlights its merge binds
        // are its own intermediate, which the observation reports off the
        // pass's `_shader.extraTextures` rather than from a config option.
        extraTextures: [],
        usesCamera: false,
    },
];

export function postProcessComposite(
    intrinsic: string,
): PostProcessComposite | undefined {
    return POST_PROCESS_COMPOSITES.find(
        (composite) => composite.intrinsic === intrinsic,
    );
}

export const POST_PROCESS_EFFECTS: readonly PostProcessEffect[] = [
    {
        // Bloom's merge: `source.rgb + blurred.rgb * weight`. It is the one
        // pass whose `_shader` the pin writes inline in a composite's own
        // body rather than in a module of its own, so `weight` is defaulted
        // and the `writeUniforms` that reads it is declared inside
        // `createBloomPostProcessTask` -- which is what `declaredIn` says.
        // The pin exports no such entry point, so the name below is this
        // table's own and reaches no call site.
        intrinsic: "createBloomMergePostProcessTask",
        module: "src/post-process/bloom.ts",
        declaredIn: "createBloomPostProcessTask",
        params: [{ path: "weight", fallback: 0.25 }],
        // The blurred highlights bind after the source, but as the
        // composite's own intermediate rather than a config option, so the
        // observation reads them off the pass's `_shader.extraTextures`.
        extraTextures: [],
        usesCamera: false,
    },
    {
        // Bloom's first stage: it keeps pixels whose luminance clears the
        // threshold and zeroes the rest. Its writer raises the threshold to
        // gamma space, which the lowerer takes from the pinned body.
        intrinsic: "createExtractHighlightsPostProcessTask",
        module: "src/post-process/extract-highlights.ts",
        params: [
            { path: "threshold", fallback: 0.9 },
            { path: "exposure", fallback: 1 },
        ],
        extraTextures: [],
        usesCamera: false,
    },
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
    {
        // The depth-of-field blur's writer is the plain blur's, line for line:
        // both spend their block on `direction / outputSize`. What differs is
        // the composed text, which weighs every tap by the circle of confusion.
        intrinsic: "createDepthOfFieldBlurPostProcessTask",
        module: "src/post-process/depth-of-field-blur.ts",
        params: [
            { path: "direction.x", fallback: 1 },
            { path: "direction.y", fallback: 0 },
        ],
        extraTextures: ["circleOfConfusionTexture"],
        usesCamera: false,
        internal: true,
    },
    {
        // The merge carries no uniform block at all: which blur step a pixel
        // takes is decided by the circle of confusion it samples, and how many
        // steps exist is decided by the composed text.
        intrinsic: "createDepthOfFieldMergePostProcessTask",
        module: "src/post-process/depth-of-field-merge.ts",
        params: [],
        extraTextures: ["circleOfConfusionTexture"],
        usesCamera: false,
        internal: true,
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

/**
 * The settings a *composite* consumes itself, which is only its name and the
 * two textures it wires by hand.
 *
 * The rest of `POST_PROCESS_PASS_SETTINGS` is not the framework's from a
 * composite's side: it reads `sourceSamplingMode`, `alphaMode`, `viewport`
 * and `clear` off its own config and hands them to the pass it ends on. They
 * have to reach the factory, or the chain composes against the pin's defaults
 * instead of what the scene asked for.
 */
export const COMPOSITE_PASS_SETTINGS: readonly string[] = [
    "name",
    "sourceTexture",
    "targetTexture",
];

export function postProcessEffect(
    intrinsic: string,
): PostProcessEffect | undefined {
    return POST_PROCESS_EFFECTS.find(
        (effect) => effect.intrinsic === intrinsic,
    );
}

/** The `lib`-relative module the pinned package ships an entry point in. */
export function pinnedEffectModule(
    entry: Pick<PostProcessEffect, "module">,
): string {
    return entry.module.replace(/^src\//, "").replace(/\.ts$/, ".js");
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
