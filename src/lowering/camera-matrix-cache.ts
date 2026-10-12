import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    lowerPinnedFunction,
    lowerPinnedFunctionParts,
    type PinnedFunctionParameter,
} from "./pinned-function-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { CameraLowerer } from "./camera-lowerer.js";
import { cameraChangeKeyHeader } from "./camera-change-key-lowerer.js";

/** Camera-owned F32 caches; GPU consumers copy only at their upload boundary. */
export function lowerCameraMatrixCaches(
    context: LoweringContext,
    orthographic: boolean,
): string {
    const module = "src/camera/camera.ts";
    const allocator = context.functionDeclaration(
        "src/math/_matrix-allocator.ts",
        "_defaultAllocate",
    ).declaration;
    context.assertStatementShapes(
        allocator,
        allocator.body!.statements,
        "return new F32(16) as unknown as Mat4;",
        "Default camera matrix allocation",
    );
    for (const [factoryModule, name] of [
        ["src/camera/arc-rotate.ts", "createArcRotateCamera"],
        ["src/camera/free-camera.ts", "_createFreeCamera"],
    ]) {
        const factory = context.functionDeclaration(
            factoryModule!,
            name!,
        ).declaration;
        const camera = context.objectInitializer(factory, "cam");
        for (const cache of ["_viewCache", "_projCache", "_vpCache"])
            context.assertExpressionShape(
                context.propertyInitializer(camera, cache),
                "allocateMat4()",
                "Camera-owned cache allocation",
            );
        for (const stamp of [
            "_viewVer",
            "_projVer",
            "_projAspect",
            "_vpVer",
            "_vpAspect",
        ])
            if (
                camera.properties.some(
                    (property) => property.name?.getText() === stamp,
                )
            )
                context.contractError(
                    camera,
                    `Expected initially absent camera stamp '${stamp}'.`,
                );
    }
    const matrix = (
        pinned: string,
        mutable = false,
    ): PinnedFunctionParameter => ({
        pinned,
        kind: "mat4",
        cpp: pinned,
        cppType: "js::F32Array",
        mutableRecord: mutable,
    });
    const writer = (
        name: string,
        symbol: string,
        parameters: PinnedFunctionParameter[],
    ): string =>
        lowerPinnedFunction(
            context,
            `src/math/${name}.ts`,
            symbol,
            parameters,
            {
                cppName: `cached_${name.replaceAll("-", "_")}`,
                returns: "void",
                calls: new Map(),
            },
        );
    const scalar = (pinned: string): PinnedFunctionParameter => ({
        pinned,
        kind: "number",
        cpp: pinned === "near" || pinned === "far" ? `${pinned}_plane` : pinned,
    });
    const perspective = writer(
        "write-perspective-mat4-lh-into-buffer",
        "writePerspectiveMat4LHIntoBuffer",
        [matrix("out", true), ...["fov", "aspect", "near", "far"].map(scalar)],
    );
    const ortho = orthographic
        ? writer(
              "write-ortho-off-center-mat4-lh-into-buffer",
              "writeOrthoOffCenterMat4LHIntoBuffer",
              [
                  matrix("out", true),
                  ...["left", "right", "bottom", "top", "near", "far"].map(
                      scalar,
                  ),
              ],
          )
        : "";
    const multiply = lowerPinnedFunction(
        context,
        "src/math/multiply-mat4-into-buffer.ts",
        "multiplyMat4IntoBuffer",
        [
            matrix("dst", true),
            { pinned: "d", kind: "index", cpp: "d" },
            matrix("a"),
            { pinned: "i", kind: "index", cpp: "i" },
            matrix("b"),
            { pinned: "j", kind: "index", cpp: "j" },
        ],
        { cppName: "cached_multiply_mat4", returns: "void" },
    );
    const bindings = new Map<string, PinnedBinding>();
    for (const [pinned, cpp] of [
        ["worldMatrixVersion", "world_matrix_version"],
        ["_viewVer", "view_cache_version"],
        ["_projVer", "projection_cache_version"],
        ["_projAspect", "projection_cache_aspect"],
        ["_vpVer", "view_projection_cache_version"],
        ["_vpAspect", "view_projection_cache_aspect"],
        ["fov", "fov"],
        ["nearPlane", "near_plane"],
        ["farPlane", "far_plane"],
    ])
        bindings.set(`camera.${pinned}`, {
            cpp: `camera.${cpp}`,
            type: "scalar",
        });
    const caches = [
        ["_viewCache", "view_cache", "v"],
        ["_projCache", "projection_cache", "p"],
        ["_vpCache", "view_projection_cache", "vp"],
    ] as const;
    for (const [member, cpp, alias] of caches)
        for (const key of [`camera.${member}`, alias])
            bindings.set(key, { cpp: `(*camera.${cpp})`, type: "f32" });
    bindings.set("w", { cpp: "world", type: "f32" });
    bindings.set("camera._useFloatingOrigin", { cpp: "false", type: "bool" });
    bindings.set("camera.ortho", { cpp: "camera.orthographic", type: "bool" });
    const calls = new Map<string, (args: readonly string[]) => string>([
        [
            "_cameraChangeKey",
            (args) => `scene_camera_change_key(${args.join(", ")})`,
        ],
        [
            "getViewMatrix",
            (args) => `get_camera_view_matrix(${args.join(", ")})`,
        ],
        [
            "getProjectionMatrix",
            (args) => `get_camera_projection_matrix(${args.join(", ")})`,
        ],
        [
            "multiplyMat4IntoBuffer",
            (args) =>
                `cached_multiply_mat4(${args.map((argument, index) => (index % 2 ? `static_cast<std::int64_t>(${argument})` : argument)).join(", ")})`,
        ],
        [
            "writePerspectiveMat4LHIntoBuffer",
            (args) =>
                `cached_write_perspective_mat4_lh_into_buffer(${args.join(", ")})`,
        ],
        [
            "_orthoProjector",
            (args) => `write_cached_orthographic(${args.join(", ")})`,
        ],
    ]);
    const getters = [
        ["getViewMatrix", "get_camera_view_matrix", "view_cache"],
        [
            "getProjectionMatrix",
            "get_camera_projection_matrix",
            "projection_cache",
        ],
        [
            "getViewProjectionMatrix",
            "get_camera_view_projection_matrix",
            "view_projection_cache",
        ],
    ] as const;
    const functions = getters.map(([pinned, cpp, cache]) => {
        const parts = lowerPinnedFunctionParts(
            context,
            module,
            pinned,
            [
                {
                    pinned: "camera",
                    kind: "record",
                    annotation: "Camera",
                    cpp: "camera",
                    cppType: "CameraRecord",
                },
                ...(pinned === "getViewMatrix" ? [] : [scalar("aspectRatio")]),
            ],
            {
                cppName: cpp,
                memberBindings: bindings,
                calls,
                callShapes: new Map([["_cameraChangeKey", "scalar"]]),
                returns: {
                    type: "js::F32Array",
                    value(lowerer, expression) {
                        if (!expression)
                            return context.contractError(
                                context.sourceFile(module),
                                "Expected a camera matrix cache return.",
                            );
                        return lowerer.expression(expression);
                    },
                },
                expression(node) {
                    if (
                        context.expressionMatchesShape(
                            node,
                            "_orthoProjector !== null",
                        )
                    )
                        return orthographic ? "true" : "false";
                    return undefined;
                },
                statement(node, _lowerer, indent) {
                    if (
                        !ts.isVariableStatement(node) ||
                        node.declarationList.declarations.length !== 1
                    )
                        return undefined;
                    const declaration = node.declarationList.declarations[0]!;
                    if (
                        !ts.isIdentifier(declaration.name) ||
                        !declaration.initializer
                    )
                        return undefined;
                    const alias = caches.find(
                        (entry) => entry[2] === declaration.name.getText(),
                    );
                    if (alias) {
                        context.assertExpressionShape(
                            declaration.initializer,
                            `camera.${alias[0]}`,
                            "Camera cache storage alias",
                        );
                        return [];
                    }
                    if (declaration.name.text === "w") {
                        context.assertExpressionShape(
                            declaration.initializer,
                            "camera.worldMatrix",
                            "Camera world matrix read",
                        );
                        return [
                            `${indent}const auto world = camera_world_matrix(camera);`,
                        ];
                    }
                    return undefined;
                },
            },
        );
        return `// ${parts.provenance}\n${parts.declaration} {\n    if (camera.has_parent_world || camera.kind == CameraKind::geospatial) throw std::runtime_error("Camera matrix caches require unparented ArcRotate or Free cameras.");\n    if (!camera.${cache}) camera.${cache}.emplace(16u);\n${parts.body}\n}`;
    });
    const orthographicBody = orthographic
        ? `void write_cached_orthographic(const CameraRecord& camera, double aspect, js::F32Array& projection) {\n${new CameraLowerer(context).lowerOrthographicProjection("cached_write_ortho_off_center_mat4_lh_into_buffer")}\n}`
        : 'void write_cached_orthographic(const CameraRecord&, double, js::F32Array&) { throw std::runtime_error("Orthographic camera projection was not reached."); }';
    return `${cameraChangeKeyHeader(context)}\nnamespace bbl::upstream {\n${perspective}\n${ortho}\n${multiply}\n${orthographicBody}\n${functions.join("\n\n")}\n} // namespace bbl::upstream\n`;
}
