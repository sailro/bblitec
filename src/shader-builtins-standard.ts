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
    fog = false,
): string {
    if (fog && task) {
        throw new Error(
            "Standard fog is lowered only for the color fragment variant.",
        );
    }
    const returnType = task
        ? "FragmentOutput"
        : "@location(0) vec4<f32>";
    const fogUniformFields = fog
        ? `    fogInfos: vec4<f32>,
    fogColor: vec4<f32>,
`
        : "";
    const fogHelper = fog
        ? `const bblFogE: f32 = 2.71828;

fn bblCalcFogFactor(fogDistance: vec3<f32>) -> f32 {
    var fogCoeff = 1.0;
    let fogMode = uniforms.fogInfos.x;
    let fogStart = uniforms.fogInfos.y;
    let fogEnd = uniforms.fogInfos.z;
    let fogDensity = uniforms.fogInfos.w;
    let dist = length(fogDistance);
    if (fogMode == 3.0) {
        fogCoeff = (fogEnd - dist) / (fogEnd - fogStart);
    } else if (fogMode == 1.0) {
        fogCoeff = 1.0 / pow(bblFogE, dist * fogDensity);
    } else if (fogMode == 2.0) {
        fogCoeff =
            1.0 / pow(bblFogE, dist * dist * fogDensity * fogDensity);
    }
    return clamp(fogCoeff, 0.0, 1.0);
}

`
        : "";
    const fogBlend = fog
        ? `    if (uniforms.fogInfos.x > 0.0) {
        let fogView =
            input.worldPosition - uniforms.cameraPosition.xyz;
        let fog = bblCalcFogFactor(vec3<f32>(
            dot(uniforms.viewRight.xyz, fogView),
            dot(uniforms.viewUp.xyz, fogView),
            dot(uniforms.viewForward.xyz, fogView),
        ));
        color = vec4<f32>(
            mix(uniforms.fogColor.xyz, color.rgb, fog),
            color.a,
        );
    }
`
        : "";
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
    lightData2: vec4<f32>,
    lightDiffuse2: vec4<f32>,
    lightSpecular2: vec4<f32>,
    lightDirection2: vec4<f32>,
    diffuseAlpha: vec4<f32>,
    specularPower: vec4<f32>,
    emissiveLevel: vec4<f32>,
    ambientLevel: vec4<f32>,
    textureOptions: vec4<f32>,
    uvOptions: vec4<f32>,
    materialOptions: vec4<f32>,
    reflectionOptions: vec4<f32>,
${fogUniformFields}}
@group(3) @binding(0) var<uniform> uniforms: FragmentUniforms;

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) localPosition: vec3<f32>,
    @location(5) uv2: vec2<f32>,
};

struct LightResult {
    diffuse: vec3<f32>,
    specular: vec3<f32>,
};

fn evaluateLight(
    lightData: vec4<f32>,
    lightDiffuse: vec4<f32>,
    lightSpecular: vec4<f32>,
    lightDirection: vec4<f32>,
    worldPosition: vec3<f32>,
    normalW: vec3<f32>,
    viewDirectionW: vec3<f32>,
    specularPower: f32,
) -> LightResult {
    var result: LightResult;
    result.diffuse = vec3<f32>(0.0);
    result.specular = vec3<f32>(0.0);
    if (lightDirection.w < 0.5) {
        return result;
    }
    if (lightData.w > 2.5) {
        let resolvedDirection = normalize(lightData.xyz);
        let nDotL =
            0.5 + 0.5 * dot(normalW, resolvedDirection);
        result.diffuse = mix(
            lightDirection.rgb,
            lightDiffuse.rgb,
            nDotL,
        );
        let halfDirection = normalize(
            viewDirectionW + resolvedDirection,
        );
        result.specular =
            pow(
                max(0.0, dot(normalW, halfDirection)),
                max(1.0, specularPower),
            ) *
            lightSpecular.rgb;
        return result;
    }
    let directionalLight =
        lightData.w > 0.5 && lightData.w < 1.5;
    let lightVector = lightData.xyz - worldPosition;
    let lightDistance = length(lightVector);
    var attenuation = 1.0;
    if (!directionalLight && lightDiffuse.a > 0.0) {
        attenuation = max(
            0.0,
            1.0 - lightDistance / lightDiffuse.a,
        );
    }
    var resolvedDirection = vec3<f32>(0.0, 1.0, 0.0);
    if (directionalLight) {
        resolvedDirection = normalize(-lightData.xyz);
    } else if (lightDistance > 0.000001) {
        resolvedDirection = lightVector / lightDistance;
    }
    result.diffuse =
        max(0.0, dot(normalW, resolvedDirection)) *
        lightDiffuse.rgb *
        attenuation;
    let halfDirection = normalize(
        viewDirectionW + resolvedDirection,
    );
    result.specular =
        pow(
            max(0.0, dot(normalW, halfDirection)),
            max(1.0, specularPower),
        ) *
        lightSpecular.rgb *
        attenuation;
    return result;
}

${fogHelper}${outputDeclaration(task)}
@fragment
fn mainFragment(input: FragmentInput) -> ${returnType} {
    let normalW = normalize(input.normal);

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
    let light1 = evaluateLight(
        uniforms.lightData,
        uniforms.lightDiffuse,
        uniforms.lightSpecular,
        uniforms.lightDirection,
        input.worldPosition,
        normalW,
        viewDirectionW,
        uniforms.specularPower.w,
    );
    let light2 = evaluateLight(
        uniforms.lightData2,
        uniforms.lightDiffuse2,
        uniforms.lightSpecular2,
        uniforms.lightDirection2,
        input.worldPosition,
        normalW,
        viewDirectionW,
        uniforms.specularPower.w,
    );
    let diffuseBase = light1.diffuse + light2.diffuse;
    let specularBase = light1.specular + light2.specular;

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
    ${fog ? "var" : "let"} color = vec4<f32>(
        max(selectedColor, vec3<f32>(0.0)),
        alpha,
    );

${fogBlend}${outputWrites(task)}
}
`;
}
