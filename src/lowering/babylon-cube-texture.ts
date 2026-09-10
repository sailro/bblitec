import ts from "typescript";
import { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";

export function lowerBabylonCubeTexture(context: LoweringContext): string {
    const module = "src/loader-babylon/load-babylon.ts";
    const { file, declaration } = context.functionDeclaration(module, "loadBabylon");
    const branches = context.findNodes(declaration, (node): node is ts.IfStatement =>
        ts.isIfStatement(node) && context.hasCall(node, "loadCubeTexture") &&
        !context.hasNode(node.thenStatement, child => ts.isIfStatement(child) && context.hasCall(child, "loadCubeTexture")));
    const branch = branches[0];
    if (branches.length !== 1 || !branch) context.contractError(declaration, "Expected one cube texture construction branch.");
    const prefix = "md.reflectionTexture";
    const present = '(source.contains("reflectionTexture") && !source.at("reflectionTexture").is_null())';
    const texture = 'source.at("reflectionTexture")';
    const body = lowerPinnedBody(file, [branch], {
        bindings: new Map([[prefix, { cpp: present, type: "bool" }]]), calls: new Map(), booleanAnd: true,
        expression(node) {
            if (context.expressionMatchesShape(node, "opts.loadTextures !== false")) return "load_textures";
            if (context.expressionMatchesShape(node, `${prefix}.isCube`))
                return `(${texture}.contains("isCube") && ${texture}.at("isCube") == true)`;
            if (context.expressionMatchesShape(node, `${prefix}.level != null`))
                return `(${texture}.contains("level") && !${texture}.at("level").is_null())`;
            if (context.expressionMatchesShape(node, `${prefix}.level`)) return `${texture}.at("level").get<double>()`;
            if (context.expressionMatchesShape(node, `${prefix}.name`)) return `${texture}.at("name").get<std::string>()`;
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isExpressionStatement(statement)) {
                const assignment = context.unwrapExpression(statement.expression);
                if (ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    context.expressionMatchesShape(assignment.left, "mat.reflectionLevel"))
                    return [`${indent}material.reflection_level = static_cast<float>(${lowerer.expression(assignment.right)});`];
            }
            if (ts.isVariableStatement(statement)) {
                const variable = statement.declarationList.declarations[0];
                if (statement.declarationList.declarations.length === 1 && variable && ts.isIdentifier(variable.name) && variable.name.text === "cubeName" && variable.initializer)
                    return [`${indent}const std::string cube_name = ${lowerer.expression(variable.initializer)};`];
            }
            if (!ts.isExpressionStatement(statement) || !context.hasCall(statement, "loadCubeTexture")) return undefined;
            context.assertExpressionShape(statement.expression, `texturePromises.push(
                import("../texture/cube-texture.js").then(({ loadCubeTexture }) =>
                    loadCubeTexture(engine, baseUrl + cubeName).then(async (cube) => {
                        const { setStandardReflectionCubeTexture } = await import("../material/standard/set-std-cube-reflection.js");
                        setStandardReflectionCubeTexture(mat, cube);
                    })
                ))`, "Babylon cube texture publication");
            return [`${indent}material.reflection_cube = load_cube(cube_name);`];
        },
    });
    return `// ${context.provenance(module, "loadBabylon")}\ntemplate <typename LoadCube>\nvoid apply_babylon_cube_texture(MaterialRecord& material, const Json& source, bool load_textures, LoadCube&& load_cube) {\n${body}\n}`;
}
