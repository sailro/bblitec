import type {
    GeometryOutputTaskManifest,
    GeometryTextureTypeName,
} from "./compiler.js";

function geometryExpression(type: GeometryTextureTypeName): string {
    const write = "select(0.0, 1.0, alpha > 0.4)";
    switch (type) {
        case "IRRADIANCE":
            return `vec4<f32>(0.0, 0.0, 0.0, ${write})`;
        case "WORLD_POSITION":
            return `vec4<f32>(input.worldPosition, ${write})`;
        case "LOCAL_POSITION":
            return `vec4<f32>(input.localPosition, ${write})`;
        case "REFLECTIVITY":
            return `vec4<f32>(
                pow(specularSample.rgb, vec3<f32>(2.2)),
                select(
                    1.0,
                    specularSample.a,
                    uniforms.textureOptions.y > 0.5,
                ),
            ) * ${write}`;
        case "VIEW_DEPTH":
            return `vec4<f32>(
                dot(
                    input.worldPosition - uniforms.cameraPosition.xyz,
                    uniforms.cameraForwardNear.xyz,
                ),
                0.0,
                0.0,
                ${write},
            )`;
        case "NORMALIZED_VIEW_DEPTH":
            return `vec4<f32>(
                (
                    dot(
                        input.worldPosition -
                            uniforms.cameraPosition.xyz,
                        uniforms.cameraForwardNear.xyz,
                    ) -
                    uniforms.cameraForwardNear.w
                ) /
                max(
                    uniforms.cameraPosition.w -
                        uniforms.cameraForwardNear.w,
                    0.0001,
                ),
                0.0,
                0.0,
                ${write},
            )`;
        case "SCREENSPACE_DEPTH":
            return `vec4<f32>(
                1.0 - input.position.z,
                0.0,
                0.0,
                ${write},
            )`;
        case "VIEW_NORMAL":
            return `vec4<f32>(
                normalize(vec3<f32>(
                    dot(normalW, uniforms.viewRight.xyz),
                    dot(normalW, uniforms.viewUp.xyz),
                    dot(normalW, uniforms.viewForward.xyz),
                )),
                ${write},
            )`;
        case "WORLD_NORMAL":
            return `vec4<f32>(normalW * 0.5 + 0.5, ${write})`;
        case "ALBEDO":
            return `vec4<f32>(baseColor, ${write})`;
        case "LINEAR_VELOCITY":
            return `vec4<f32>(0.0, 0.0, 0.0, ${write})`;
    }
}

function outputDeclaration(
    task: GeometryOutputTaskManifest | undefined,
): string {
    if (!task) return "";
    const fields = task.attachments.map(
        (_, index) => `    @location(${index}) f${index}: vec4<f32>,`,
    );
    if (task.emitColor) {
        fields.push(
            `    @location(${task.attachments.length}) color: vec4<f32>,`,
        );
    }
    return `struct FragmentOutput {
${fields.join("\n")}
};
`;
}

function outputWrites(
    task: GeometryOutputTaskManifest | undefined,
): string {
    if (!task) return "    return color;";
    const writes = task.attachments.map(
        (type, index) =>
            `    output.f${index} = ${geometryExpression(type)};`,
    );
    if (task.emitColor) writes.push("    output.color = color;");
    return `    var output: FragmentOutput;
${writes.join("\n")}
    return output;`;
}

export function standardFragmentWgsl(
    provenance: string,
    task?: GeometryOutputTaskManifest,
): string {
    const returnType = task
        ? "FragmentOutput"
        : "@location(0) vec4<f32>";
    return `// ${provenance}
@group(2) @binding(0) var diffuseTexture: texture_2d<f32>;
@group(2) @binding(1) var diffuseSampler: sampler;
@group(2) @binding(2) var specularTexture: texture_2d<f32>;
@group(2) @binding(3) var specularSampler: sampler;
@group(2) @binding(4) var opacityTexture: texture_2d<f32>;
@group(2) @binding(5) var opacitySampler: sampler;
@group(2) @binding(6) var ambientTexture: texture_2d<f32>;
@group(2) @binding(7) var ambientSampler: sampler;
@group(2) @binding(8) var reflectionTexture: texture_cube<f32>;
@group(2) @binding(9) var reflectionSampler: sampler;
@group(2) @binding(10) var emissiveTexture: texture_2d<f32>;
@group(2) @binding(11) var emissiveSampler: sampler;

struct FragmentUniforms {
    cameraPosition: vec4<f32>,
    cameraForwardNear: vec4<f32>,
    viewRight: vec4<f32>,
    viewUp: vec4<f32>,
    viewForward: vec4<f32>,
    lightData: vec4<f32>,
    lightDiffuse: vec4<f32>,
    lightSpecular: vec4<f32>,
    lightDirection: vec4<f32>,
    diffuseAlpha: vec4<f32>,
    specularPower: vec4<f32>,
    emissiveLevel: vec4<f32>,
    ambientLevel: vec4<f32>,
    textureOptions: vec4<f32>,
    uvOptions: vec4<f32>,
    materialOptions: vec4<f32>,
    reflectionOptions: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: FragmentUniforms;

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) localPosition: vec3<f32>,
    @location(5) uv2: vec2<f32>,
    @builtin(front_facing) frontFacing: bool,
};

${outputDeclaration(task)}
@fragment
fn mainFragment(input: FragmentInput) -> ${returnType} {
    var normalW = normalize(input.normal);
    if (
        uniforms.materialOptions.x > 0.5 &&
        !input.frontFacing
    ) {
        normalW = -normalW;
    }

    let diffuseUv = input.uv * uniforms.uvOptions.xy;
    var diffuseSample = vec4<f32>(1.0);
    if (uniforms.textureOptions.x > 0.5) {
        diffuseSample = textureSample(
            diffuseTexture,
            diffuseSampler,
            diffuseUv,
        );
    }
    if (diffuseSample.a < uniforms.materialOptions.y) {
        discard;
    }
    let baseColor =
        diffuseSample.rgb * uniforms.emissiveLevel.w;

    var emissiveSample = vec4<f32>(0.0);
    if (uniforms.reflectionOptions.z > 0.5) {
        emissiveSample = textureSample(
            emissiveTexture,
            emissiveSampler,
            input.uv,
        );
    }
    let emissiveTextureColor = emissiveSample.rgb;
    let emissiveContrib =
        uniforms.emissiveLevel.rgb +
        emissiveTextureColor * uniforms.emissiveLevel.w;

    var alpha = uniforms.diffuseAlpha.a;
    if (uniforms.textureOptions.z > 0.5) {
        alpha *=
            textureSample(
                opacityTexture,
                opacitySampler,
                input.uv,
            ).a *
            uniforms.materialOptions.z;
    }

    var specularUv = input.uv;
    if (uniforms.uvOptions.z > 0.5) {
        specularUv = input.uv2;
    }
    var specularSample =
        vec4<f32>(uniforms.specularPower.rgb, 1.0);
    if (uniforms.textureOptions.y > 0.5) {
        specularSample = textureSample(
            specularTexture,
            specularSampler,
            specularUv,
        );
    }
    let specularColor = specularSample.rgb;

    var ambientUv = input.uv;
    if (uniforms.uvOptions.w > 0.5) {
        ambientUv = input.uv2;
    }
    var baseAmbientColor = vec3<f32>(1.0);
    if (uniforms.textureOptions.w > 0.5) {
        baseAmbientColor =
            textureSample(
                ambientTexture,
                ambientSampler,
                ambientUv,
            ).rgb *
            uniforms.ambientLevel.w;
    }

    let viewDirectionW = normalize(
        uniforms.cameraPosition.xyz - input.worldPosition,
    );
    var diffuseBase: vec3<f32>;
    var specularBase: vec3<f32>;
    if (uniforms.lightData.w > 2.5) {
        let nDotL =
            0.5 +
            0.5 *
            dot(
                normalW,
                normalize(uniforms.lightData.xyz),
            );
        diffuseBase = mix(
            uniforms.lightDirection.rgb,
            uniforms.lightDiffuse.rgb,
            nDotL,
        );
        let halfDirection = normalize(
            viewDirectionW +
            normalize(uniforms.lightData.xyz),
        );
        let specularTerm = pow(
            max(0.0, dot(normalW, halfDirection)),
            max(1.0, uniforms.specularPower.w),
        );
        specularBase =
            specularTerm * uniforms.lightSpecular.rgb;
    } else {
        let directionalLight =
            uniforms.lightData.w > 0.5 &&
            uniforms.lightData.w < 1.5;
        let lightVector =
            uniforms.lightData.xyz - input.worldPosition;
        let lightDistance = length(lightVector);
        var attenuation = 1.0;
        if (
            !directionalLight &&
            uniforms.lightDiffuse.a > 0.0
        ) {
            attenuation = max(
                0.0,
                1.0 -
                    lightDistance /
                    uniforms.lightDiffuse.a,
            );
        }
        var resolvedLightDirection = vec3<f32>(0.0, 1.0, 0.0);
        if (directionalLight) {
            resolvedLightDirection =
                normalize(-uniforms.lightData.xyz);
        } else if (lightDistance > 0.000001) {
            resolvedLightDirection =
                lightVector / lightDistance;
        }
        let nDotL = max(
            0.0,
            dot(normalW, resolvedLightDirection),
        );
        diffuseBase =
            nDotL *
            uniforms.lightDiffuse.rgb *
            attenuation;
        let halfDirection = normalize(
            viewDirectionW + resolvedLightDirection,
        );
        let specularTerm = pow(
            max(0.0, dot(normalW, halfDirection)),
            max(1.0, uniforms.specularPower.w),
        );
        specularBase =
            specularTerm *
            uniforms.lightSpecular.rgb *
            attenuation;
    }

    let finalDiffuse = clamp(
        diffuseBase * uniforms.diffuseAlpha.rgb +
            emissiveContrib +
            uniforms.ambientLevel.rgb,
        vec3<f32>(0.0),
        vec3<f32>(1.0),
    ) * baseColor;
    let finalSpecular = specularBase * specularColor;
    let viewFromCamera = normalize(
        input.worldPosition - uniforms.cameraPosition.xyz,
    );
    var reflectionColor = vec3<f32>(0.0);
    if (uniforms.reflectionOptions.x > 0.5) {
        reflectionColor = textureSample(
            reflectionTexture,
            reflectionSampler,
            reflect(viewFromCamera, normalW),
        ).rgb * uniforms.reflectionOptions.y;
    }
    let litColor =
        finalDiffuse * baseAmbientColor +
        finalSpecular +
        reflectionColor;
    let unlitColor = clamp(
        emissiveContrib * uniforms.diffuseAlpha.rgb,
        vec3<f32>(0.0),
        vec3<f32>(1.0),
    ) * baseColor;
    var selectedColor = litColor;
    if (uniforms.materialOptions.w > 0.5) {
        selectedColor = unlitColor;
    }
    let color = vec4<f32>(
        max(selectedColor, vec3<f32>(0.0)),
        alpha,
    );

${outputWrites(task)}
}
`;
}
