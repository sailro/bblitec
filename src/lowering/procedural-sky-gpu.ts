import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import { type LoweringContext, unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { proceduralSkyModule } from "./procedural-sky-atmosphere.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

/** The pinned texture, buffer, shader and binding descriptors projected onto the PAL. */
export function proceduralSkyGpuSource(context: LoweringContext): {
    source: string;
    wgsl: string;
} {
    const { file, declaration } = context.functionDeclaration(
        proceduralSkyModule,
        "loadProceduralSkyEnvironment",
    );
    const call = (name: string) => {
        const matches = context.findNodes(
            declaration,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                node.expression.getText(file) === name,
        );
        if (matches.length !== 1)
            throw new Error(`Procedural sky requires one ${name} descriptor.`);
        return matches[0]!;
    };
    const object = (expression: ts.Expression) => {
        const result = unwrapExpression(expression);
        if (!ts.isObjectLiteralExpression(result))
            return context.contractError(
                expression,
                "Expected sky descriptor object.",
            );
        return result;
    };
    const texture = object(call("device.createTexture").arguments[0]!);
    const dimensions = unwrapExpression(
        context.propertyInitializer(texture, "size"),
    );
    if (
        !ts.isArrayLiteralExpression(dimensions) ||
        dimensions.elements.length !== 3
    )
        return context.contractError(
            dimensions,
            "Expected three sky texture extents.",
        );
    const extent = dimensions.elements.map((value) =>
        context.numericValue(value, file),
    );
    const format = context.stringValue(
        context.propertyInitializer(texture, "format"),
        file,
    );
    context.assertExpressionShape(
        context.propertyInitializer(texture, "usage"),
        "TU.TEXTURE_BINDING|TU.STORAGE_BINDING|TU.RENDER_ATTACHMENT",
        "Sky GPU usage roles",
    );
    const mips = context.functionDeclaration(
        "src/texture/mip-count.ts",
        "mipLevelCount",
    );
    const mipExpression = lowerPinnedBody(
        mips.file,
        mips.declaration.body!.statements,
        {
            bindings: new Map([
                [
                    "width",
                    { cpp: context.doubleLiteral(extent[0]!), type: "scalar" },
                ],
                [
                    "height",
                    { cpp: context.doubleLiteral(extent[1]!), type: "scalar" },
                ],
            ]),
            calls: pinnedNumericMathCalls(),
            returnValue: (expression, lowerer) =>
                `static_cast<std::uint32_t>(${lowerer.expression(expression!)})`,
        },
    );
    context.assertExpressionShape(
        context.propertyInitializer(texture, "mipLevelCount"),
        "mipLevelCount(FACE_SIZE,FACE_SIZE)",
        "Sky mip dimensions",
    );
    const buffer = call("createEmptyUniformBuffer");
    const byteLength = context.numericValue(buffer.arguments[1]!, file);
    const view = object(call("texture.createView").arguments[0]!);
    const viewDimension = context.stringValue(
        context.propertyInitializer(view, "dimension"),
        file,
    );
    const bindGroup = object(call("device.createBindGroup").arguments[0]!);
    const entries = unwrapExpression(
        context.propertyInitializer(bindGroup, "entries"),
    );
    if (!ts.isArrayLiteralExpression(entries) || entries.elements.length !== 2)
        return context.contractError(
            entries,
            "Expected sky storage and uniform bindings.",
        );
    const binding = entries.elements.map((entry) =>
        context.numericValue(
            context.propertyInitializer(object(entry), "binding"),
            file,
        ),
    );
    const compute = object(
        context.propertyInitializer(
            object(call("device.createComputePipeline").arguments[0]!),
            "compute",
        ),
    );
    const entry = context.stringValue(
        context.propertyInitializer(compute, "entryPoint"),
        file,
    );
    const wgsl = context.stringValue(
        context.variableInitializer(file, "SKY_CUBE_WGSL"),
        file,
    );
    // Reflection of the admitted storage/uniform source declarations; format and dimension
    // are supplied by their source descriptors and validated by the backend.
    if (
        !wgsl.includes(
            `@binding(${binding[0]})var outputFaces:texture_storage_2d_array<${format},write>`,
        ) ||
        !wgsl.includes(`@binding(${binding[1]})var<uniform>params:Params`)
    )
        return context.contractError(
            declaration,
            "Sky shader bindings differ from their admitted descriptor roles.",
        );
    return {
        wgsl,
        source: `static ProceduralSkyGpuDescriptor make_procedural_sky_descriptor() {
    ProceduralSkyGpuDescriptor result;
    result.texture.extent={${extent.join(",")}};
    result.texture.mip_levels=[](){${mipExpression}}();
    result.texture.format=${stringLiteral(format)};
    result.texture.accesses={"write-only"};result.texture.sampled=true;result.texture.render_attachment=true;
    result.texture.sample_type="float";result.texture.sampler_type="filtering";
    result.texture.storage_view_dimension=${stringLiteral(viewDimension)};
    result.texture.sampled_view_dimension="cube";
    result.parameter_byte_length=${byteLength};result.texture_binding=${binding[0]};result.parameter_binding=${binding[1]};
    result.shader={"procedural sky",${stringLiteral(wgsl)}};
    result.entry_point=${stringLiteral(entry)};result.artifact="procedural-sky.comp";
    pal::ComputeLayoutEntry texture;texture.binding=result.texture_binding;texture.visibility=4;
    texture.storage_texture=ComputeStorageTextureLayout{"write-only",result.texture.format,result.texture.storage_view_dimension};
    pal::ComputeLayoutEntry uniform;uniform.binding=result.parameter_binding;uniform.visibility=4;
    uniform.buffer=ComputeBufferLayout{"uniform",false,static_cast<double>(result.parameter_byte_length)};
    result.group={"procedural sky",{texture,uniform}};
    return result;
}
`,
    };
}
