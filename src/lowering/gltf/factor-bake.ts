import ts from "typescript";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import { pinnedNumericMathCalls, pinnedRoundCall } from "../pinned-operators.js";
import { refuseNode, topLevelFunction } from "./shared.js";

/** Source conversions retain JavaScript-number precision until their byte stores. */
export function lowerGltfFactorBake(colorFile: ts.SourceFile): string {
    const calls = new Map([...pinnedNumericMathCalls(), ["Math.round", pinnedRoundCall]]);
    const srgb = topLevelFunction(colorFile, "linearToSrgbByte");
    const parameter = srgb.parameters[0]?.name;
    if (srgb.parameters.length !== 1 || !parameter || !ts.isIdentifier(parameter))
        refuseNode("linearToSrgbByte", colorFile, srgb, "requires one scalar input");
    const srgbBody = lowerPinnedBody(colorFile, srgb.body.statements, {
        bindings: new Map([[parameter.text, { cpp: parameter.text, type: "scalar" }]]), calls,
        returnValue: (value, lowerer) => `bbl::js::to_uint8(${lowerer.expression(value!)})`,
    });
    return `// ${colorFile.fileName}#linearToSrgbByte
std::uint8_t linear_to_srgb_byte(double ${parameter.text}) {
${srgbBody}
}`;
}
