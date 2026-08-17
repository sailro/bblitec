import type {
    GeometryOutputTaskManifest,
    GeometryTextureTypeName,
} from "./compiler.js";

export type PbrFragmentVariant =
    | { kind: "color" }
    | { kind: "diagnostic"; group: "a" | "b" | "c" }
    | { kind: "geometry"; task: GeometryOutputTaskManifest };

function geometryExpression(type: GeometryTextureTypeName): string {
    const write = "select(0.0, 1.0, v_32 > 0.4)";
    switch (type) {
        case "IRRADIANCE":
            return `vec4<f32>(
                bblDirectDiffuse + bblFinalIrradiance,
                ${write},
            )`;
        case "WORLD_POSITION":
            return `vec4<f32>(v_1, ${write})`;
        case "LOCAL_POSITION":
            return `vec4<f32>(bblLocalPosition, ${write})`;
        case "REFLECTIVITY":
            return `vec4<f32>(v_75, 1.0 - v_35) * ${write}`;
        case "VIEW_DEPTH":
            return `vec4<f32>(
                dot(
                    v_1 - FragmentUniforms.cameraPosition.xyz,
                    FragmentUniforms.cameraForwardNear.xyz,
                ),
                0.0,
                0.0,
                ${write},
            )`;
        case "NORMALIZED_VIEW_DEPTH":
            return `vec4<f32>(
                (
                    dot(
                        v_1 - FragmentUniforms.cameraPosition.xyz,
                        FragmentUniforms.cameraForwardNear.xyz,
                    ) -
                    FragmentUniforms.cameraForwardNear.w
                ) /
                max(
                    FragmentUniforms.cameraPosition.w -
                        FragmentUniforms.cameraForwardNear.w,
                    0.0001,
                ),
                0.0,
                0.0,
                ${write},
            )`;
        case "SCREENSPACE_DEPTH":
            return `vec4<f32>(
                1.0 - bblPosition.z,
                0.0,
                0.0,
                ${write},
            )`;
        case "VIEW_NORMAL":
            return `vec4<f32>(
                normalize(vec3<f32>(
                    dot(v_28, FragmentUniforms.viewRight.xyz),
                    dot(v_28, FragmentUniforms.viewUp.xyz),
                    dot(v_28, FragmentUniforms.viewForward.xyz),
                )),
                ${write},
            )`;
        case "WORLD_NORMAL":
            return `vec4<f32>(v_28 * 0.5 + 0.5, ${write})`;
        case "ALBEDO":
            return `vec4<f32>(v_52, ${write})`;
        case "LINEAR_VELOCITY":
            return `vec4<f32>(0.0, 0.0, 0.0, ${write})`;
    }
}

function outputStruct(fields: string[]): string {
    return `struct FragmentOutput {
${fields.map((field, index) =>
    `  @location(${index}) ${field} : vec4<f32>,`).join("\n")}
}

var<private> bblOutput : FragmentOutput;`;
}

function diagnosticOutput(group: "a" | "b" | "c"): {
    declaration: string;
    tail: string;
} {
    if (group === "a") {
        return {
            declaration: outputStruct([
                "normal",
                "reflectivity",
                "irradiance",
                "ibl",
            ]),
            tail: `  bblOutput.normal = vec4<f32>(v_28 * 0.5 + 0.5, 1.0);
  bblOutput.reflectivity = vec4<f32>(v_75, 1.0 - v_35);
  bblOutput.irradiance = vec4<f32>(
    clamp(bblDirectDiffuse + bblFinalIrradiance, vec3<f32>(), vec3<f32>(1.0)),
    1.0,
  );
  bblOutput.ibl = vec4<f32>(
    clamp(bblFinalIrradiance + v_101, vec3<f32>(), vec3<f32>(1.0)),
    1.0,
  );`,
        };
    }
    if (group === "b") {
        return {
            declaration: outputStruct(["depth", "albedo", "direct"]),
            tail: `  let bblViewDepth = dot(
    v_1 - FragmentUniforms.cameraPosition.xyz,
    FragmentUniforms.cameraForwardNear.xyz,
  );
  let bblNormalizedDepth =
    (bblViewDepth - FragmentUniforms.cameraForwardNear.w) /
    max(
      FragmentUniforms.cameraPosition.w -
        FragmentUniforms.cameraForwardNear.w,
      0.0001,
    );
  bblOutput.depth = vec4<f32>(
    bblNormalizedDepth,
    bblNormalizedDepth,
    bblNormalizedDepth,
    1.0,
  );
  bblOutput.albedo = vec4<f32>(v_52, 1.0);
  bblOutput.direct = vec4<f32>(
    clamp(bblDirectDiffuse + v_102, vec3<f32>(), vec3<f32>(1.0)),
    1.0,
  );`,
        };
    }
    return {
        declaration: outputStruct(["baseColor", "preToneHdr"]),
        tail: `  bblOutput.baseColor = vec4<f32>(v_31, v_32);
  bblOutput.preToneHdr = vec4<f32>(v_104, 1.0);`,
    };
}

function geometryOutput(task: GeometryOutputTaskManifest): {
    declaration: string;
    tail: string;
} {
    const fields = task.attachments.map((_, index) => `f${index}`);
    if (task.emitColor) fields.push("color");
    const writes = task.attachments.map(
        (type, index) =>
            `  bblOutput.f${index} = ${geometryExpression(type)};`,
    );
    if (task.emitColor) {
        writes.push(`  bblOutput.color = vec4<f32>(
    v_110,
    select(
      1.0,
      v_32,
      FragmentUniforms.materialOptions.x > 1.5,
    ),
  );`);
    }
    return {
        declaration: outputStruct(fields),
        tail: writes.join("\n"),
    };
}

function fragmentEntry(
    returnType: string,
    includeGeometryInputs: boolean,
): string {
    const geometryArguments = includeGeometryInputs
        ? ", bblPosition, bblLocalPosition"
        : "";
    return `@fragment
fn mainFragment(
  @builtin(position) bblPosition : vec4<f32>,
  @location(0u) v_114 : vec3<f32>,
  @location(1u) v_115 : vec3<f32>,
  @location(2u) v_116 : vec4<f32>,
  @location(3u) v_117 : vec2<f32>,
  @location(4u) bblLocalPosition : vec3<f32>,
  @location(6u) v_118 : vec4<f32>,
  @location(7u) bblBitangent : vec3<f32>,
  @builtin(front_facing) v_119 : bool,
) -> ${returnType} {
  main_inner(
    v_114,
    v_115,
    v_116,
    v_117,
    v_118,
    v_119,
    bblBitangent${geometryArguments},
  );
  return bblOutput;
}
`;
}

function colorEntry(occlusionUv2: boolean): string {
    const uv2Input = occlusionUv2
        ? "\n  @location(5u) bblUv2 : vec2<f32>,"
        : "";
    const uv2Argument = occlusionUv2 ? ", bblUv2" : "";
    return `@fragment
fn mainFragment(
  @builtin(position) bblPosition : vec4<f32>,
  @location(0u) v_114 : vec3<f32>,
  @location(1u) v_115 : vec3<f32>,
  @location(2u) v_116 : vec4<f32>,
  @location(3u) v_117 : vec2<f32>,
  @location(4u) bblLocalPosition : vec3<f32>,${uv2Input}
  @location(6u) v_118 : vec4<f32>,
  @location(7u) bblBitangent : vec3<f32>,
  @builtin(front_facing) v_119 : bool,
) -> @location(0u) vec4<f32> {
  main_inner(v_114, v_115, v_116, v_117, v_118, v_119, bblBitangent${uv2Argument});
  return v;
}
`;
}

export function pbrFragmentWgsl(
    converted: string,
    variant: PbrFragmentVariant,
    occlusionUv2 = false,
): string {
    if (occlusionUv2 && variant.kind !== "color") {
        throw new Error(
            "PBR occlusion uv2 is lowered only for the color fragment variant.",
        );
    }
    const normalized = converted
        .replace("@location(5u) v_118", "@location(6u) v_118");
    const colorEntryIndex = normalized.indexOf("@fragment");
    if (colorEntryIndex < 0) {
        throw new Error("Converted PBR WGSL entry point changed.");
    }
    if (variant.kind === "color") {
        return `${normalized.slice(0, colorEntryIndex)}${colorEntry(occlusionUv2)}`;
    }

    const marker = "  let v_110 = v_108;";
    const markerIndex = normalized.indexOf(marker);
    const entryIndex = normalized.indexOf("@fragment", markerIndex);
    if (markerIndex < 0 || entryIndex < 0) {
        throw new Error("Converted PBR WGSL output markers changed.");
    }
    const geometry = variant.kind === "geometry";
    let prefix = normalized.slice(0, markerIndex + marker.length);
    if (geometry) {
        prefix = prefix.replace(
            "fn main_inner(v_1 : vec3<f32>, v_2 : vec3<f32>, v_3 : vec4<f32>, v_4 : vec2<f32>, v_5 : vec4<f32>, v_6 : bool, bblBitangent : vec3<f32>) {",
            "fn main_inner(v_1 : vec3<f32>, v_2 : vec3<f32>, v_3 : vec4<f32>, v_4 : vec2<f32>, v_5 : vec4<f32>, v_6 : bool, bblBitangent : vec3<f32>, bblPosition : vec4<f32>, bblLocalPosition : vec3<f32>) {",
        );
    }
    const output = variant.kind === "diagnostic"
        ? diagnosticOutput(variant.group)
        : geometryOutput(variant.task);
    prefix = prefix.replace(
        "var<private> v : vec4<f32>;",
        output.declaration,
    );
    const aliases = `
  let bblDirectDiffuse =
    (((v_70 * v_52) * v_71) * v_81) * v_69;
  let bblFinalIrradiance = (v_89 * v_52) * v_34;
`;
    return `${prefix}${aliases}${output.tail}
}

${fragmentEntry("FragmentOutput", geometry)}`;
}
