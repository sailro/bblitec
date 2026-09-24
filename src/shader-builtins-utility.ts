/**
 * Utility WGSL. The copy blit is the pin's copy-task shader, executed;
 * the pin's own utility passes are deployed whole by
 * `pinned-utility-passes.ts`. The depth-only fragment and the diagnostic
 * id/cluster fragments are project-owned tooling with no pinned
 * counterpart and stay written here.
 */
import ts from "typescript";
import { LoweringContext } from "./lowering/context.js";
import { PinnedShaderBuilders } from "./lowering/pinned-shader-builders.js";
import { parseWgslStages, type ShaderModule } from "./shader-ir.js";
import { emitWgslModule } from "./shader-wgsl-emitter.js";
import { sharedUpstreamStore } from "./upstream-source.js";

/**
 * Indents a reconstructed stage body to sit inside the struct or function
 * this module wraps it in. Shared because every builtins module that
 * re-homes pinned text needs it.
 */
export function indent(block: string, spaces: string): string {
    return block
        .split("\n")
        .map((line) => (line.length > 0 ? `${spaces}${line}` : line))
        .join("\n");
}

const copyTaskModule = "src/frame-graph/copy-to-texture-task.ts";

/**
 * The pin's copy-task blit, executed: `copy-to-texture-task.ts`'s
 * `VERTEX_WGSL` and the single-sample fragment `fragmentForSingle(lod)`
 * builds at the task's default mip level, the level every reached copy
 * samples (`lodLevel` is refused at the call). The pin compiles the two as
 * one module; each native stage is that module's typed IR for the stage,
 * the entry points renamed to the native `mainVertex`/`mainFragment`, the
 * vertex stage declaring no binding it does not read, and the fragment's
 * texture pair re-homed from the pin's group 0 to the fragment-resource
 * group both backends bind it at (2).
 */
function pinnedCopyBlit(context: LoweringContext): {
    vertex: ShaderModule;
    fragment: ShaderModule;
} {
    const { file, declaration } = context.functionDeclaration(
        copyTaskModule,
        "createCopyToTextureTask",
    );
    // `lodLevel: config.lodLevel ?? <default>` on the task record.
    const lodDefaults = context.findNodes(
        declaration,
        (node): node is ts.PropertyAssignment =>
            ts.isPropertyAssignment(node) &&
            context.propertyName(node.name) === "lodLevel",
    );
    const fallback = lodDefaults[0]?.initializer;
    if (
        lodDefaults.length !== 1 ||
        !fallback ||
        !ts.isBinaryExpression(fallback) ||
        fallback.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    ) {
        return context.contractError(
            declaration,
            "Pinned copy task no longer defaults lodLevel as `config.lodLevel ?? <level>`.",
        );
    }
    const builders = new PinnedShaderBuilders(context);
    const vertexText = builders.value(copyTaskModule, "VERTEX_WGSL");
    if (typeof vertexText !== "string") {
        return context.contractError(
            declaration,
            "Pinned copy task no longer declares its VERTEX_WGSL text.",
        );
    }
    const fragmentText = builders.evaluate(
        copyTaskModule,
        "fragmentForSingle",
        new Map([["lod", context.numericValue(fallback.right, file)]]),
    );
    const stages = parseWgslStages(`${vertexText}${fragmentText}`);
    const vertex = stages.find(
        ({ entryPoint }) => entryPoint.stage === "vertex",
    );
    const fragment = stages.find(
        ({ entryPoint }) => entryPoint.stage === "fragment",
    );
    if (!vertex || !fragment) {
        return context.contractError(
            declaration,
            "Pinned copy blit no longer declares one vertex and one fragment stage.",
        );
    }
    const { bindings, ...vertexStage } = vertex;
    if ((bindings ?? []).some(({ group }) => group !== 0)) {
        return context.contractError(
            declaration,
            "Pinned copy blit binds outside group 0.",
        );
    }
    return {
        vertex: {
            ...vertexStage,
            entryPoint: { ...vertex.entryPoint, name: "mainVertex" },
        },
        fragment: {
            ...fragment,
            bindings: (fragment.bindings ?? []).map((binding) => ({
                ...binding,
                group: 2,
            })),
            entryPoint: { ...fragment.entryPoint, name: "mainFragment" },
        },
    };
}

export function blitVertexWgsl(
    context = new LoweringContext(sharedUpstreamStore()),
): string {
    return `// ${context.provenance(copyTaskModule, "VERTEX_WGSL")}\n${emitWgslModule(pinnedCopyBlit(context).vertex)}`;
}

export function blitFragmentWgsl(
    context = new LoweringContext(sharedUpstreamStore()),
): string {
    return `// ${context.provenance(copyTaskModule, "fragmentForSingle")}\n${emitWgslModule(pinnedCopyBlit(context).fragment)}`;
}

export function depthOnlyFragmentWgsl(): string {
    return `@fragment
fn mainFragment() {
}
`;
}

function diagnosticPrelude(uniformStruct: string): string {
    return `@group(2) @binding(0) var baseColorTexture: texture_2d<f32>;
@group(2) @binding(1) var baseColorSampler: sampler;

${uniformStruct}

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
};

fn diagnosticAlpha(input: FragmentInput, alphaOptions: vec4<f32>) -> f32 {
    let alpha =
        textureSample(baseColorTexture, baseColorSampler, input.uv).a *
        alphaOptions.z;
    if (
        (alphaOptions.x > 0.5 &&
         alphaOptions.x < 1.5 &&
         alpha < alphaOptions.y) ||
        (alphaOptions.x > 1.5 && alpha <= 0.0)
    ) {
        discard;
    }
    return alpha;
}
`;
}

export function diagnosticIdFragmentWgsl(): string {
    return `${diagnosticPrelude(`struct IdUniforms {
    idColor: vec4<f32>,
    alphaOptions: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: IdUniforms;`)}

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    _ = diagnosticAlpha(input, uniforms.alphaOptions);
    return uniforms.idColor;
}
`;
}

export function diagnosticClusterFragmentWgsl(): string {
    return `enable primitive_index;

${diagnosticPrelude(`struct ClusterUniforms {
    clusterOptions: vec4<u32>,
    alphaOptions: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: ClusterUniforms;`)}

@fragment
fn mainFragment(
    input: FragmentInput,
    @builtin(primitive_index) primitiveIndex: u32,
) -> @location(0) vec4<f32> {
    _ = diagnosticAlpha(input, uniforms.alphaOptions);
    let clusterId =
        uniforms.clusterOptions.x +
        primitiveIndex / max(uniforms.clusterOptions.y, 1u);
    return vec4<f32>(
        f32(clusterId & 0xffu) / 255.0,
        f32((clusterId >> 8u) & 0xffu) / 255.0,
        f32((clusterId >> 16u) & 0xffu) / 255.0,
        1.0,
    );
}
`;
}
