import ts from "typescript";
import { LoweringContext } from "./context.js";
import { PinnedNumericLowerer, type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

const module="src/text/set-font-weight-offset.ts";
const scalar=(cpp:string):PinnedBinding=>({cpp,type:"scalar"});
const opaque=(cpp:string):PinnedBinding=>({cpp,type:"opaque"});

/** The opt-in setter owns its validation, identity map and rollback policy. */
export class TextWeightLowerer {
    constructor(private readonly context:LoweringContext){}
    header():string {
        const c:LoweringContext=this.context;
        const {file,declaration}=c.functionDeclaration(module,"setFontWeightOffset");
        c.assertFunctionBodyShape(c.functionDeclaration(module,"runOffset").declaration,"{return _offsets?.get(run)??0;}","Text weight nullable offset map");
        c.assertFunctionBodyShape(c.functionDeclaration(module,"runGroupKey").declaration,`{
            if(runOffset(run)===0){return run.curveSet;}
            const keys=(_keys??=new Map());let key=keys.get(run.curveSet);
            if(!key){key={};keys.set(run.curveSet,key);}return key;
        }`,"Text weight interned group identity");
        c.assertFunctionBodyShape(c.functionDeclaration(module,"variantForDevice").declaration,`{
            const variants=(_variants??=new WeakMap());let variant=variants.get(device);
            if(!variant){const composed=composeSlugShader(WEIGHT_SHADER_FRAGMENT);variant={_id:composed._key,
            _vertModule:device.createShaderModule({label:"text-vert-"+composed._key,code:composed._vert}),
            _fragModule:device.createShaderModule({label:"text-frag-"+composed._key,code:composed._frag})};variants.set(device,variant);}return variant;
        }`,"Text weight composed shader and device cache");
        c.assertFunctionBodyShape(c.functionDeclaration("src/text/text-data.ts","_resolveRunRef").declaration,`{
            if(typeof ref==="number"){const r=data._runs[ref];if(!r){throw new Error(\`\${op}: run index \${ref} out of range (0..\${data._runs.length-1}).\`);}return r;}
            if(!data._runRecords.has(ref)){throw new Error(\`\${op}: GlyphRun reference is not in this TextData.\`);}return ref;
        }`,"Text weight run ownership");
        const bindings=new Map<string,PinnedBinding>([["offset",scalar("offset")],["target",opaque("target")],
            ["data",opaque("data")],["run",opaque("run")],["variantForDevice",opaque("variant_for_device")],
            ["MAX_WEIGHT_OFFSET",scalar(String(c.numericValue(c.variableInitializer(file,"MAX_WEIGHT_OFFSET"),file)))],
        ]);
        const lowerer=new PinnedNumericLowerer(file,{bindings,booleanOr:true,
            calls:new Map([...pinnedNumericMathCalls(),
                ["Number.isFinite",(args:readonly string[])=>`std::isfinite(${args[0]})`],
                ["runOffset",(args:readonly string[])=>`${args[0]}->weight`],
                ["offsets.has",(args:readonly string[])=>`(${args[0]}->weight!=0)`],
                ["offsets.get",(args:readonly string[])=>`${args[0]}->weight`],
                ["offsets.set",(args:readonly string[])=>`${args[0]}->weight=${args[1]}`],
                ["offsets.delete",(args:readonly string[])=>`${args[0]}->weight=0`],
            ]),callShapes:new Map([["Number.isFinite","bool"],["offsets.has","bool"]]),
            expression:node=>c.expressionMatchesShape(node,"_offsets===null")?"!text_weight_installed":undefined,
            statement:(node,lowerer,indent)=>{
                if(ts.isVariableStatement(node)&&node.declarationList.declarations.length===1){
                    const variable=node.declarationList.declarations[0]!;
                    if(variable.name.getText()==="target"){
                        c.assertExpressionShape(variable.initializer!,'_resolveRunRef(data,run,"setFontWeightOffset")',"Text weight run resolution");
                        return [`${indent}const auto target=resolve_text_weight_run(data,run);`];
                    }
                    if(variable.name.getText()==="offsets"){c.assertExpressionShape(variable.initializer!,"_offsets","Text weight map alias");return [];}
                }
                if(ts.isTryStatement(node)) {
                    if(!node.catchClause||node.finallyBlock||node.catchClause.variableDeclaration?.name.getText()!=="err")c.contractError(node,"Text weight rollback boundary changed.");
                    return [`${indent}try {`,...lowerer.statements(node.tryBlock.statements,indent+"    "),`${indent}} catch(...) {`,
                        ...lowerer.statements(node.catchClause.block.statements,indent+"    "),`${indent}}`];
                }
                if(ts.isThrowStatement(node)&&ts.isIdentifier(node.expression)&&node.expression.text==="err")return [`${indent}throw;`];
                if(!ts.isExpressionStatement(node))return undefined;
                const expression=node.expression;
                if(c.expressionMatchesShape(expression,"_offsets=new WeakMap()"))return [`${indent}text_weight_installed=true;`];
                if(!ts.isCallExpression(expression))return undefined;
                const path=c.propertyPath(expression.expression)?.join(".");
                if(path==="_installTextStyleSeam"){
                    c.assertExpressionShape(expression,"_installTextStyleSeam({_key:runGroupKey,_param:runOffset})","Text weight style seam");return [];
                }
                if(path==="_installTextVariantResolver"){
                    c.assertExpressionShape(expression,"_installTextVariantResolver(variantForDevice)","Text weight variant seam");return [];
                }
                if(path==="updateTextData"){
                    c.assertExpressionShape(expression,'updateTextData(data,{update:"reset"})',"Text weight repack owner");return [`${indent}reset_weighted_text_data(*data);`];
                }
                if(path==="console.error"){
                    c.assertExpressionShape(expression,'console.error("setFontWeightOffset: offset must be finite, got",offset)',"Text weight finite diagnostic");
                    return [`${indent}std::cerr<<"setFontWeightOffset: offset must be finite, got "<<offset<<'\\n';`];
                }
                if(path==="console.warn"){
                    c.assertExpressionShape(expression,'console.warn(`setFontWeightOffset: offset ${offset} clamped to ${clamped} (range 0–${MAX_WEIGHT_OFFSET} font units).`)',"Text weight clamp diagnostic");
                    return [`${indent}std::cerr<<"setFontWeightOffset: offset "<<offset<<" clamped to "<<clamped<<'\\n';`];
                }
                return undefined;
            }});
        return `#pragma once
#include <bblite/upstream_text_update.hpp>
#include <iostream>
namespace bbl {
inline TextRun resolve_text_weight_run(const TextData& data,const TextRunRef& reference) {
    (void)text_data_runs(data);
    const auto& runs=*data->live->runs;
    if(const auto index=std::get_if<double>(&reference)) {
        if(!std::isfinite(*index)||*index<0||std::trunc(*index)!=*index||*index>=static_cast<double>(runs.size()))
            throw std::runtime_error("setFontWeightOffset: run index out of range.");
        return runs.at(static_cast<std::size_t>(*index));
    }
    const auto& run=std::get<TextRun>(reference);
    if(std::find(runs.begin(),runs.end(),run)==runs.end())throw std::runtime_error("setFontWeightOffset: GlyphRun reference is not in this TextData.");
    return run;
}
inline TextGroupKey weighted_text_group_key(const std::string& curve_set_id,double offset) {
    TextGroupKey key(curve_set_id);
    if(offset!=0){
        static std::unordered_map<std::string,std::shared_ptr<TextStyleGroupToken>> keys;
        auto& token=keys[curve_set_id];if(!token)token=std::make_shared<TextStyleGroupToken>();key.variant=token;
    }
    return key;
}
// applyReset's complete structural contract is checked by TextDataUpdateLowerer;
// DefaultTextData owns one run, one curve set and one style entry.
inline void reset_weighted_text_data(TextDataState& state) {
    auto& data=*state.live;const auto& run=*data.runs->front();
    const auto key=weighted_text_group_key(state.payload->atlases.at(0).curve_set_id,run.weight);
    auto& group=state.groups.at(0);
    if(group.group_key!=key){group.group_key=key;group.bind_group.reset();group.bind_group_version=-1;}
    std::copy(run.color.begin(),run.color.end(),data.color.begin());data.style_param=run.weight;
    text_update_detail::capacity(data,static_cast<double>(run.layout.glyphs.size()));
    data.slots.resize(run.layout.glyphs.size());
    for(std::size_t i=0;i<data.slots.size();++i)data.slots[i]=static_cast<double>(i);
    data.style_count=1;++data.style_version;data.free_slots.clear();
    data.slots=text_update_detail::write_run(data,run.layout,data.slots);
    data.instance_count=static_cast<double>(run.layout.glyphs.size());data.slot_count=data.instance_count;
    data.dirty_start=0;data.dirty_end=data.instance_count;
    ++data.version;++data.layout_version;
    text_update_detail::publish(state);
}
inline void set_font_weight_offset(const TextData& data,const TextRunRef& run,double offset) {
${lowerer.statements(declaration.body!.statements,"    ").join("\n")}
}
} // namespace bbl
`;
    }
}
