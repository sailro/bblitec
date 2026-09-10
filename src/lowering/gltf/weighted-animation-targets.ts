import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";
import type {PinnedBinding} from "../pinned-numeric-lowerer.js";

const module = "src/animation/weighted-gltf-mixer.ts";
/** Source cache allocation and first-use reset; transport callbacks only retain native object identities. */
export function lowerGltfWeightedAnimationTargets(context: LoweringContext): string {
    const file = context.sourceFile(module);
    for (const [name, expected] of [["GLTF_NODES", 1], ["GLTF_SKELETONS", 2]] as const)
        if (context.numericValue(ts.factory.createIdentifier(name), file) !== expected)
            context.contractError(file, "Weighted target tuple identity changed.");
    const bindings = new Map<string, PinnedBinding>([
        ["nodes", {cpp:"nodes", type:"opaque"}], ["nodes.length",{cpp:"static_cast<double>(nodes.size())",type:"scalar"}],
        ["skeletons",{cpp:"skeletons",type:"opaque"}], ["skeletons.length",{cpp:"static_cast<double>(skeletons.size())",type:"scalar"}],
        ["target",{cpp:"target",type:"opaque",absentCpp:"!target"}],
        ["overrides",{cpp:"overrides",type:"opaque",absentCpp:"!overrides"}],
        ["TRS_STRIDE",{cpp:context.doubleLiteral(context.numericValue(ts.factory.createIdentifier("TRS_STRIDE"),file)),type:"scalar"}],
    ]);
    const {declaration} = context.functionDeclaration(module,"getTarget");
    const properties = ["nodes","skeletons","overrides","baseRot","trs","localMat","worldMat","topoOrder","tWeight","rWeight","sWeight","active"];
    const body = lowerPinnedBody(file,declaration.body!.statements,{
        bindings,calls:new Map(),booleanAnd:true,booleanOr:true,
        expression(node,lowerer){
            if(context.expressionMatchesShape(node,"mixer[GLTF_NODES]"))return "transport.nodes(mixer)";
            if(context.expressionMatchesShape(node,"mixer[GLTF_SKELETONS]"))return "transport.skeletons(mixer)";
            if(context.expressionMatchesShape(node,"skeletons[0]!.runtimeSkeleton?._overrides"))return "transport.overrides(skeletons.at(0))";
            if(ts.isIdentifier(node)&&node.text==="undefined")return "decltype(transport.overrides(skeletons.at(0))){}";
            if(ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==="F32"){
                if(node.arguments?.length!==1)context.contractError(node,"Expected weighted F32 allocation length.");
                return `std::vector<float>(static_cast<std::size_t>(${lowerer.expression(node.arguments![0]!)}))`;
            }
            if(ts.isCallExpression(node)){
                if(context.expressionMatchesShape(node.expression,"scratch.targets.get")){
                    context.assertExpressionShape(node,"scratch.targets.get(nodes)","Weighted target lookup identity");return "transport.lookup(nodes)";
                }
                if(context.expressionMatchesShape(node.expression,"scratch.targets.set")){
                    context.assertExpressionShape(node,"scratch.targets.set(nodes, target)","Weighted target publication identity");return "transport.publish(nodes, target)";
                }
                if(context.expressionMatchesShape(node.expression,"computeTopoOrder")){
                    context.assertExpressionShape(node,"computeTopoOrder(nodes)","Weighted target topological nodes");return "gltf_weighted_topological_order(nodes)";
                }
                if(context.expressionMatchesShape(node.expression,"resetWeightedGltfTarget")){
                    context.assertExpressionShape(node,"resetWeightedGltfTarget(target)","Weighted target initial reset identity");return "transport.reset_target(*target)";
                }
            }
            return undefined;
        },
        statement(statement,lowerer,indent){
            if(ts.isVariableStatement(statement)&&statement.declarationList.declarations.length===1){
                const variable=statement.declarationList.declarations[0]!;
                if(ts.isIdentifier(variable.name)&&variable.initializer&&["nodes","skeletons","target","overrides"].includes(variable.name.text))
                    return [`${indent}${["nodes","skeletons"].includes(variable.name.text)?"const auto&":"auto"} ${variable.name.text} = ${lowerer.expression(variable.initializer)};`];
            }
            if(ts.isExpressionStatement(statement)&&ts.isBinaryExpression(statement.expression)&&statement.expression.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isObjectLiteralExpression(statement.expression.right)){
                context.assertExpressionShape(statement.expression.left,"target","Weighted target construction identity");
                const seen=new Set<string>(),lines:string[]=[];
                for(const property of statement.expression.right.properties){
                    if(!ts.isPropertyAssignment(property)&&!ts.isShorthandPropertyAssignment(property))context.contractError(property,"Unsupported weighted target property.");
                    if(!ts.isIdentifier(property.name)||!properties.includes(property.name.text)||seen.has(property.name.text))context.contractError(property,"Changed weighted target storage fields.");
                    const name=property.name.text;seen.add(name);
                    const value=ts.isShorthandPropertyAssignment(property)?property.name:property.initializer;
                    let cpp:string;
                    if(name==="baseRot"){
                        if(!ts.isConditionalExpression(value))context.contractError(value,"Expected optional weighted base rotation allocation.");
                        context.assertExpressionShape(value.whenFalse,"undefined","Absent weighted base rotation storage");
                        cpp=`(${lowerer.expression(value.condition)} ? std::optional<std::vector<float>>(${lowerer.expression(value.whenTrue)}) : std::nullopt)`;
                    }else cpp=lowerer.expression(value);
                    lines.push(`${indent}${["nodes","skeletons"].includes(name)?"const auto&":"auto"} field_${name} = ${cpp};`);
                }
                if(seen.size!==properties.length)context.contractError(statement,"Missing weighted target storage field.");
                lines.push(`${indent}target = transport.create_target(${properties.map(name=>["nodes","skeletons"].includes(name)?`field_${name}`:`std::move(field_${name})`).join(", ")});`);
                return lines;
            }
            return undefined;
        },
        returnValue:(expression,lowerer)=>`*${lowerer.expression(expression!)}`,
    });
    return `${lowerTopoOrder(context)}
${lowerScratch(context)}
// ${context.provenance(module,"getTarget")}
template<class Transport,class Mixer>
auto& gltf_get_weighted_target(Transport& transport,const Mixer& mixer) {
${body}
}`;
}

function lowerScratch(context:LoweringContext):string {
    const {file,declaration}=context.functionDeclaration(module,"getScratch");
    const statements=declaration.body!.statements;
    context.assertStatementShapes(declaration,[statements[0]!],"scratchByManager ??= new WeakMap();","Weighted manager scratch registry allocation");
    const bindings=new Map<string,PinnedBinding>([["scratch",{cpp:"scratch",type:"opaque",absentCpp:"!scratch"}]]);
    const body=lowerPinnedBody(file,statements.slice(1),{bindings,calls:new Map(),
        expression(node){
            if(context.expressionMatchesShape(node,"scratchByManager.get(manager)"))return "scratch_slot";
            if(context.expressionMatchesShape(node,"scratchByManager.set(manager, scratch)"))return "scratch_slot = scratch";
            return undefined;
        },
        statement(statement,lowerer,indent){
            if(ts.isVariableStatement(statement)&&statement.declarationList.declarations.length===1){
                const variable=statement.declarationList.declarations[0]!;
                if(ts.isIdentifier(variable.name)&&variable.name.text==="scratch"&&variable.initializer)return [`${indent}auto scratch = ${lowerer.expression(variable.initializer)};`];
            }
            if(ts.isExpressionStatement(statement)&&ts.isBinaryExpression(statement.expression)&&statement.expression.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isObjectLiteralExpression(statement.expression.right)){
                context.assertExpressionShape(statement.expression.left,"scratch","Weighted scratch construction identity");
                const seen=new Set<string>(),lines=[`${indent}scratch = std::make_shared<Scratch>();`];
                for(const property of statement.expression.right.properties){
                    if(!ts.isPropertyAssignment(property)||!ts.isIdentifier(property.name)||seen.has(property.name.text))context.contractError(property,"Unsupported weighted scratch storage property.");
                    const name=property.name.text;seen.add(name);
                    if(name==="keys"||name==="targets"){
                        const value=property.initializer;
                        if(!ts.isNewExpression(value)||!ts.isIdentifier(value.expression)||value.expression.text!==(name==="keys"?"Set":"Map")||(value.arguments?.length??0)!==0)
                            context.contractError(value,"Expected empty weighted scratch collection.");
                        lines.push(`${indent}scratch->${name}.clear();`);
                    }else if(["sample","reference","delta"].includes(name)){
                        const value=property.initializer;
                        if(!ts.isNewExpression(value)||!ts.isIdentifier(value.expression)||value.expression.text!=="F32"||value.arguments?.length!==1)
                            context.contractError(value,"Expected weighted scratch F32 allocation.");
                        lines.push(`${indent}scratch->${name} = std::vector<float>(static_cast<std::size_t>(${lowerer.expression(value.arguments![0]!)}));`);
                    }else context.contractError(property,"Unknown weighted scratch storage field.");
                }
                if(seen.size!==5)context.contractError(statement,"Missing weighted scratch storage field.");return lines;
            }
            return undefined;
        },returnValue:(expression,lowerer)=>`*${lowerer.expression(expression!)}`,
    });
    return `// ${context.provenance(module,"getScratch")}
template<class Scratch> Scratch& gltf_get_weighted_scratch(std::shared_ptr<Scratch>& scratch_slot) {
${body}
}`;
}

function lowerTopoOrder(context:LoweringContext):string {
    const {file,declaration}=context.functionDeclaration(module,"computeTopoOrder");
    const bindings=new Map<string,PinnedBinding>([
        ["nodes.length",{cpp:"static_cast<double>(nodes.size())",type:"scalar"}],
        ["order",{cpp:"order",type:"f64-list"}],["visited",{cpp:"visited",type:"u8"}],
        ["idx",{cpp:"idx",type:"scalar"}],
    ]);
    const body=lowerPinnedBody(file,declaration.body!.statements,{bindings,calls:new Map([["visit",args=>`visit(${args.join(", ")})`]]),
        expression(node,lowerer){
            if(ts.isPropertyAccessExpression(node)&&node.name.text==="parentIdx"&&ts.isNonNullExpression(node.expression)&&ts.isElementAccessExpression(node.expression.expression)){
                const read=node.expression.expression;context.assertExpressionShape(read.expression,"nodes","Weighted topological node storage");
                return `nodes.at(static_cast<std::size_t>(${lowerer.expression(read.argumentExpression)})).parentIdx`;
            }
            return undefined;
        },
        statement(statement,lowerer,indent){
            if(ts.isExpressionStatement(statement)&&ts.isBinaryExpression(statement.expression)&&statement.expression.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isElementAccessExpression(statement.expression.left)&&context.expressionMatchesShape(statement.expression.left.expression,"order")) {
                const assignment=statement.expression;
                return [`${indent}order.at(static_cast<std::size_t>(${lowerer.expression((assignment.left as ts.ElementAccessExpression).argumentExpression)})) = bbl::js::to_int32(${lowerer.expression(assignment.right)});`];
            }
            if(ts.isVariableStatement(statement)&&statement.declarationList.declarations.length===1){
                const variable=statement.declarationList.declarations[0]!;
                if(ts.isIdentifier(variable.name)&&variable.initializer&&ts.isNewExpression(variable.initializer)){
                    const name=variable.name.text,value=variable.initializer;
                    if(!["order","visited"].includes(name)||!ts.isIdentifier(value.expression)||value.expression.text!==(name==="order"?"I32":"U8")||value.arguments?.length!==1)
                        context.contractError(variable,"Changed weighted topological scratch allocation.");
                    return [`${indent}std::vector<${name==="order"?"std::int32_t":"std::uint8_t"}> ${name}(static_cast<std::size_t>(${lowerer.expression(value.arguments![0]!)}));`];
                }
            }
            if(ts.isFunctionDeclaration(statement)){
                if(statement.name?.text!=="visit"||statement.parameters.length!==1||!statement.body)context.contractError(statement,"Changed weighted topological visit function.");
                context.assertExpressionShape(statement.parameters[0]!.name as ts.Identifier,"idx","Weighted topological visit parameter");
                return [`${indent}std::function<void(double)> visit = [&](double idx) {`,...lowerer.statements(statement.body.statements,indent+"    "),`${indent}};`];
            }
            return undefined;
        },returnValue:(expression,lowerer)=>expression?lowerer.expression(expression):"",
    });
    return `// ${context.provenance(module,"computeTopoOrder")}
template<class Nodes> std::vector<std::int32_t> gltf_weighted_topological_order(const Nodes& nodes) {
${body}
}`;
}
