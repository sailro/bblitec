import ts from "typescript";
import {LoweringContext} from "./lowering/context.js";
import {pinnedModuleTextUrl} from "./pinned-shader-composer.js";
import {transpileCommonJs, transpileForBrowser} from "./typescript-transpile.js";

export const transmissionRegistrationMarker = "__bblitecTransmissionRegistration";

/** Record the source hook call without changing its registration or material writes. */
export function recordingTransmissionSetter(kind: "transmission" | "dispersion", context: LoweringContext = new LoweringContext()): string {
    const module = `src/material/pbr/set-${kind}.ts`;
    const name = kind === "transmission" ? "setPbrTransmission" : "setPbrDispersion";
    const {file, declaration} = context.functionDeclaration(module, name);
    const material = declaration.parameters[0]?.name;
    if (!material || !ts.isIdentifier(material)) context.contractError(declaration, "Expected the PBR setter material parameter.");
    const materialExpression = ts.factory.createIdentifier(material.text);
    const calls = context.findNodes(declaration, (node): node is ts.CallExpression => ts.isCallExpression(node) &&
        context.expressionMatchesShape(node.expression, "_registerPbrSceneHook"));
    for (const call of calls) context.assertExpressionShape(call, "_registerPbrSceneHook(registerPbrTransmission)", "Transmission hook registration");
    const transformed = ts.transform(file, [visitorContext => root => {
        const visit: ts.Visitor = node => ts.isCallExpression(node) && calls.includes(node)
            ? ts.factory.createCommaListExpression([node,
                ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("Object"), "defineProperty"),
                    undefined, [materialExpression, ts.factory.createStringLiteral(transmissionRegistrationMarker),
                        ts.factory.createObjectLiteralExpression([ts.factory.createPropertyAssignment("value", ts.factory.createTrue())])])])
            : ts.visitEachChild(node, visit, visitorContext);
        return ts.visitNode(root, visit, ts.isSourceFile)!;
    }]);
    const text = transpileForBrowser(ts.createPrinter().printFile(transformed.transformed[0]!), module);
    transformed.dispose();
    return pinnedModuleTextUrl(`material/pbr/set-${kind}.js`, text);
}

type TransmissionSelection = (materials: readonly object[]) => boolean;
let selection: TransmissionSelection | undefined;

/** Execute the complete pinned hook with a recording frame-graph activation boundary. */
export function pinnedPbrTransmissionSelection(context?: LoweringContext): TransmissionSelection {
    if (!context && selection) return selection;
    const module = "src/material/pbr/pbr-transmission-ext.ts";
    const declaration = (context ?? new LoweringContext()).functionDeclaration(module, "registerPbrTransmission").declaration;
    const source = transpileCommonJs(declaration.getText().replace(/^export\s+/, "") + "\nreturn registerPbrTransmission;", module);
    let enabled = false;
    const hook = new Function("enableSceneTransmission", "_registerPbrExt", "makeRefractionRttExt", "_dispersionSampleWgsl", source)(
        () => { enabled = true; }, () => {}, () => ({}), undefined) as
        (scene: object, engine: object, meshes: readonly {material: object}[]) => void;
    const result: TransmissionSelection = materials => {
        enabled = false;
        hook({}, {}, materials.map(material => ({material})));
        return enabled;
    };
    if (!context) selection = result;
    return result;
}
