import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";
import type {PinnedBinding} from "../pinned-numeric-lowerer.js";

/** Source name resolution and controller mask cache; mask names retain their admitted array identity. */
export function lowerGltfAnimationMask(context:LoweringContext):string {
    const module="src/animation/animation-group-mask.ts",controllerModule="src/skeleton/skeleton-updater.ts";
    const controller=context.functionDeclaration(controllerModule,"createAnimationController");
    const value=context.unwrapExpression(context.variableInitializer(controller.declaration,"_setMask"));
    if(!ts.isArrowFunction(value)||!ts.isBlock(value.body))context.contractError(value,"Expected source controller mask setter.");
    const initial=(name:string)=>context.variableInitializer(controller.declaration,name);
    for(const name of ["maskedNodes","cMask","cNames"])
        context.assertExpressionShape(initial(name),"null","Initial controller mask identity");
    for(const name of ["maskActive","cDisabled"])
        context.assertExpressionShape(initial(name),"false","Initial controller mask flags");
    const bindings=new Map<string,PinnedBinding>([
        ["mask",{cpp:"mask",type:"opaque",absentCpp:"!mask"}], ["mask.disabled",{cpp:"mask->disabled",type:"bool"}],
        ["mask.mode",{cpp:"mask->mode",type:"scalar"}], ["mask.names",{cpp:"mask->names",type:"opaque"}],
        ["name",{cpp:"name",type:"opaque"}], ["names",{cpp:"names",type:"opaque"}], ["names.length",{cpp:"static_cast<double>(names.size())",type:"scalar"}],
        ["nodeNames",{cpp:"node_names",type:"opaque",staticBoolean:true}],
        ["numNodes",{cpp:"static_cast<double>(pose.nodes.size())",type:"scalar"}],
        ["out",{cpp:"out",type:"u8"}], ["maskedNodes",{cpp:"pose.masked_nodes",type:"u8",absentCpp:"!cache.allocated"}],
        ["maskActive",{cpp:"pose.mask_active",type:"bool"}], ["_maskResolver",{cpp:"pose.mask_resolver",type:"bool"}],
        ["cMask",{cpp:"cache.mask",type:"opaque",absentCpp:"!cache.mask"}],
        ["cNames",{cpp:"cache.names",type:"opaque",absentCpp:"!cache.names"}],
        ["cLen",{cpp:"cache.length",type:"scalar"}], ["cMode",{cpp:"cache.mode",type:"scalar"}],
        ["cDisabled",{cpp:"cache.disabled",type:"bool"}],
    ]);
    const maskFile=context.sourceFile(module);
    const mode = context.findNodes(maskFile,ts.isEnumDeclaration).find(node=>node.name.text==="AnimationGroupMaskMode");
    const include = mode?.members.find(member=>context.propertyName(member.name)==="Include")?.initializer;
    const exclude = mode?.members.find(member=>context.propertyName(member.name)==="Exclude")?.initializer;
    if(!include||!exclude)context.contractError(maskFile,"Expected source Include and Exclude mask enum values.");
    bindings.set("AnimationGroupMaskMode.Include",{cpp:context.doubleLiteral(context.numericValue(include,maskFile)),type:"scalar"});
    const sharedExpression=(node:ts.Expression,lowerer:{expression(node:ts.Expression):string}):string|undefined=>{
        if(ts.isStringLiteral(node))return `std::string(${JSON.stringify(node.text)})`;
        if(context.expressionMatchesShape(node,"names === cNames"))return "std::addressof(names) == cache.names";
        if(ts.isCallExpression(node)&&context.expressionMatchesShape(node.expression,"mask.names.indexOf")){
            if(node.arguments.length!==1)context.contractError(node,"Expected source mask name membership argument.");
            return `([&]() -> double { const auto found=std::find(mask->names.begin(),mask->names.end(),${lowerer.expression(node.arguments[0]!)}); return found==mask->names.end() ? -1.0 : static_cast<double>(std::distance(mask->names.begin(),found)); }())`;
        }
        if(ts.isElementAccessExpression(node)&&context.expressionMatchesShape(node.expression,"nodeNames"))
            return `node_names.at(static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)}))`;
        if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.QuestionQuestionToken&&context.expressionMatchesShape(node.left,"nodeNames[i]"))
            return `node_names.at(static_cast<std::size_t>(i)).value_or(${lowerer.expression(node.right)})`;
        return undefined;
    };
    const retains=context.functionDeclaration(module,"animationGroupMaskRetainsTarget");
    const retainsBody=lowerPinnedBody(retains.file,retains.declaration.body!.statements,{
        bindings,calls:new Map(),expression:sharedExpression,returnValue:(expression,lowerer)=>lowerer.expression(expression!),
    });
    const resolver=context.functionDeclaration(module,"resolveAnimationMask");
    const resolveBindings=new Map(bindings);resolveBindings.set("numNodes",{cpp:"node_count",type:"scalar"});
    const resolveBody=lowerPinnedBody(resolver.file,resolver.declaration.body!.statements,{
        bindings:resolveBindings,calls:new Map([["animationGroupMaskRetainsTarget",args=>`gltf_animation_mask_retains(${args.join(", ")})`]]),expression:sharedExpression,
    });
    const setterBody=lowerPinnedBody(controller.file,value.body.statements,{
        bindings,calls:new Map(),booleanAnd:true,booleanOr:true,expression:sharedExpression,
        statement(statement,lowerer,indent){
            if(ts.isVariableStatement(statement)&&statement.declarationList.declarations.length===1){
                const variable=statement.declarationList.declarations[0]!;
                if(ts.isIdentifier(variable.name)&&variable.name.text==="names"&&variable.initializer){
                    context.assertExpressionShape(variable.initializer,"mask.names","Controller mask names identity");return [`${indent}const auto& names = mask->names;`];
                }
            }
            if(!ts.isExpressionStatement(statement))return undefined;
            const expression=statement.expression;
            if(ts.isBinaryExpression(expression)&&expression.operatorToken.kind===ts.SyntaxKind.EqualsToken){
                if(context.expressionMatchesShape(expression.left,"cNames")){
                    context.assertExpressionShape(expression.right,"names","Controller cached names identity");return [`${indent}cache.names = std::addressof(names);`];
                }
                if(context.expressionMatchesShape(expression.left,"maskedNodes")){
                    const allocation=expression.right;
                    if(!ts.isNewExpression(allocation)||!ts.isIdentifier(allocation.expression)||allocation.expression.text!=="U8"||allocation.arguments?.length!==1)
                        context.contractError(allocation,"Expected lazy source node-mask allocation.");
                    return [`${indent}pose.masked_nodes = std::vector<std::uint8_t>(static_cast<std::size_t>(${lowerer.expression(allocation.arguments![0]!)}));`,`${indent}cache.allocated = true;`];
                }
            }
            if(ts.isCallExpression(expression)&&context.expressionMatchesShape(expression.expression,"_maskResolver")){
                context.assertExpressionShape(expression,"_maskResolver(mask, nodeNames, maskedNodes, numNodes)","Controller mask resolver arguments");
                return [`${indent}gltf_resolve_animation_mask(mask,node_names,pose.masked_nodes,static_cast<double>(pose.nodes.size()));`];
            }
            return undefined;
        },
    });
    const factory=context.functionDeclaration(module,"createAnimationGroupMask");
    const factoryBody=lowerPinnedBody(factory.file,factory.declaration.body!.statements,{
        bindings:new Map<string,PinnedBinding>([["mode",{cpp:"mode",type:"scalar"}],["names",{cpp:"names",type:"opaque"}]]),calls:new Map(),
        statement(statement,lowerer,indent){
            if(ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression)){
                context.assertExpressionShape(statement.expression,"_installAnimationMaskResolver(resolveAnimationMask)","Mask factory resolver installation");
                return [];
            }
            if(!ts.isReturnStatement(statement)||!statement.expression||!ts.isObjectLiteralExpression(statement.expression))return undefined;
            const seen=new Set<string>(),lines=[`${indent}auto mask = std::make_shared<Mask>();`];
            for(const property of statement.expression.properties){
                if(!ts.isPropertyAssignment(property)&&!ts.isShorthandPropertyAssignment(property))context.contractError(property,"Unsupported mask factory field.");
                if(!ts.isIdentifier(property.name)||!["mode","names","disabled"].includes(property.name.text)||seen.has(property.name.text))context.contractError(property,"Changed mask factory fields.");
                const name=property.name.text;seen.add(name);
                const initializer=ts.isShorthandPropertyAssignment(property)?property.name:property.initializer;
                if(name==="names"){
                    context.assertExpressionShape(initializer,"names.slice()","Source mask names copy");lines.push(`${indent}mask->names = names;`);
                }else lines.push(`${indent}mask->${name} = ${lowerer.expression(initializer)};`);
            }
            if(seen.size!==3)context.contractError(statement,"Missing mask factory fields.");
            return [...lines,`${indent}return mask;`];
        },
    });
    return `// ${context.provenance(controllerModule,"createAnimationController mask state")}
template<class Mask> struct GltfAnimationControllerMaskCache {
    std::shared_ptr<Mask> mask;
    const std::vector<std::string>* names=nullptr;
    double length=${context.doubleLiteral(context.numericValue(initial("cLen"),controller.file))};
    double mode=${context.doubleLiteral(context.numericValue(initial("cMode"),controller.file))};
    bool disabled=false,allocated=false;
};
// ${context.provenance(module,"createAnimationGroupMask")}
template<class Mask> std::shared_ptr<Mask> gltf_make_animation_mask(const std::vector<std::string>& names,bool include) {
    const double mode=include?${context.doubleLiteral(context.numericValue(include,maskFile))}:${context.doubleLiteral(context.numericValue(exclude,maskFile))};
${factoryBody}
}
// ${context.provenance(module,"animationGroupMaskRetainsTarget")}
template<class Mask> bool gltf_animation_mask_retains(const std::shared_ptr<Mask>& mask,const std::string& name) {
${retainsBody}
}
// ${context.provenance(module,"resolveAnimationMask")}
template<class Mask,class Names> void gltf_resolve_animation_mask(const std::shared_ptr<Mask>& mask,const Names& node_names,std::vector<std::uint8_t>& out,double node_count) {
${resolveBody}
}
// ${context.provenance(controllerModule,"createAnimationController._setMask")}
template<class Group,class Names> void gltf_sync_animation_mask(Group& group,const Names& node_names) {
    const auto& mask=group.mask;
    auto& cache=group.mask_cache;
    auto& pose=*group.pose;
${setterBody}
}`;
}
