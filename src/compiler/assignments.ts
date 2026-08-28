export type AssignmentValueKind =
    | "color3"
    | "number";

export interface DirectPropertyAssignment {
    collection: "lights";
    nativeProperty: string;
    valueKind: AssignmentValueKind;
    supportsCompound: boolean;
}

/**
 * Property writes that store one value into one field of an engine
 * record. They differ only in which record, which field, and how the
 * right-hand side compiles, so they are declared rather than repeated:
 * the ceremony around them (resolving the engine, rejecting a compound
 * assignment where JavaScript semantics need a fresh value) was identical
 * in every copy.
 *
 * `simpleOnly` marks the fields where `+=` has no meaning because the
 * value is a colour or a flag rather than an accumulating number.
 */
interface RecordFieldAssignment {
    kind: "material" | "camera-ortho";
    property: string;
    collection: "materials" | "cameras";
    /** The record field, or the pair a two-element source writes. */
    field: string | readonly [string, string];
    value: "color3" | "number" | "boolean" | "number2";
    simpleOnly?: boolean;
    /** Stored as the logical inverse of what the source assigns. */
    invert?: boolean;
}

/**
 * The `Texture2D` properties a scene writes on a texture it built.
 *
 * Upstream these are plain fields on the object every loader and factory
 * returns; `enableMaterialUvTransform` is what makes any of them observable,
 * because `writeUvTransformData` is the only reader. The table is that
 * writer's own, imported rather than restated, so the member a write lands
 * on and the member the block reads back cannot drift apart. `invertY` is the
 * texture-OBJECT property, which is also what `isStandardUvInverted` reads --
 * not `loadTexture2D`'s upload flip.
 */
const textureRecordFields = TEXTURE_UV_PROPERTIES;

const recordFieldAssignments: readonly RecordFieldAssignment[] = [
    {
        kind: "material",
        property: "diffuseColor",
        collection: "materials",
        field: "diffuse_color",
        value: "color3",
        simpleOnly: true,
    },
    {
        kind: "material",
        property: "specularColor",
        collection: "materials",
        field: "specular_color",
        value: "color3",
        simpleOnly: true,
    },
    {
        kind: "material",
        property: "emissiveColor",
        collection: "materials",
        field: "emissive_factor",
        value: "color3",
        simpleOnly: true,
    },
    {
        kind: "material",
        property: "alpha",
        collection: "materials",
        field: "alpha",
        value: "number",
    },
    {
        // The pin's `uvScale: [number, number]`, which
        // `writeStandardUvTransformData` reads into the material's own UV
        // block. It is a pair of record fields because
        // `standard_material_props` composes them back into the props
        // mirror the pinned writer reads.
        kind: "material",
        property: "uvScale",
        collection: "materials",
        field: ["diffuse_u_scale", "diffuse_v_scale"],
        value: "number2",
        simpleOnly: true,
    },
    {
        kind: "material",
        property: "specularPower",
        collection: "materials",
        field: "specular_power",
        value: "number",
    },
    {
        kind: "material",
        property: "disableLighting",
        collection: "materials",
        field: "disable_lighting",
        value: "boolean",
        simpleOnly: true,
    },
    {
        // src/material/standard/create-standard-material.ts defaults
        // `backFaceCulling: true`, and standard-pipeline.ts culls with
        // `features & DOUBLE_SIDED ? "none" : "back"`, so the flag is the
        // native `double_sided` inverted.
        kind: "material",
        property: "backFaceCulling",
        collection: "materials",
        field: "double_sided",
        value: "boolean",
        simpleOnly: true,
        invert: true,
    },
    {
        // src/camera/orthographic.ts: the bounds stay live, and its setter
        // only stores the extent and invalidates the projection cache. The
        // native projection is rebuilt from the record every frame, so
        // storing it is the whole contract.
        kind: "camera-ortho",
        property: "halfHeight",
        collection: "cameras",
        field: "ortho_half_height",
        value: "number",
    },
];

function emitFrameGraphTransmission(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
    left: ts.PropertyAccessExpression,
): boolean {
    if (
        left.name.text !== "transmission" ||
        !ts.isPropertyAccessExpression(left.expression) ||
        left.expression.name.text !== "_config"
    ) {
        return false;
    }
    const task = context.unwrap(
        left.expression.expression,
    );
    if (
        !ts.isElementAccessExpression(task) ||
        !ts.isPropertyAccessExpression(task.expression) ||
        task.expression.name.text !== "_tasks"
    ) {
        return false;
    }
    const frameGraph = context.unwrap(
        task.expression.expression,
    );
    if (
        !ts.isCallExpression(frameGraph) ||
        !ts.isIdentifier(frameGraph.expression) ||
        context.importedName(frameGraph.expression) !==
            "getFrameGraph" ||
        frameGraph.arguments.length !== 1
    ) {
        return false;
    }
    const options = context.unwrap(expression.right);
    if (!ts.isObjectLiteralExpression(options)) {
        context.fail(
            expression.right,
            "Frame-graph transmission requires an options object.",
        );
    }
    const copyCount = context.objectProperty(
        options,
        "copyCount",
    );
    if (
        !copyCount ||
        context.compileNumber(copyCount) !== "1.0f"
    ) {
        context.fail(
            options,
            "Reached frame-graph transmission requires copyCount: 1.",
        );
    }
    const scene = context.compileValue(
        frameGraph.arguments[0]!,
    );
    context.expectKind(
        scene,
        "scene",
        frameGraph.arguments[0]!,
    );
    context.reachFeature("renderer:pbr", expression);
    context.reachFeature("renderer:transmission", expression);
    context.reachFeature(
        "material:pbr-linear-image-processing",
        expression,
    );
    context.emit(
        `bbl::enable_scene_transmission(${scene.cpp});`,
    );
    return true;
}

const commonLightProperties: Readonly<
    Record<string, DirectPropertyAssignment>
> = {
    intensity: {
        collection: "lights",
        nativeProperty: "intensity",
        valueKind: "number",
        supportsCompound: true,
    },
};

/** The colour pair every positional kind writes. */
const positionalLightProperties: Readonly<
    Record<string, DirectPropertyAssignment>
> = {
    ...commonLightProperties,
    diffuse: {
        collection: "lights",
        nativeProperty: "diffuse_color",
        valueKind: "color3",
        supportsCompound: false,
    },
    specular: {
        collection: "lights",
        nativeProperty: "specular_color",
        valueKind: "color3",
        supportsCompound: false,
    },
};

/** `_writeLightUbo` packs it into the same lane for point and spot alike. */
const lightRangeProperty: DirectPropertyAssignment = {
    collection: "lights",
    nativeProperty: "range",
    valueKind: "number",
    supportsCompound: true,
};

const lightProperties: Readonly<
    Record<
        LightKind,
        Readonly<Record<string, DirectPropertyAssignment>>
    >
> = {
    directional: positionalLightProperties,
    hemispheric: {
        ...commonLightProperties,
        diffuseColor: {
            collection: "lights",
            nativeProperty: "diffuse_color",
            valueKind: "color3",
            supportsCompound: false,
        },
        specularColor: {
            collection: "lights",
            nativeProperty: "specular_color",
            valueKind: "color3",
            supportsCompound: false,
        },
    },
    // The three positional kinds carry the same colour pair; the two whose
    // pinned writer packs an attenuation range carry that too. `angle` and
    // `exponent` are settable upstream and are not written by any reached
    // scene, so they stay unlowered and fail explicitly rather than being
    // accepted and ignored.
    point: {
        ...positionalLightProperties,
        range: lightRangeProperty,
    },
    spot: {
        ...positionalLightProperties,
        range: lightRangeProperty,
    },
};

export function directPropertyAssignment(
    owner: Value,
    property: string,
): DirectPropertyAssignment | undefined {
    if (owner.kind !== "light" || !owner.lightKind) {
        return undefined;
    }
    return lightProperties[owner.lightKind][property];
}

/**
 * The light vectors a scene may write after creation, beside the scalar and
 * colour properties above and for the same reason: a kind carries the vectors
 * its pinned type declares, and one no reached scene writes stays unlowered
 * and fails explicitly rather than being accepted and ignored.
 *
 * `light.position.set(x, y, z)` is not a record-field write like the entries
 * above — an `ObservableVec3` write also marks the light's local matrix
 * dirty — so each of these lowers to its own kind's emitted entry point
 * rather than to a `DirectPropertyAssignment`. `LightLowerer` emits exactly
 * these, checked against the pinned factory's own `ObservableVec3`
 * properties.
 */
const lightVectors: Readonly<Record<LightKind, readonly string[]>> = {
    // No reached scene writes a hemispheric direction.
    hemispheric: [],
    point: ["position"],
    directional: ["position"],
    spot: ["position", "direction"],
};

/** The emitted entry point for `light.<vector>.set(...)`, if there is one. */
export function lightVectorSetter(
    owner: Value,
    vector: string,
): string | undefined {
    if (owner.kind !== "light" || !owner.lightKind) {
        return undefined;
    }
    return lightVectors[owner.lightKind].includes(vector)
        ? `set_${owner.lightKind}_light_${vector}`
        : undefined;
}

export interface AssignmentContext extends DeterministicRandomContext {
    readonly checker: ts.TypeChecker;
    /** Which material a scene-code mesh was assigned, by its mesh index. */
    recordSceneMeshMaterial(
        meshIndex: number,
        material: { pbrMaterial: number | null; nodeMaterial: number | null },
    ): void;
    recordUnknownSceneMeshMaterial(materialIndex: number): void;
    recordToneMappingEnabledMutation(): void;
    /** The scene's node-particle program; a texture write lands on it. */
    readonly reachedNodeParticles: CompiledNodeParticles;
    /** Pixels-texture locals already copied into a material slot. */
    readonly boundPixelsTextures: Set<string>;
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    /**
     * Records the tone-mapping curve the scene selected, refusing a second
     * differing selection: the composed arms are closed at generation, so a
     * scene reaching two curves would need a variant table this port does not
     * key by them.
     */
    selectToneMapping(name: string, node: ts.Node): void;
    lookup(identifier: ts.Identifier): Value;
    compileValue(expression: ts.Expression): Value;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileBoolean(expression: ts.Expression): string;
    compileColor3(expression: ts.Expression): string;
    compileColor4(expression: ts.Expression): string;
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    unwrap(expression: ts.Expression): ts.Expression;
    importedName(
        identifier: ts.Identifier,
    ): string | undefined;
    expectKind(
        value: Value,
        kind: ValueKind,
        node: ts.Node,
    ): void;
    expectSameEngine(
        left: Value,
        right: Value,
        node: ts.Node,
    ): void;
    requireEngine(value: Value, node: ts.Node): string;
    eraseBrowserInstrumentation(position: number): void;
    isBrowserOnlyExpression(
        expression: ts.Expression,
    ): boolean;
    emit(line: string): void;
    /**
     * Records the feature and its first reaching scene-source call
     * site (here the assignment expression), so the activation
     * inventory can cite file:line.
     */
    reachFeature(feature: Feature, site: ts.Node): void;
    /** `mesh.receiveShadows = true`, by scene-mesh index. */
    recordShadowReceiver(sceneMeshIndex: number): void;
    propertyName(name: ts.PropertyName): string | undefined;
    probeStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression | undefined;
    compileStaticString(expression: ts.Expression): string;
    /** `material.plugins = [...]` on the scene PBR material the write names. */
    recordScenePbrPlugins(
        plugins: readonly MaterialPluginManifest[],
        index: number | undefined,
    ): void;
    /** The same, on a Standard material: its signature index, from one. */
    recordStandardMaterialPlugins(
        plugins: readonly MaterialPluginManifest[],
    ): number;
    fail(node: ts.Node, message: string): never;
}

/**
 * `scene.lights.length = 0` empties the scene's light list, which is how a
 * scene drops the lights a loaded asset brought with it and lights itself
 * from the environment alone. Only the clear is lowered: truncating to a
 * non-zero length would have to decide which handles survive, and no reached
 * scene asks for it.
 */
function emitSceneLightListClear(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
    left: ts.PropertyAccessExpression,
): boolean {
    if (
        left.name.text !== "length" ||
        !ts.isPropertyAccessExpression(left.expression) ||
        left.expression.name.text !== "lights"
    ) {
        return false;
    }
    const owner = context.compileValue(
        left.expression.expression,
    );
    if (owner.kind !== "scene") {
        return false;
    }
    requireSimpleAssignment(
        context,
        expression,
        "scene light list length",
    );
    if (
        !ts.isNumericLiteral(expression.right) ||
        Number(expression.right.text) !== 0
    ) {
        context.fail(
            expression.right,
            "Reached scene light list assignment supports clearing to zero.",
        );
    }
    context.emit(`${owner.cpp}.lights.clear();`);
    return true;
}

/**
 * The scalars a scene writes on a particle system between simulation steps.
 *
 * All three are inputs to `animateParticleSystem` rather than properties of
 * the state it produces, so a write travels to the bake as one more step in
 * the sequence. `blendMode` and `texture` are deliberately not here: the
 * first would move a composed variant after the set is closed, and the
 * second is a resource rather than a scalar.
 */
const particleScalars = [
    "emitRate",
    "updateSpeed",
    "targetStopDuration",
];

/**
 * One such write, recorded where the scene made it.
 *
 * The bake replays the whole sequence, so the position of this write among
 * the start/animate calls is what it means -- `updateSpeed = 0` after the
 * last step is what freezes the system a scene then registers.
 */
function emitNodeParticleScalarAssignment(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
    left: ts.PropertyAccessExpression,
    target: Value,
    property: string,
): void {
    requireSimpleAssignment(
        context,
        expression,
        `node-particle system ${property}`,
    );
    const set = target.nodeParticleSetIndex;
    const system = target.nodeParticleSystemIndex;
    if (set === undefined || system === undefined) {
        context.fail(
            left,
            "This particle system did not come from a built " +
                "node-particle set.",
        );
    }
    const value = staticNumberValue(context, expression.right);
    if (value === undefined) {
        context.fail(
            expression.right,
            `A node-particle system's ${property} is a static number: the ` +
                "simulation runs at generation.",
        );
    }
    context.reachedNodeParticles.steps.push({
        op: "scalar",
        set,
        system,
        name: property as "emitRate" | "updateSpeed" | "targetStopDuration",
        value,
    });
}

/**
 * `system.texture = <texture>`: the image a particle system renders with.
 *
 * A graph whose `ParticleTextureSourceBlock` carries no URL leaves the
 * system untextured, and `createParticleBillboard` throws there — so the
 * corpus assigns the texture itself, and the assignment is part of the
 * program the bake replays. It is folded rather than emitted: the write is
 * a static fact about this system, and what reads it is the atlas the
 * generated billboard builder makes. A write AFTER that builder ran would
 * be a second state, so it refuses.
 */
function emitNodeParticleTextureAssignment(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
    left: ts.PropertyAccessExpression,
    target: Value,
): void {
    requireSimpleAssignment(
        context,
        expression,
        "node-particle system texture",
    );
    const texture = context.compileValue(expression.right);
    context.expectKind(texture, "texture", expression.right);
    if (!texture.pixelsTexture) {
        context.fail(
            expression.right,
            "A node-particle system's texture comes from " +
                "createTexture2DFromPixels with a static size: the bake " +
                "partitions its atlas by that size, and the graph's own " +
                "texture block loads every other kind.",
        );
    }
    const set = target.nodeParticleSetIndex;
    const system = target.nodeParticleSystemIndex;
    if (set === undefined || system === undefined) {
        context.fail(
            left,
            "This particle system did not come from a built " +
                "node-particle set.",
        );
    }
    const program = context.reachedNodeParticles;
    if (
        program.billboards.some(
            (frozen) => frozen.set === set && frozen.system === system,
        ) ||
        program.registrations.some((entry) => entry.set === set)
    ) {
        context.fail(
            left,
            "This particle system's billboard was already built; its " +
                "texture is read there.",
        );
    }
    if (
        program.textures.some(
            (entry) => entry.set === set && entry.system === system,
        )
    ) {
        context.fail(
            left,
            "This particle system's texture is already assigned; the " +
                "bake carries one.",
        );
    }
    program.textures.push({
        set,
        system,
        ...texture.pixelsTexture,
    });
}

/**
 * A post-process effect's own settable option.
 *
 * The pin gives each one a `defineProperty` pair over the factory's `params`
 * record, so a write is a store into that record and nothing else -- the
 * uniform block moves only when `updateUniforms` runs. Native keeps the same
 * split: the parameter vector takes the value here, and the backend rewrites
 * the block when the pass is next recorded.
 */
function emitPostProcessOptionAssignment(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
    left: ts.PropertyAccessExpression,
    owner: Value,
): boolean {
    if (owner.kind === "task" && owner.postProcessComposite) {
        // The pin publishes setters on a composite too, but each writes a
        // parameter on a pass its own factory built, and generation baked
        // those in. Refusing says so rather than writing a slot that is not
        // the one the pin would have moved.
        context.fail(
            left,
            `'${left.name.text}' is a setter on a composite post-process ` +
                "task, which this port bakes at generation.",
        );
    }
    if (owner.kind !== "task" || !owner.postProcessTask) {
        return false;
    }
    const effect = postProcessEffect(owner.postProcessTask.intrinsic);
    const slot = effect?.params.findIndex(
        (candidate) => candidate.path === left.name.text,
    );
    if (!effect || slot === undefined || slot < 0) {
        context.fail(
            left,
            `Post-process effect '${
                owner.postProcessTask.intrinsic
            }' has no settable option '${left.name.text}'.`,
        );
    }
    requireSimpleAssignment(
        context,
        expression,
        "post-process option",
    );
    // A plain effect is a task recording one pass, so its parameter vector is
    // that pass's. A composite's would be several, which is why a setter on
    // one is refused above.

    context.emit(
        `${context.requireEngine(owner, expression)}.frame_tasks[${
            owner.cpp
        }.value].post_process.passes[0].params[${slot}] = ${context.compileNumber(
            expression.right,
            "double",
        )};`,
    );
    return true;
}

export function emitPropertyAssignment(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
): void {
    // A particle column write edits the state the bake reads, so it is
    // recorded as a step rather than emitted -- and it is an ELEMENT
    // access, which the property gate below would refuse first.
    if (emitParticleBufferWrite(context, expression)) {
        return;
    }
    if (!ts.isPropertyAccessExpression(expression.left)) {
        context.fail(
            expression.left,
            "Only property assignments are supported.",
        );
    }

    const operator = assignmentOperator(
        context,
        expression,
    );
    const left = expression.left;
    if (
        emitDeterministicRandomInstall(
            context,
            expression,
            left,
            context.checker,
        )
    ) {
        return;
    }
    if (context.isBrowserOnlyExpression(left)) {
        context.eraseBrowserInstrumentation(
            expression.pos,
        );
        return;
    }
    // `param.value = x`, `osc.type = "square"`. The audio handles are the
    // one family whose writes go through the PAL rather than onto an
    // engine record.
    if (emitAudioPropertyAssignment(context, expression, left)) {
        return;
    }
    if (
        emitFrameGraphTransmission(
            context,
            expression,
            left,
        )
    ) {
        return;
    }
    if (emitSceneLightListClear(context, expression, left)) {
        return;
    }
    if (
        ts.isIdentifier(left.expression) &&
        emitPostProcessOptionAssignment(
            context,
            expression,
            left,
            context.lookup(left.expression),
        )
    ) {
        return;
    }
    if (
        ts.isPropertyAccessExpression(left.expression) &&
        left.expression.name.text === "dataset" &&
        ts.isIdentifier(left.expression.expression)
    ) {
        const target = context.lookup(
            left.expression.expression,
        );
        if (target.kind === "browser") {
            context.eraseBrowserInstrumentation(
                expression.pos,
            );
            return;
        }
    }
    if (
        ts.isPropertyAccessExpression(left.expression) &&
        left.expression.name.text === "imageProcessing" &&
        ts.isIdentifier(left.expression.expression)
    ) {
        const scene = context.lookup(
            left.expression.expression,
        );
        context.expectKind(
            scene,
            "scene",
            left.expression.expression,
        );
        const property = left.name.text;
        if (
            ![
                "exposure",
                "contrast",
                "toneMapping",
                "toneMappingEnabled",
            ].includes(property)
        ) {
            context.fail(
                left.name,
                `Unsupported image-processing property '${property}'.`,
            );
        }
        if (property === "toneMapping") {
            // The curve is one of the pin's own `ToneMapping` records, whose
            // WGSL the composer splices into the PBR fragment. Nothing about
            // it survives to run time, so the assignment emits no statement
            // and records which record composition should read.
            requireSimpleAssignment(
                context,
                expression,
                `image-processing property '${property}'`,
            );
            const value = context.compileValue(expression.right);
            if (
                value.kind !== "tone-mapping" ||
                value.staticString === undefined
            ) {
                context.fail(
                    expression.right,
                    "A scene's tone mapping is one of the pinned records: " +
                        `${toneMappingExportNames().join(", ")}.`,
                );
            }
            context.selectToneMapping(value.staticString, expression.right);
            return;
        }
        if (property === "toneMappingEnabled") {
            requireSimpleAssignment(
                context,
                expression,
                `image-processing property '${property}'`,
            );
            context.recordToneMappingEnabledMutation();
            context.emit(
                `${scene.cpp}.environment.tone_mapping_enabled = ${context.compileBoolean(expression.right)};`,
            );
            return;
        }
        context.emit(
            `${scene.cpp}.environment.${property} ${operator} ${context.compileNumber(expression.right)};`,
        );
        return;
    }
    if (
        ts.isPropertyAccessExpression(left.expression) &&
        left.expression.name.text === "camera" &&
        ts.isIdentifier(left.expression.expression)
    ) {
        const scene = context.lookup(
            left.expression.expression,
        );
        context.expectKind(
            scene,
            "scene",
            left.expression.expression,
        );
        const property = left.name.text;
        const nativeProperty =
            cameraRecordField(property);
        if (!nativeProperty) {
            context.fail(
                left.name,
                `Unsupported camera property '${property}'.`,
            );
        }
        noteCameraRecordWrite(
            context,
            scene.sceneCamera,
            property,
            expression.right,
            operator === "=",
        );
        context.emit(
            `${context.requireEngine(scene, expression)}.cameras[${scene.cpp}.camera.value].${nativeProperty} ${operator} ${context.compileNumber(expression.right, "double")};`,
        );
        return;
    }
    if (
        left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
        // A resource field write — the engine, the scene, a material.
        // Data fields never reach here: they resolve as data paths
        // above and assign through the local that holds them.
        //
        // A resource field has no storage to assign through, only a
        // compile-time binding, so it may be written exactly once. A
        // second write inside a branch would otherwise make the new
        // value visible on every path, which is a different program.
        const instance = context.compileValue(
            left.expression,
        );
        const fields = instance.recordProperties;
        if (!fields) {
            context.fail(
                left,
                "'this' does not resolve to a class instance here.",
            );
        }
        if (fields[left.name.text]) {
            context.fail(
                expression,
                `Field '${left.name.text}' is already bound; a class field that holds a resource is wired once and cannot be reassigned.`,
            );
        }
        fields[left.name.text] = context.compileValue(
            expression.right,
        );
        return;
    }
    if (
        ts.isPropertyAccessExpression(left.expression) &&
        ts.isIdentifier(left.expression.expression) &&
        context.lookup(left.expression.expression).kind ===
            "camera" &&
        left.expression.name.text === "target"
    ) {
        // Component writes into the camera target record (the demo
        // renderer's camera shake). The record's properties already
        // carry their native lvalues for reads.
        const record = context.compileValue(left.expression);
        const component =
            record.recordProperties?.[left.name.text];
        if (!component || component.kind !== "number") {
            context.fail(
                left.name,
                `Unsupported camera target component '${left.name.text}'.`,
            );
        }
        context.emit(
            `${component.cpp} ${operator} ${context.compileNumber(expression.right, "double")};`,
        );
        return;
    }
    // A scene may widen the target before writing a property the narrow
    // type does not carry -- `(sphere as { material?: unknown }).material`
    // is how the corpus assigns a node material to a mesh. The cast is a
    // type-level annotation with no value, so the target it names is the
    // expression underneath it.
    const targetExpression = context.unwrap(left.expression);
    if (ts.isIdentifier(targetExpression)) {
        const target = context.lookup(targetExpression);
        const property = left.name.text;

        if (
            target.kind === "node-particle-system" &&
            property === "buffer"
        ) {
            context.fail(
                left,
                "A particle buffer is generation-time state; only one of " +
                    "its columns may be written, by index.",
            );
        }

        if (
            target.kind === "node-particle-system" &&
            particleScalars.includes(property)
        ) {
            emitNodeParticleScalarAssignment(
                context,
                expression,
                left,
                target,
                property,
            );
            return;
        }

        if (
            target.kind === "node-particle-system" &&
            property === "texture"
        ) {
            emitNodeParticleTextureAssignment(
                context,
                expression,
                left,
                target,
            );
            return;
        }

        if (
            target.kind === "scene" &&
            property === "clearColor"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "scene clearColor",
            );
            context.emit(
                `${target.cpp}.clear_color = ${context.compileColor4(expression.right)};`,
            );
            return;
        }

        if (
            target.kind === "scene" &&
            property === "camera"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "scene camera",
            );
            const camera = context.compileValue(
                expression.right,
            );
            context.expectKind(
                camera,
                "camera",
                expression.right,
            );
            // The scene keeps the camera VALUE, not a copy: a property
            // written after the assignment still reaches it, and one
            // executed port -- the node-particle flow-map build -- reads
            // the scene's camera rather than the scene's own records.
            target.sceneCamera = camera;
            context.emit(
                `${target.cpp}.camera = ${camera.cpp};`,
            );
            return;
        }

        if (
            target.kind === "scene" &&
            property === "fixedDeltaMs"
        ) {
            context.emit(
                `${target.cpp}.fixed_delta_ms ${operator} ${context.compileNumber(expression.right)};`,
            );
            return;
        }

        if (
            target.kind === "mesh" &&
            property === "renderOrder"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "mesh renderOrder",
            );
            const engine = context.requireEngine(
                target,
                expression,
            );
            context.emit(
                `${engine}.meshes[${target.cpp}.value].render_order = ${context.compileNumber(expression.right, "double")};`,
            );
            context.emit(
                `${engine}.meshes[${target.cpp}.value].has_render_order = true;`,
            );
            return;
        }

        if (
            target.kind === "mesh" &&
            property === "name"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "mesh name",
            );
            const name = context.compileValue(
                expression.right,
            );
            context.expectKind(
                name,
                "string",
                expression.right,
            );
            context.emit(
                `${context.requireEngine(target, expression)}.meshes[${target.cpp}.value].name = ${name.cpp};`,
            );
            return;
        }

        // `mesh.receiveShadows` is a composition key and nothing else:
        // `_computeMeshFeatures` turns it into `MSH_RECEIVE_SHADOWS`, which
        // selects the fragment carrying the per-light sampling, and every
        // consumer downstream — the variant selector, both backends' bind
        // decision — reads that composed word rather than a record lane. So
        // the assignment records the receiver for composition and emits
        // nothing, exactly as the material-tracking installers do.
        if (
            target.kind === "mesh" &&
            property === "receiveShadows"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "mesh receiveShadows",
            );
            const enabled = context.compileValue(expression.right);
            context.expectKind(enabled, "boolean", expression.right);
            if (enabled.cpp !== "true") {
                context.fail(
                    expression.right,
                    "Only `receiveShadows = true` is lowered: the composed " +
                        "variant is selected at generation, so a value the " +
                        "scene computes would need both fragments.",
                );
            }
            if (target.sceneMeshIndex === undefined) {
                context.fail(
                    left.expression,
                    "Shadow receiving is lowered for a scene-code mesh: an " +
                        "imported one composes through its asset's own " +
                        "variant rows.",
                );
            }
            context.recordShadowReceiver(target.sceneMeshIndex);
            // The record lane too, which the node family reads per draw:
            // its receiver mixes each light's factor by `receivesShadow`
            // rather than selecting a variant, so one composed module
            // serves a receiving mesh and a non-receiving one. The two
            // composed families never read the lane.
            context.emit(
                `${context.requireEngine(target, expression)}.meshes[` +
                    `${target.cpp}.value].receives_shadows = true;`,
            );
            return;
        }

        // `material.plugins = [plugin]` is the pin's per-instance attach, and
        // the whole of it is composition input: both bridges read the list
        // to build one `ShaderFragment` and to number a signature, and that
        // number rides the host material's feature bits so every compose and
        // pipeline cache rebuilds on a plugin change.
        //
        // Which half of that reaches the runtime differs by family, because
        // the two variant selectors are keyed differently. A PBR draw
        // resolves its variant by MATERIAL INDEX, so the composed row for
        // this material already carries the plugin and nothing has to travel
        // on the record. A Standard draw resolves by the feature word
        // `standard_material_features` derives from the record, so the index
        // has to be there -- which is exactly what `registerStdPlugins`
        // pre-bakes into `_renderFeatures` upstream, for the same reason.
        if (target.kind === "material" && property === "plugins") {
            requireSimpleAssignment(context, expression, "material plugins");
            const plugins = foldMaterialPluginList(
                context,
                expression.right,
            );
            if (target.scenePbrMaterialIndex !== undefined) {
                context.recordScenePbrPlugins(
                    plugins,
                    target.scenePbrMaterialIndex,
                );
                return;
            }
            if (!target.standardMaterial) {
                context.fail(
                    left.expression,
                    "Material plugins attach to a PBR or a Standard " +
                        "material: the pin's two bridges are the only " +
                        "readers, and its Standard one filters on the " +
                        "material's own group builder, so a plugin on any " +
                        "other family composes nothing upstream either.",
                );
            }
            // The record lane is its own reach, separate from the
            // opt-in: upstream a `plugins` array on a material is always
            // legal and is simply inert until `enableMaterialPlugins`
            // registers the bridges, so the write has to compile either way
            // -- gating the setter's definition on the opt-in instead would
            // leave this call undefined for a scene that never made it.
            context.reachFeature("material:plugin-index", expression);
            context.emit(
                `bbl::set_material_plugins(` +
                    `${context.requireEngine(target, expression)}, ` +
                    `${target.cpp}, static_cast<std::uint8_t>(` +
                    `${context.recordStandardMaterialPlugins(plugins)}));`,
            );
            return;
        }

        if (
            target.kind === "light" &&
            property === "shadowGenerator"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "light shadowGenerator",
            );
            const generator = context.compileValue(expression.right);
            context.expectKind(
                generator,
                "shadow-generator",
                expression.right,
            );
            context.expectSameEngine(target, generator, expression);
            context.emit(
                `${context.requireEngine(target, expression)}.lights[${target.cpp}.value].shadow_generator = ${generator.cpp};`,
            );
            // The pin's `ShadowTask` walks `scene.lights` and its receiver
            // slots come from the same walk, so the generator has to be
            // reachable from the light -- and a later
            // `setShadowTaskCasterMeshes(light.shadowGenerator, ...)` reads
            // it back off the light, which is what this carries.
            if (generator.shadowGeneratorIndex !== undefined) {
                target.shadowGeneratorIndex =
                    generator.shadowGeneratorIndex;
            }
            return;
        }

        if (
            target.kind === "mesh" &&
            property === "material"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "mesh material",
            );
            const material = context.compileValue(
                expression.right,
            );
            context.expectKind(
                material,
                "material",
                expression.right,
            );
            context.expectSameEngine(
                target,
                material,
                expression,
            );
            context.emit(
                `${context.requireEngine(target, expression)}.meshes[${target.cpp}.value].material = ${material.cpp};`,
            );
            // The pin's opt-in setters take the material back off the mesh
            // (`setPbrSkybox(box.material)`) and mutate the same object, so
            // the mesh carries which scene material it was given and a
            // later read of `mesh.material` resolves that record.
            if (material.scenePbrMaterialIndex !== undefined) {
                target.scenePbrMaterialIndex =
                    material.scenePbrMaterialIndex;
            }
            // The family travels the same way, and for the same reason: a
            // write on `box.material` has to resolve which of the pin's two
            // bridges would read it.
            if (material.standardMaterial) {
                target.standardMaterial = true;
            }
            // The pair the caster list resolves against. Upstream reads
            // `mesh.material` when the shadow pass builds, so a scene may
            // name its casters before assigning their materials -- which is
            // why the mesh's own Value does not carry the graph: this map is
            // the one producer of the pair.
            if (target.sceneMeshIndex !== undefined) {
                context.recordSceneMeshMaterial(target.sceneMeshIndex, {
                    pbrMaterial: material.scenePbrMaterialIndex ?? null,
                    nodeMaterial: material.nodeMaterialIndex ?? null,
                });
            } else if (material.scenePbrMaterialIndex !== undefined) {
                context.recordUnknownSceneMeshMaterial(
                    material.scenePbrMaterialIndex,
                );
            }
            return;
        }

        if (
            target.kind === "mesh" &&
            (property === "boundMin" || property === "boundMax")
        ) {
            requireSimpleAssignment(
                context,
                expression,
                `mesh ${property}`,
            );
            const engine = context.requireEngine(target, expression);
            const nativeProperty =
                property === "boundMin" ? "bounds_min" : "bounds_max";
            const side = property === "boundMin" ? "min" : "max";
            context.emit(
                `${engine}.meshes[${target.cpp}.value].${nativeProperty}_override = ${context.compileVec3(expression.right)};`,
            );
            context.emit(
                `${engine}.meshes[${target.cpp}.value].has_bounds_${side}_override = true;`,
            );
            return;
        }

        if (
            target.kind === "mesh" &&
            property === "morphTargets"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "mesh morphTargets",
            );
            if (!target.directMorphCompatible) {
                context.fail(
                    left.expression,
                    "Direct morph targets require a compiler-created mesh.",
                );
            }
            const morph = context.compileValue(
                expression.right,
            );
            context.expectKind(
                morph,
                "morph-targets",
                expression.right,
            );
            context.expectSameEngine(
                target,
                morph,
                expression,
            );
            if (!morph.morphTarget) {
                context.fail(
                    expression.right,
                    "Morph target data is incomplete.",
                );
            }
            if (morph.morphTarget.meshCpp) {
                context.fail(
                    expression.right,
                    "Direct morph target data can be attached to one mesh.",
                );
            }
            const engine = context.requireEngine(
                target,
                expression,
            );
            context.emit(
                `bbl::attach_morph_target(${engine}, ${target.cpp}, ` +
                    `${morph.morphTarget.positionsCpp}, ` +
                    `${morph.morphTarget.normalsCpp}, ` +
                    `${morph.morphTarget.vertexCountCpp}, ` +
                    `${morph.morphTarget.weightCpp});`,
            );
            morph.morphTarget.meshCpp = target.cpp;
            context.reachFeature("mesh:morph-targets", expression);
            return;
        }

        if (target.kind === "texture" && property in textureRecordFields) {
            const field = textureRecordFields[property]!;
            requireSimpleAssignment(
                context,
                expression,
                `texture ${property}`,
            );
            if (!target.pixelsTexture) {
                context.fail(
                    left,
                    `Reached '${property}' writes land on a ` +
                        "createTexture2DFromPixels texture; the loaders' " +
                        "own textures are not written from scene code.",
                );
            }
            if (context.boundPixelsTextures.has(target.cpp)) {
                context.fail(
                    left,
                    `'${property}' is written after this texture was bound ` +
                        "to a material, where the slot already took its " +
                        "copy. Upstream binds one object, so the write " +
                        "would reach the material there and not here.",
                );
            }
            context.emit(
                `${target.cpp}.${field.record} = ${
                    field.value === "boolean"
                        ? context.compileBoolean(expression.right)
                        : context.compileNumber(expression.right, "double")
                };`,
            );
            return;
        }

        if (
            target.kind === "material" &&
            property === "diffuseTexture"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "material diffuseTexture",
            );
            const texture = context.compileValue(
                expression.right,
            );
            // A `createTexture2DFromPixels` texture is the second source
            // this slot takes. It is a C++ value rather than a handle, so
            // the record takes a copy and the local is recorded as spent:
            // a transform write afterwards would move the local where the
            // pin would have moved the material's own texture object.
            if (texture.kind === "texture" && texture.pixelsTexture) {
                context.reachFeature(
                    "material:standard-diffuse-pixels-texture",
                    expression,
                );
                context.boundPixelsTextures.add(texture.cpp);
                context.emit(
                    `bbl::set_standard_diffuse_pixels_texture(` +
                        `${context.requireEngine(target, expression)}, ` +
                        `${target.cpp}, ${texture.cpp});`,
                );
                return;
            }
            // A loaded image is the third source, and the one the
            // `.babylon` loader already fills this slot with. The texture
            // object travels whole rather than as bytes, because the
            // sampler, the upload flip and the texture-object `invertY`
            // the Standard UV block reads are all the texture's own.
            if (texture.kind === "texture" && texture.textureFile) {
                if (texture.textureFile.srgb) {
                    context.fail(
                        expression.right,
                        "A Standard diffuse slot uploads through the " +
                            "family's own encoding, which is linear; an " +
                            "sRGB texture in it is not lowered.",
                    );
                }
                context.reachFeature(
                    "material:standard-diffuse-file-texture",
                    expression,
                );
                context.emit(
                    `bbl::set_standard_diffuse_file_texture(` +
                        `${context.requireEngine(target, expression)}, ` +
                        `${target.cpp}, ${texture.cpp});`,
                );
                return;
            }
            // What this slot accepts, said the way every frame-graph slot
            // says it. `sampling: "color"` is the aspect the setter folds
            // -- `rtt.ts` gives a colour view `invertY: true` and the
            // bilinear sampler, a depth one `invertY: false` and the
            // nearest -- and `sources` is the ownership: only a target the
            // scene made, never a geometry task's attachment.
            const textureCpp = compileRenderTextureValue(
                context,
                expression.right,
                texture,
                "Reached Standard diffuseTexture",
                { sampling: "color", sources: ["render-target"] },
            );
            context.expectSameEngine(
                target,
                texture,
                expression,
            );
            context.reachFeature(
                "material:standard-diffuse-render-texture",
                expression,
            );
            context.emit(
                `bbl::set_standard_diffuse_render_texture(` +
                    `${context.requireEngine(target, expression)}, ` +
                    `${target.cpp}, ${textureCpp});`,
            );
            return;
        }

        const recordField = recordFieldAssignments.find(
            (candidate) =>
                candidate.kind === target.kind &&
                candidate.property === property,
        );
        if (recordField) {
            if (recordField.simpleOnly) {
                requireSimpleAssignment(
                    context,
                    expression,
                    `${recordField.kind} ${recordField.property}`,
                );
            }
            const record =
                `${context.requireEngine(target, expression)}` +
                `.${recordField.collection}[${target.cpp}.value]`;
            if (recordField.value === "number2") {
                const elements = context.unwrap(expression.right);
                const fields = recordField.field;
                if (
                    !ts.isArrayLiteralExpression(elements) ||
                    elements.elements.length !== 2 ||
                    typeof fields === "string"
                ) {
                    context.fail(
                        expression.right,
                        `Reached ${recordField.kind} ${recordField.property} ` +
                            "takes a two-element array literal.",
                    );
                }
                for (const [index, field] of fields.entries()) {
                    context.emit(
                        `${record}.${field} = ` +
                            `${context.compileNumber(elements.elements[index]!)};`,
                    );
                }
                return;
            }
            if (typeof recordField.field !== "string") {
                context.fail(
                    expression,
                    `Reached ${recordField.kind} ${recordField.property} ` +
                        "names a field pair with a scalar value.",
                );
            }
            const value =
                recordField.value === "color3"
                    ? context.compileColor3(expression.right)
                    : recordField.value === "boolean"
                      ? context.compileBoolean(expression.right)
                      : context.compileNumber(
                            expression.right,
                            recordField.collection === "cameras"
                                ? "double"
                                : "float",
                        );
            const stored = recordField.invert
                ? `!(${value})`
                : value;
            context.emit(
                `${record}.${recordField.field} ` +
                    `${recordField.simpleOnly ? "=" : operator} ${stored};`,
            );
            if (
                recordField.kind === "material" &&
                recordField.property === "alpha"
            ) {
                // The pin reads `mat.alpha < 1` live when it builds
                // renderables, so a post-creation write moves the
                // material between the opaque and blended families.
                // One shared home for the rule (the factory calls the
                // same helper), so the transmission arm and the family
                // gates cannot drift from the creation-time derivation.
                context.emit(
                    `bbl::derive_material_alpha_mode(${record});`,
                );
            }
            return;
        }

        if (
            target.kind === "camera" &&
            property === "target"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "camera target",
            );
            // The program records the target the constructor gave; a later
            // write is not one of its scalar properties, so it invalidates.
            noteCameraRecordWrite(
                context,
                target,
                "target",
                undefined,
                false,
            );
            context.emit(
                `${context.requireEngine(target, expression)}.cameras[${target.cpp}.value].target = ${context.compileVec3(expression.right, "double")};`,
            );
            return;
        }

        if (target.kind === "camera") {
            const nativeProperty =
                cameraRecordField(property);
            if (nativeProperty) {
                noteCameraRecordWrite(
                    context,
                    target,
                    property,
                    expression.right,
                    expression.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken,
                );
                context.emit(
                    `${context.requireEngine(target, expression)}.cameras[${target.cpp}.value].${nativeProperty} ${operator} ${context.compileNumber(expression.right, "double")};`,
                );
                return;
            }
        }

        const direct = directPropertyAssignment(
            target,
            property,
        );
        if (direct) {
            if (!direct.supportsCompound) {
                requireSimpleAssignment(
                    context,
                    expression,
                    `${target.kind} ${property}`,
                );
            }
            const value =
                direct.valueKind === "color3"
                    ? context.compileColor3(
                          expression.right,
                      )
                    : context.compileNumber(
                          expression.right,
                      );
            context.emit(
                `${context.requireEngine(target, expression)}.${direct.collection}[${target.cpp}.value].${direct.nativeProperty} ${operator} ${value};`,
            );
            return;
        }
    }

    if (left.name.text === "loopAnimation") {
        // AnimationGroup.loopAnimation is a public field upstream, and a
        // glTF group's state lives in its asset's runtime, so the write
        // takes the same writer route the group operations take.
        const group = gltfGroupWriteTarget(
            context,
            left,
            expression,
            "loopAnimation",
        );
        context.emit(
            `bbl::set_animation_loop(${context.requireEngine(
                group,
                expression,
            )}, ${group.cpp}, ${context.compileBoolean(
                expression.right,
            )});`,
        );
        return;
    }

    if (left.name.text === "speedRatio") {
        // AnimationGroup.speedRatio is a public mutable field upstream, and
        // syncControllerFromGroup pushes it onto the controller whose tick
        // scales its delta by it. The write takes the same writer route
        // `loopAnimation` does.
        const group = gltfGroupWriteTarget(
            context,
            left,
            expression,
            "speedRatio",
        );
        context.reachFeature("animation:gltf-group-speed", left);
        context.emit(
            `bbl::set_animation_speed_ratio(${context.requireEngine(
                group,
                expression,
            )}, ${group.cpp}, ${context.compileNumber(
                expression.right,
            )});`,
        );
        return;
    }

    if (left.name.text === "mask") {
        // AnimationGroup.mask is the public field createAnimationGroupMask
        // fills. The mask value is compile-time, so the write hands its
        // names and mode to the loader's own resolver, which is where the
        // pin resolves them too -- the controller's `_setMask`.
        const group = gltfGroupWriteTarget(
            context,
            left,
            expression,
            "mask",
        );
        const mask = context.compileValue(expression.right);
        context.expectKind(
            mask,
            "animation-group-mask",
            expression.right,
        );
        const names = mask.animationGroupMask?.names ?? [];
        context.reachFeature("animation:gltf-group-mask", left);
        context.emit(
            `bbl::set_animation_mask(${context.requireEngine(
                group,
                expression,
            )}, ${group.cpp}, std::vector<std::string>{${
                names.map(stringLiteral).join(", ")
            }}, ${mask.animationGroupMask?.include ? "true" : "false"});`,
        );
        return;
    }

    if (left.name.text === "currentTime") {
        // AnimationGroup.currentTime is a public mutable field upstream
        // (src/animation/animation-group.ts): the write is the whole
        // operation, and whoever drives the group applies the pose on its
        // next tick. A glTF group's time lives in its asset's runtime, so
        // the write takes the same clip-writer route the group operations
        // and `loopAnimation` above take.
        const group = gltfGroupWriteTarget(
            context,
            left,
            expression,
            "currentTime",
        );
        const value = context.compileValue(expression.right);
        context.expectKind(value, "number", expression.right);
        context.reachFeature("animation:gltf-group-time", left);
        context.emit(
            `bbl::set_animation_current_time(${context.requireEngine(
                group,
                expression,
            )}, ${group.cpp}, ${value.cpp});`,
        );
        return;
    }

    if (
        ts.isPropertyAccessExpression(left.expression) &&
        ["position", "rotation", "scaling"].includes(
            left.expression.name.text,
        )
    ) {
        // The owner is compiled rather than looked up, so a mesh read
        // out of the data model (a handle stored in a struct or array)
        // writes its transform exactly like a mesh local.
        const mesh = context.compileValue(
            left.expression.expression,
        );
        const axis = { x: 0, y: 1, z: 2 }[
            left.name.text as "x" | "y" | "z"
        ];
        if (axis === undefined) {
            context.fail(
                left.name,
                `Unsupported rotation axis '${left.name.text}'.`,
            );
        }
        if (mesh.kind === "asset-root") {
            if (!mesh.assetRootClone) {
                context.fail(
                    left.expression.expression,
                    "Only a cloned imported root exposes a writable transform.",
                );
            }
            if (left.expression.name.text !== "position") {
                context.fail(
                    left.expression,
                    "An imported root clone currently exposes position; rotation and scaling require a retained outer matrix.",
                );
            }
            requireSimpleAssignment(
                context,
                expression,
                "imported root clone position",
            );
            context.emit(
                `bbl::set_asset_root_position_component(` +
                    `${context.requireEngine(mesh, expression)}, ` +
                    `${mesh.cpp}, ${axis}u, ` +
                    `${context.compileNumber(expression.right)});`,
            );
            return;
        }
        if (mesh.kind === "light") {
            const vector = left.expression.name.text;
            const setter = lightVectorSetter(mesh, vector);
            if (!setter) {
                context.fail(
                    left.expression,
                    `A ${mesh.lightKind ?? "generic"} light has no '${vector}' to set.`,
                );
            }
            requireSimpleAssignment(
                context,
                expression,
                `light ${vector} component`,
            );
            const engine = context.requireEngine(mesh, expression);
            const component = ["x", "y", "z"][axis]!;
            // A component store on the pin's ObservableVec3 invalidates the
            // light-local matrix just like `.set(...)`. Preserve the other
            // two live lanes, then take the same generated setter route so
            // the field write and matrix refresh cannot drift apart.
            context.emit(
                `bbl::${setter}(${engine}, ${mesh.cpp}, bbl::Vec3{` +
                    ["x", "y", "z"]
                        .map((lane) =>
                            lane === component
                                ? context.compileNumber(expression.right)
                                : `${engine}.lights[${mesh.cpp}.value].${vector}.${lane}`,
                        )
                        .join(", ") +
                    `});`,
            );
            return;
        }
        // A GaussianSplattingMesh is a SceneNode upstream, so its TRS lanes
        // are the same ones a mesh carries and `build_splat_world` composes
        // them the same way -- which is why the write is the same statement
        // over a different collection. What differs is the dirty signal: a
        // cloud's world matrix is re-derived per frame rather than cached,
        // so nothing has to be marked.
        const record = mesh.kind === "splat-mesh"
            ? { collection: "splat_meshes", bumpsTransformVersion: false }
            : { collection: "meshes", bumpsTransformVersion: true };
        if (mesh.kind === "splat-mesh") {
            // The reached slice writes a cloud's position; its rotation and
            // scaling compose in `build_splat_world` already but nothing
            // measures them, and `bakeCurrentTransformIntoVertices` is what
            // the one corpus scene writing them also needs.
            if (left.expression.name.text !== "position") {
                context.fail(
                    left.expression,
                    `A splat cloud's '${left.expression.name.text}' is not ` +
                        "lowered; the reached slice writes its position.",
                );
            }
        } else {
            context.expectKind(
                mesh,
                "mesh",
                left.expression.expression,
            );
        }
        const component = ["x", "y", "z"][axis]!;
        const engine = context.requireEngine(
            mesh,
            expression,
        );
        // A mesh's translation is kept at the pin's own width, so the
        // component spelling writes it there too: narrowing here and
        // widening back into the field would round a large-world
        // coordinate to the float32 grid, which is the whole reason the
        // field is a double.
        const wide = record.collection === "meshes" &&
            left.expression.name.text === "position";
        context.emit(
            `${engine}.${record.collection}[${mesh.cpp}.value].${left.expression.name.text}.${component} ${operator} ${
                context.compileNumber(
                    expression.right,
                    wide ? "double" : undefined,
                )
            };`,
        );
        // The transform version is what the backends gate their baked
        // vertex re-upload on (the pinned property-animation evaluator
        // bumps it the same way), so a transform written outside the
        // animation path has to mark itself dirty too.
        if (record.bumpsTransformVersion) {
            context.emit(
                `++${engine}.meshes[${mesh.cpp}.value].transform_version;`,
            );
        }
        return;
    }

    context.fail(
        left,
        `Unsupported property assignment '${left.getText()}'.`,
    );
}

function assignmentOperator(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
): "=" | "+=" | "-=" {
    switch (expression.operatorToken.kind) {
        case ts.SyntaxKind.EqualsToken:
            return "=";
        case ts.SyntaxKind.PlusEqualsToken:
            return "+=";
        case ts.SyntaxKind.MinusEqualsToken:
            return "-=";
        default:
            return context.fail(
                expression.operatorToken,
                `Unsupported assignment operator '${expression.operatorToken.getText()}'.`,
            );
    }
}

/**
 * The group a `group.<field> = …` write names, checked the four ways every
 * such write has to be: it is a group, it came from a loader rather than
 * `createPropertyAnimationGroup`, the assignment is plain, and the glTF
 * group feature is reached. Four fields lower this way -- `loopAnimation`,
 * `speedRatio`, `mask` and `currentTime` -- and the preamble is where they
 * would otherwise disagree.
 */
function gltfGroupWriteTarget(
    context: AssignmentContext,
    left: ts.PropertyAccessExpression,
    expression: ts.BinaryExpression,
    field: string,
): Value {
    const group = context.compileValue(left.expression);
    context.expectKind(group, "animation-group", left.expression);
    requireGroupSource(context, group, left, field, "gltf");
    requireSimpleAssignment(context, expression, field);
    context.reachFeature("animation:gltf-groups", left);
    return group;
}

function requireSimpleAssignment(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
    target: string,
): void {
    if (
        expression.operatorToken.kind !==
        ts.SyntaxKind.EqualsToken
    ) {
        context.fail(
            expression.operatorToken,
            `Compound assignment is not supported for ${target}.`,
        );
    }
}
import ts from "typescript";

import { emitAudioPropertyAssignment } from "./audio-surface.js";
import { TEXTURE_UV_PROPERTIES } from "../lowering/standard-uv-transform-lowerer.js";
import { requireGroupSource } from "./intrinsics/animation.js";
import { emitParticleBufferWrite } from "./particle-buffer.js";
import { staticNumberValue } from "./option-helpers.js";
import { stringLiteral } from "../cpp-literals.js";
import {
    emitDeterministicRandomInstall,
    type DeterministicRandomContext,
} from "./deterministic-random.js";
import { noteCameraRecordWrite } from "./intrinsics/camera.js";
import { cameraRecordField } from "./properties.js";
import { compileRenderTextureValue } from "./intrinsics/engine-options.js";
import { postProcessEffect } from "../post-process-effects.js";
import { toneMappingExportNames } from "../pinned-tone-mapping.js";
import { foldMaterialPluginList } from "./material-plugin.js";
import type { MaterialPluginManifest } from "../pinned-material-plugins.js";
import type {
    CompiledNodeParticles,
    Feature,
    LightKind,
    Value,
    ValueKind,
} from "./types.js";
