/**
 * The pinned geospatial (globe-orbit) camera, translated whole.
 *
 * `src/camera/geospatial-camera.ts` describes an orientation by four values
 * -- the anchored ECEF `center`, `yaw`, `pitch` and `radius` -- and derives
 * `_lookAt`, `upVector` and `position` from them through six small helpers.
 * None of that arithmetic is restated here: every function below comes from
 * its own pinned declaration through `PinnedNumericLowerer`, and this module
 * owns only the storage the values land on (the `CameraRecord` fields) and
 * the C++ signatures the pin's closures do not have.
 *
 * The one seam is the closure. `applyOrientation` is declared inside
 * `createGeospatialCamera` and reads the factory's own `center`, `scalars`,
 * `limits`, `lookAt`, `upVector` and `position` locals; the native camera
 * keeps those on `CameraRecord`, so each is bound by the source text the
 * pinned body reads it through and the body translates unchanged.
 */
import ts from "typescript";
import type { LoweringContext, LoweredSource } from "./context.js";
import {
    lowerPinnedFunction,
    lowerPinnedFunctionParts,
    type PinnedFunctionParameter,
} from "./pinned-function-lowerer.js";
import {
    PinnedNumericLowerer,
    recordLiteralCpp,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCallsWithHypot } from "./pinned-operators.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";

const CAMERA = "src/camera/geospatial-camera.ts";
const LIMITS = "src/camera/geospatial-limits.ts";

/** The C++ name each pinned helper is emitted under, in one place. */
const CPP_NAMES = {
    normalizeRadians: "geospatial_normalize_radians",
    clamp: "geospatial_clamp",
    cross: "geospatial_cross",
    lengthSq: "geospatial_length_sq",
    normalizeInPlace: "geospatial_normalize_in_place",
    computeLocalBasis: "geospatial_local_basis",
    computeLookAtFromYawPitch: "geospatial_look_at_from_yaw_pitch",
    clampCenterFromPoles: "geospatial_clamp_center_from_poles",
    getEffectivePitchMax: "geospatial_effective_pitch_max",
    createGeospatialLimits: "geospatial_create_limits",
} as const;

/**
 * The eight fields `GeospatialLimits` carries, as the pin spells them and as
 * the record stores them. One table, so the factory's return, the clamps in
 * `applyOrientation` and `getEffectivePitchMax`'s own reads cannot disagree
 * about which native member a pinned name resolves to.
 */
const LIMIT_FIELDS: ReadonlyArray<readonly [string, string]> = [
    ["planetRadius", "planet_radius"],
    ["radiusMin", "radius_min"],
    ["radiusMax", "radius_max"],
    ["pitchMin", "pitch_min"],
    ["pitchMax", "pitch_max"],
    ["yawMin", "yaw_min"],
    ["yawMax", "yaw_max"],
];

const SCALE_FIELD = "pitchDisabledRadiusScale";

export class GeospatialCameraLowerer {
    public constructor(private readonly context: LoweringContext) {}

    private readonly calls = pinnedNumericMathCallsWithHypot();

    /** `{x, y, z}` and `{x, y}` as the two records this port stores them in. */
    private readonly recordLiteral = (
        type: string,
        components: readonly string[],
    ): string =>
        type === "vec2"
            ? `GeospatialScale{${components.join(", ")}}`
            : recordLiteralCpp(type, components);

    /**
     * The same spelling the DECLARATION path asks for.
     *
     * `const horiz = { x: ..., y: ..., z: ... }` inside applyOrientation is a
     * record local, and the translator recognises one by this hook rather
     * than by the expression hook above; both are supplied so a literal in
     * either position lands on the same storage.
     */
    private readonly vec3Literal = (
        x: string,
        y: string,
        z: string,
    ): string => `Vec3d{${x}, ${y}, ${z}}`;

    private vector(cpp: string): PinnedBinding {
        return { cpp, type: "vec3" };
    }

    private scalar(cpp: string): PinnedBinding {
        return { cpp, type: "scalar" };
    }

    /** A pinned `Vec3` parameter, read-only or written through. */
    private vec3Parameter(
        pinned: string,
        cpp: string,
        mutable = false,
    ): PinnedFunctionParameter {
        return {
            pinned,
            kind: "record",
            cpp,
            cppType: "Vec3d",
            annotation: "Vec3",
            binding: this.vector(cpp),
            ...(mutable ? { mutableRecord: true as const } : {}),
        };
    }

    private numberParameter(
        pinned: string,
        cpp = pinned,
    ): PinnedFunctionParameter {
        return { pinned, kind: "number", cpp };
    }

    /** `GEO_EPSILON`, read off its own pinned declaration. */
    private geoEpsilon(): number {
        const file = this.context.sourceFile(LIMITS);
        return this.context.numericValue(
            this.context.variableInitializer(file, "GEO_EPSILON"),
            file,
        );
    }

    /**
     * The bindings a body reads the shared constants through.
     *
     * `TWO_PI`, `WORLD_NORTH`, `WORLD_RIGHT` and `POLE_SINE_LIMIT` are
     * declared by the camera module itself, so the translator resolves them
     * off their own declarations; only `GEO_EPSILON` (imported from the
     * limits module) and `Math.PI` have to be supplied.
     */
    private constantBindings(): Array<[string, PinnedBinding]> {
        return [
            ["Math.PI", this.scalar("pi_double")],
            [
                "GEO_EPSILON",
                {
                    ...this.scalar(
                        this.context.doubleLiteral(this.geoEpsilon()),
                    ),
                    staticNumber: this.geoEpsilon(),
                },
            ],
        ];
    }

    /**
     * The three small vector helpers the pinned module keeps private, plus
     * the two angle helpers. Each is its own pinned declaration; only the
     * C++ name and the reference-ness of a written parameter are this
     * port's.
     */
    private lowerVectorHelpers(): string {
        const cross = lowerPinnedFunction(
            this.context,
            CAMERA,
            "cross",
            [
                this.vec3Parameter("a", "a"),
                this.vec3Parameter("b", "b"),
                this.vec3Parameter("out", "out", true),
            ],
            {
                cppName: CPP_NAMES.cross,
                returns: "void",
                calls: this.calls,
            },
        );
        const lengthSq = lowerPinnedFunction(
            this.context,
            CAMERA,
            "lengthSq",
            [this.vec3Parameter("v", "v")],
            {
                cppName: CPP_NAMES.lengthSq,
                returns: "double",
                calls: this.calls,
            },
        );
        // The pin returns the vector it normalized, and two callers read
        // that return (`computeLookAtFromYawPitch` returns it onward). A
        // reference return is the same object identity JavaScript hands
        // back.
        const normalize = lowerPinnedFunction(
            this.context,
            CAMERA,
            "normalizeInPlace",
            [this.vec3Parameter("v", "v", true)],
            {
                cppName: CPP_NAMES.normalizeInPlace,
                returns: {
                    type: "Vec3d&",
                    value: (lowerer, expression) =>
                        lowerer.expression(expression!),
                },
                calls: this.calls,
            },
        );
        const normalizeRadians = lowerPinnedFunction(
            this.context,
            CAMERA,
            "normalizeRadians",
            [this.numberParameter("angle")],
            {
                cppName: CPP_NAMES.normalizeRadians,
                returns: "double",
                calls: this.calls,
                memberBindings: new Map(this.constantBindings()),
            },
        );
        const clamp = lowerPinnedFunction(
            this.context,
            CAMERA,
            "clamp",
            [
                this.numberParameter("v"),
                // `min`/`max` are Windows macro names, the same reason the
                // pinned projection writers rename `near`/`far`.
                this.numberParameter("min", "minimum"),
                this.numberParameter("max", "maximum"),
            ],
            {
                cppName: CPP_NAMES.clamp,
                returns: "double",
                calls: this.calls,
            },
        );
        return [cross, lengthSq, normalize, normalizeRadians, clamp].join(
            "\n\n",
        );
    }

    /** The pinned callee spellings every geospatial body shares. */
    private helperCalls(): Map<string, (args: readonly string[]) => string> {
        const calls = new Map(this.calls);
        for (const [pinned, cpp] of Object.entries(CPP_NAMES)) {
            calls.set(pinned, (args) => `${cpp}(${args.join(", ")})`);
        }
        return calls;
    }

    /**
     * `computeLocalBasis`: the east/north/up tangent frame at a point on the
     * globe. Three of its four parameters are written through.
     */
    private lowerLocalBasis(): string {
        return lowerPinnedFunction(
            this.context,
            CAMERA,
            "computeLocalBasis",
            [
                this.vec3Parameter("worldPos", "worldPos"),
                this.vec3Parameter("refEast", "refEast", true),
                this.vec3Parameter("refNorth", "refNorth", true),
                this.vec3Parameter("refUp", "refUp", true),
            ],
            {
                cppName: CPP_NAMES.computeLocalBasis,
                returns: "void",
                calls: this.helperCalls(),
                recordLiteral: this.recordLiteral,
                memberBindings: new Map(this.constantBindings()),
            },
        );
    }

    /**
     * A pinned body whose `const scratch = { x: 0, y: 0, z: 0 }` locals are
     * handed to helpers that WRITE them.
     *
     * A JavaScript `const` freezes the binding, not the object, so those
     * locals are mutable storage. They are bound ahead of the body -- which
     * is what makes the pin's own declaration statements resolved rather
     * than re-emitted -- and declared here from the pin's OWN initializer,
     * so the zero the scratch starts at is still read off the pinned
     * source.
     */
    private scratchRecords(
        declaration: ts.Node,
        names: readonly string[],
        bindings: Map<string, PinnedBinding>,
        indent = "    ",
    ): string {
        for (const name of names) {
            bindings.set(name, this.vector(name));
        }
        const lowerer = new PinnedNumericLowerer(
            declaration.getSourceFile(),
            {
                bindings: new Map(),
                calls: new Map(),
                recordLiteral: this.recordLiteral,
                vec3Literal: this.vec3Literal,
            },
        );
        return names
            .map((name) => {
                const initializer = this.context.variableInitializer(
                    declaration,
                    name,
                );
                const literal = this.context.unwrapExpression(initializer);
                if (!ts.isObjectLiteralExpression(literal)) {
                    this.context.contractError(
                        initializer,
                        `Expected pinned '${name}' to be a record literal.`,
                    );
                }
                return `${indent}Vec3d ${name} = ${lowerer.expression(literal)};`;
            })
            .join("\n");
    }

    /** `computeLookAtFromYawPitch`: the forward yaw/pitch formula. */
    private lowerLookAtFromYawPitch(): string {
        const { declaration } = this.context.functionDeclaration(
            CAMERA,
            "computeLookAtFromYawPitch",
        );
        const bindings = new Map(this.constantBindings());
        const scratch = this.scratchRecords(
            declaration,
            ["east", "north", "up"],
            bindings,
        );
        const parts = lowerPinnedFunctionParts(
            this.context,
            CAMERA,
            "computeLookAtFromYawPitch",
            [
                this.numberParameter("yaw"),
                this.numberParameter("pitch"),
                this.vec3Parameter("center", "center"),
                this.vec3Parameter("result", "result", true),
            ],
            {
                cppName: CPP_NAMES.computeLookAtFromYawPitch,
                returns: {
                    type: "Vec3d&",
                    value: (lowerer, expression) =>
                        lowerer.expression(expression!),
                },
                calls: this.helperCalls(),
                recordLiteral: this.recordLiteral,
                memberBindings: bindings,
            },
        );
        return (
            `// ${parts.provenance}\n${parts.declaration} {\n` +
            `${scratch}\n${parts.body}\n}`
        );
    }

    /** `clampCenterFromPoles`: keeps the tangent basis well defined. */
    private lowerClampCenterFromPoles(): string {
        return lowerPinnedFunction(
            this.context,
            CAMERA,
            "clampCenterFromPoles",
            [this.vec3Parameter("center", "center", true)],
            {
                cppName: CPP_NAMES.clampCenterFromPoles,
                returns: {
                    type: "Vec3d&",
                    value: (lowerer, expression) =>
                        lowerer.expression(expression!),
                },
                calls: this.helperCalls(),
                recordLiteral: this.recordLiteral,
                memberBindings: new Map(this.constantBindings()),
            },
        );
    }

    /**
     * The limits record's members, bound by the source text a pinned body
     * reads them through, for a caller that named the record `limits`.
     */
    private limitBindings(cpp: string): Array<[string, PinnedBinding]> {
        return LIMIT_FIELDS.map(
            ([pinned, member]): [string, PinnedBinding] => [
                `limits.${pinned}`,
                this.scalar(`${cpp}.${member}`),
            ],
        );
    }

    /**
     * `getEffectivePitchMax`: pitch interpolated away as the camera zooms
     * out. Its `const scale = limits.pitchDisabledRadiusScale` is the pin's
     * nullable record, so the local binds to the optional the record stores
     * it in and `!scale` becomes that optional's own absence test.
     */
    private lowerEffectivePitchMax(): string {
        const scale = "limits.pitch_disabled_radius_scale";
        const bindings = new Map<string, PinnedBinding>([
            ...this.constantBindings(),
            ...this.limitBindings("limits"),
            [
                "scale",
                {
                    cpp: `(*${scale})`,
                    type: "opaque",
                    absentCpp: `!${scale}.has_value()`,
                },
            ],
            ["scale.x", this.scalar(`${scale}->x`)],
            ["scale.y", this.scalar(`${scale}->y`)],
        ]);
        return lowerPinnedFunction(
            this.context,
            LIMITS,
            "getEffectivePitchMax",
            [
                {
                    pinned: "limits",
                    kind: "record",
                    cpp: "limits",
                    cppType: "GeospatialLimits",
                    annotation: "GeospatialLimits",
                    binding: { cpp: "limits", type: "opaque" },
                },
                this.numberParameter("currentRadius"),
            ],
            {
                cppName: CPP_NAMES.getEffectivePitchMax,
                returns: "double",
                calls: this.helperCalls(),
                memberBindings: bindings,
            },
        );
    }

    /**
     * `createGeospatialLimits`: the pinned defaults for a planet of a given
     * radius. Every field comes from the factory's own returned literal,
     * including the two infinite yaw bounds and the nullable pitch-disable
     * scale, so none of the numbers is retyped here.
     */
    private lowerLimitsFactory(): string {
        const { file, declaration } = this.context.functionDeclaration(
            LIMITS,
            "createGeospatialLimits",
        );
        if (
            declaration.parameters.length !== 1 ||
            !ts.isIdentifier(declaration.parameters[0]!.name) ||
            declaration.parameters[0]!.name.text !== "planetRadius" ||
            declaration.parameters[0]!.type?.getText(file) !== "number"
        ) {
            this.context.contractError(
                declaration,
                "Expected createGeospatialLimits(planetRadius: number).",
            );
        }
        const returned = this.context.returnObject(declaration);
        const lowerer = new PinnedNumericLowerer(file, {
            bindings: new Map([
                ...this.constantBindings(),
                ["planetRadius", this.scalar("planetRadius")],
            ]),
            calls: this.helperCalls(),
            recordLiteral: this.recordLiteral,
            vec3Literal: this.vec3Literal,
        });
        const assignments = LIMIT_FIELDS.map(
            ([pinned, member]) =>
                `    limits.${member} = ` +
                `${lowerer.expression(
                    this.context.propertyInitializer(returned, pinned),
                )};`,
        );
        const scaleInitializer = this.context.unwrapExpression(
            this.context.propertyInitializer(returned, SCALE_FIELD),
        );
        // The pin's default is a record; `null` there is the documented
        // "full pitch at every radius" arm. Both spellings are accepted so
        // the port stays a translation of whichever the pin states.
        const scale =
            scaleInitializer.kind === ts.SyntaxKind.NullKeyword
                ? "std::nullopt"
                : lowerer.expression(scaleInitializer);
        assignments.push(
            `    limits.pitch_disabled_radius_scale = ${scale};`,
        );
        return (
            `// ${this.context.provenance(
                LIMITS,
                "createGeospatialLimits",
            )}\n` +
            `GeospatialLimits ${CPP_NAMES.createGeospatialLimits}(\n` +
            `    double planetRadius) {\n` +
            `    GeospatialLimits limits;\n` +
            `${assignments.join("\n")}\n` +
            `    return limits;\n}`
        );
    }

    /**
     * The factory's closure locals, as the record members they land on.
     *
     * `createGeospatialCamera` keeps `center`, `scalars`, `limits`,
     * `lookAt`, `upVector` and `position` as locals its nested
     * `applyOrientation` closes over; the native camera keeps every one of
     * them on `CameraRecord`, so each pinned spelling binds to its member
     * and the body translates with no rewriting.
     */
    private closureBindings(): Map<string, PinnedBinding> {
        return new Map<string, PinnedBinding>([
            ...this.constantBindings(),
            ...this.limitBindings("camera.limits"),
            ["limits", { cpp: "camera.limits", type: "opaque" }],
            ["center", this.vector("camera.center")],
            ["lookAt", this.vector("camera.look_at")],
            ["upVector", this.vector("camera.up_vector")],
            ["position", this.vector("camera.position")],
            ["scalars.yaw", this.scalar("camera.yaw")],
            ["scalars.pitch", this.scalar("camera.pitch")],
            ["scalars.radius", this.scalar("camera.radius")],
        ]);
    }

    /**
     * The world matrix the pinned factory writes, as the record's own
     * `target`.
     *
     * `cameraLocalWorldMatrix` looks from `position` towards
     * `position + lookAt` with the derived `upVector`, which is exactly the
     * eye/target/up triple `camera_world_matrix` composes. `position` and
     * `lookAt` change only in `applyOrientation`, so the pin's own `center3`
     * literal is lowered once and stored where they are written -- the same
     * value the pin would recompute on every `getWorldMatrix`.
     */
    private lookAtTarget(): string {
        const { file, declaration } = this.context.functionDeclaration(
            CAMERA,
            "createGeospatialCamera",
        );
        const local = this.context.findNodes(
            declaration,
            (node): node is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(node) &&
                node.name?.text === "cameraLocalWorldMatrix",
        )[0];
        if (!local?.body) {
            this.context.contractError(
                declaration,
                "Expected createGeospatialCamera to declare cameraLocalWorldMatrix.",
            );
        }
        const writer = this.context.callExpression(
            local,
            "mat4LookAtWorldLHToRef",
        );
        if (writer.arguments.length !== 4) {
            this.context.contractError(
                writer,
                "Expected the geospatial look-at writer to take four arguments.",
            );
        }
        // The first argument is the factory's own scratch matrix; the three
        // that decide what the matrix looks at are asserted by name, because
        // `camera.target` below stands in for the middle one.
        ["position", "center3", "upVector"].forEach((expected, index) => {
            this.context.assertExpressionShape(
                writer.arguments[index + 1]!,
                expected,
                `Geospatial look-at argument ${index + 1}`,
            );
        });
        const lowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                ["position", this.vector("camera.position")],
                ["lookAt", this.vector("camera.look_at")],
            ]),
            calls: new Map(),
            recordLiteral: this.recordLiteral,
        });
        const center3 = this.context.unwrapExpression(
            this.context.variableInitializer(local, "center3"),
        );
        return lowerer.expression(center3);
    }

    /**
     * `applyOrientation`, the factory's own recompute.
     *
     * Its four scratch records are handed to helpers that write them, so
     * they bind ahead of the body the way `computeLookAtFromYawPitch`'s do.
     * `wm.markLocalDirty()` is the pin's "the world matrix must be rebuilt";
     * the native world matrix is composed from the record every frame, and
     * the one value the pin's local-matrix writer derives that the record
     * does not already carry is `center3`, so the mark is where it lands.
     */
    private lowerApplyOrientation(): string {
        const { file, declaration } = this.context.functionDeclaration(
            CAMERA,
            "createGeospatialCamera",
        );
        const apply = this.context.findNodes(
            declaration,
            (node): node is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(node) &&
                node.name?.text === "applyOrientation",
        )[0];
        if (!apply?.body) {
            this.context.contractError(
                declaration,
                "Expected createGeospatialCamera to declare applyOrientation.",
            );
        }
        const names = ["yaw", "pitch", "radius", "newCenter"];
        if (
            apply.parameters.length !== names.length ||
            !apply.parameters.every(
                (parameter, index) =>
                    ts.isIdentifier(parameter.name) &&
                    parameter.name.text === names[index],
            )
        ) {
            this.context.contractError(
                apply,
                "Expected applyOrientation(yaw, pitch, radius, newCenter).",
            );
        }
        const bindings = this.closureBindings();
        for (const name of ["yaw", "pitch", "radius"]) {
            bindings.set(name, this.scalar(name));
        }
        bindings.set("newCenter", this.vector("newCenter"));
        const scratch = this.scratchRecords(
            apply,
            ["east", "north", "up", "right"],
            bindings,
        );
        const target = this.lookAtTarget();
        const calls = this.helperCalls();
        calls.set(
            "wm.markLocalDirty",
            () => `camera.target = ${target}`,
        );

        const body = lowerPinnedBody(file, apply.body.statements, {
            bindings,
            calls,
            recordLiteral: this.recordLiteral,
            vec3Literal: this.vec3Literal,
        });
        return (
            `// ${this.context.provenance(
                CAMERA,
                "createGeospatialCamera",
                "its applyOrientation closure",
            )}\n` +
            `void geospatial_apply_orientation(\n` +
            `    CameraRecord& camera,\n` +
            `    double yaw,\n` +
            `    double pitch,\n` +
            `    double radius,\n` +
            `    const Vec3d& newCenter) {\n` +
            `${scratch}\n${body}\n}`
        );
    }

    /**
     * The factory's resting pose: the pinned tail of
     * `createGeospatialCamera`, which seeds `center` and then applies the
     * orientation the camera comes up in.
     */
    private lowerFactory(): string {
        const { file, declaration } = this.context.functionDeclaration(
            CAMERA,
            "createGeospatialCamera",
        );
        const center = this.context.unwrapExpression(
            this.context.variableInitializer(declaration, "center"),
        );
        const restingRadius = this.context.variableInitializer(
            declaration,
            "restingRadius",
        );
        // The factory calls `applyOrientation` from each of its setters as
        // well as once at the end for the resting pose; the seed is the one
        // that names `restingRadius`, and exactly one call may.
        const seeds = this.context
            .findNodes(
                declaration,
                (node): node is ts.CallExpression =>
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "applyOrientation",
            )
            .filter((call) =>
                this.context.expressionMatchesShape(
                    call,
                    "applyOrientation(0, 0, restingRadius, center)",
                ),
            );
        if (seeds.length !== 1) {
            this.context.contractError(
                declaration,
                "Expected one geospatial resting-pose seed.",
            );
        }
        const camera = this.context.objectInitializer(declaration, "cam");
        const scalar = (name: string): string =>
            this.context.doubleLiteral(
                this.context.numericValue(
                    this.context.propertyInitializer(camera, name),
                    file,
                ),
            );
        const lowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                ...this.constantBindings(),
                ...this.limitBindings("camera.limits"),
                ["options.planetRadius", this.scalar("planetRadius")],
            ]),
            calls: this.helperCalls(),
            recordLiteral: this.recordLiteral,
            vec3Literal: this.vec3Literal,
        });
        // `farPlane: options.planetRadius * 16` is a value the pinned
        // literal computes from the factory's own argument, so it is
        // lowered rather than read as a number the way fov/nearPlane are.
        const farPlane = lowerer.expression(
            this.context.propertyInitializer(camera, "farPlane"),
        );
        return `// ${this.context.provenance(CAMERA, "createGeospatialCamera")}
CameraHandle create_geospatial_camera(
    Engine& engine,
    double planetRadius) {
    CameraRecord camera;
    camera.kind = CameraKind::geospatial;
    camera.limits = upstream::${CPP_NAMES.createGeospatialLimits}(planetRadius);
    camera.center = ${lowerer.expression(center)};
    camera.fov = ${scalar("fov")};
    camera.near_plane = ${scalar("nearPlane")};
    camera.far_plane = ${farPlane};
    const double restingRadius = ${lowerer.expression(restingRadius)};
    upstream::geospatial_apply_orientation(
        camera, 0.0, 0.0, restingRadius, camera.center);
    engine.cameras.push_back(camera);
    return CameraHandle{
        static_cast<std::uint32_t>(engine.cameras.size() - 1)};
}`;
    }

    /**
     * `setGeospatialOrientation`: four optional fields, each falling back to
     * the camera's live value. The pin's own `??` chain is what decides the
     * fallback, so the four arms are lowered from that one call rather than
     * restated; the caller passes a present mask and the absent lanes read
     * the record.
     */
    private lowerSetOrientation(): string {
        const { file, declaration } = this.context.functionDeclaration(
            CAMERA,
            "setGeospatialOrientation",
        );
        const call = this.context.callExpression(
            declaration,
            "_setOrientation",
        );
        const fields: ReadonlyArray<readonly [string, string, string]> = [
            ["yaw", "camera.yaw", "yaw"],
            ["pitch", "camera.pitch", "pitch"],
            ["radius", "camera.radius", "radius"],
            ["center", "camera.center", "center"],
        ];
        if (call.arguments.length !== fields.length) {
            this.context.contractError(
                call,
                "Expected setGeospatialOrientation to pass four fields.",
            );
        }
        fields.forEach(([field], index) => {
            this.context.assertExpressionShape(
                call.arguments[index]!,
                `orientation.${field} ?? camera.${field}`,
                `Geospatial orientation fallback ${index}`,
            );
        });
        const lowered = fields.map(([field, live, argument], index) => {
            const lowerer = new PinnedNumericLowerer(file, {
                bindings: new Map<string, PinnedBinding>([
                    [
                        `orientation.${field}`,
                        field === "center"
                            ? this.vector(argument)
                            : this.scalar(argument),
                    ],
                    [`camera.${field}`,
                        field === "center"
                            ? this.vector(live)
                            : this.scalar(live)],
                ]),
                calls: new Map(),
                recordLiteral: this.recordLiteral,
            });
            const present = `(present_mask & (1u << ${index}u)) != 0u`;
            return (
                `    const auto resolved_${field} = ${present}\n` +
                `        ? ${lowerer.expression(call.arguments[index]!)}\n` +
                `        : ${live};`
            );
        });
        return `// ${this.context.provenance(CAMERA, "setGeospatialOrientation")}
void set_geospatial_orientation(
    Engine& engine,
    CameraHandle handle,
    std::uint32_t present_mask,
    double yaw,
    double pitch,
    double radius,
    const Vec3d& center) {
    if (handle.value >= engine.cameras.size()) {
        throw std::runtime_error("Invalid camera handle.");
    }
    CameraRecord& camera = engine.cameras[handle.value];
${lowered.join("\n")}
    upstream::geospatial_apply_orientation(
        camera,
        resolved_yaw,
        resolved_pitch,
        resolved_radius,
        resolved_center);
}`;
    }

    public lower(): LoweredSource {
        const modulePath = CAMERA;
        const symbolName = "createGeospatialCamera";
        return {
            modulePath,
            symbolName,
            header: `#pragma once

#include <bblite/runtime.hpp>

namespace bbl::upstream {

// The pinned orientation recompute (createGeospatialCamera's
// applyOrientation), driven by the factory, the orientation setter and the
// control surface alike -- the pin's own single entry point for every
// change to yaw, pitch, radius or centre.
void geospatial_apply_orientation(
    CameraRecord& camera,
    double yaw,
    double pitch,
    double radius,
    const Vec3d& newCenter);

// The tangent frame at a point on the globe, and the effective pitch
// ceiling at a radius: both are pinned exports the control surface reads
// as well as the recompute above.
void ${CPP_NAMES.computeLocalBasis}(
    const Vec3d& worldPos,
    Vec3d& refEast,
    Vec3d& refNorth,
    Vec3d& refUp);
double ${CPP_NAMES.getEffectivePitchMax}(
    const GeospatialLimits& limits,
    double currentRadius);

} // namespace bbl::upstream

namespace bbl {

CameraHandle create_geospatial_camera(Engine& engine, double planetRadius);
void set_geospatial_orientation(
    Engine& engine,
    CameraHandle handle,
    std::uint32_t present_mask,
    double yaw,
    double pitch,
    double radius,
    const Vec3d& center);

} // namespace bbl
`,
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/upstream/camera_geospatial.hpp>
#include <bblite/js_data.hpp>

#include <cmath>
#include <limits>
#include <optional>
#include <stdexcept>

namespace bbl::upstream {
namespace {

${this.lowerVectorHelpers()}

${this.lowerLimitsFactory()}

} // namespace

${this.lowerEffectivePitchMax()}

namespace {

${this.lowerClampCenterFromPoles()}

} // namespace

${this.lowerLocalBasis()}

namespace {

${this.lowerLookAtFromYawPitch()}

} // namespace

${this.lowerApplyOrientation()}

} // namespace bbl::upstream

namespace bbl {

${this.lowerFactory()}

${this.lowerSetOrientation()}

} // namespace bbl
`,
        };
    }
}
