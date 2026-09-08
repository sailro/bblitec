import { LoweringContext } from "./context.js";
import ts from "typescript";
import { PinnedNumericLowerer, type PinnedBinding, type PinnedNumericScope } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { defaultTextDataContracts } from "./text-data-update-contracts.js";

const module = "src/text/text-data.ts";
const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });

/** The incremental allocator for the single run owned by DefaultTextData.
 * Source-owned numeric helpers use the common AST lowerer. */
export class TextDataUpdateLowerer {
    public constructor(private readonly context: LoweringContext) {}

    private body(name: string, parameters: readonly string[]): string {
        const c: LoweringContext = this.context;
        const {file,declaration} = c.functionDeclaration(module,name);
        const fields = new Map([
            ["_instanceCount","instance_count"],["_styleCount","style_count"],["_version","version"],["_styleVersion","style_version"],
            ["_layoutVersion","layout_version"],["_dirtyStart","dirty_start"],["_dirtyEnd","dirty_end"],
        ]);
        const bindings = new Map<string,PinnedBinding>([
            ...parameters.map(p => [p, scalar(p)] as const),
            ...[...fields].map(([a,b]) => [`data.${a}`,scalar(`data.${b}`)] as const),
            ["data._instances",{cpp:"data.instances",type:"f32",mutable:true}],
            ["data._styles",{cpp:"data.styles",type:"f32",mutable:true}],
            ["color",{cpp:"color",type:"f64-buffer"}],
            ["data",{cpp:"data",type:"opaque"}], ["group",{cpp:"data",type:"opaque"}],
            ["curveSet",{cpp:"data",type:"opaque"}],
            ["group._slotStart",scalar("0.0")], ["group._slotCount",scalar("data.slot_count")],
            ["group._freeSlots",{cpp:"data.free_slots",type:"f64-list"}],
            ["slots",{cpp:"slots",type:"f64-list"}],
            ["out",{cpp:"data.instances",type:"f32",mutable:true}],
            ["outU32",{cpp:"outU32",type:"u32",mutable:true}],
            ["data._instancesU32",{cpp:"outU32",type:"u32",mutable:true}],
            ["ascendingSlot",{cpp:"ascending_slot",type:"opaque"}],
            ["Number.POSITIVE_INFINITY",scalar("std::numeric_limits<double>::infinity()")],
            ["run.pixelsPerFontUnit",scalar("layout.pixels_per_font_unit")],
            ["run.glyphs.length",scalar("static_cast<double>(layout.glyphs.size())")],
            ["styleSlots",{cpp:"styleSlots",type:"f64-buffer"}],
            ["pg",{cpp:"pg",type:"opaque"}],
            ["pg.glyphId",scalar("pg.glyph_id")], ["pg.x",scalar("pg.x")], ["pg.y",scalar("pg.y")],
            ["group._curveSet",{cpp:"data",type:"opaque"}],
            ["pg.color",{cpp:"",type:"opaque",staticallyAbsent:true}],
            ["color !== undefined",{cpp:"false",type:"bool",staticBoolean:false}],
            ...["TEXT_INSTANCE_FLOATS","TEXT_STYLE_FLOATS","DEAD_GLYPH","MAX_PACKED_INDEX"].map(key => [key,scalar(String(c.numericValue(c.variableInitializer(file,key),file)))] as const),
        ]);
        const statement: NonNullable<PinnedNumericScope["statement"]> = (node,lowerer,indent) => {
            if(ts.isReturnStatement(node) && node.expression) return [`${indent}return ${lowerer.expression(node.expression)};`];
            if(ts.isVariableStatement(node) && node.declarationList.declarations.length===1) {
                const d=node.declarationList.declarations[0]!;
                if(ts.isIdentifier(d.name) && d.initializer) {
                    const key=d.name.text;
                    const adapted = new Map<string,readonly [string,string,PinnedBinding]>([
                        ["atlasSlot",["curveSet._atlas._glyphSlots.get(glyphId)","const double atlasSlot=glyphId>=0 && glyphId<static_cast<double>(data.glyph_slots.size())?data.glyph_slots.at(size(glyphId)):-1;",{cpp:"atlasSlot",type:"opaque",absentCpp:"atlasSlot < 0"}]],
                        ["styleParam",["_textStyleSeam?._param(run) ?? 0","",scalar("data.style_param")]],
                        ["overrideEntry",["0","",scalar("0.0")]],
                        ["pg",["run.glyphs[i]!","const auto& pg=layout.glyphs.at(size(static_cast<double>(i)));",{cpp:"pg",type:"opaque"}]],
                        ["liveSlots",["null","std::optional<std::vector<double>> liveSlots;",{cpp:"(*liveSlots)",type:"f64-list",absentCpp:"!liveSlots"}]],
                    ]).get(key);
                    if(adapted) {
                        c.assertExpressionShape(d.initializer,adapted[0],`Text ${key} representation`);
                        bindings.set(key,adapted[2]);
                        if(key==="atlasSlot")bindings.set("atlasSlot._index",scalar("atlasSlot"));
                        return adapted[1]?[`${indent}${adapted[1]}`]:[];
                    }
                }
                if(ts.isIdentifier(d.name) && d.name.text==="out" && d.initializer) {
                    c.assertExpressionShape(d.initializer,"new Array(count).fill(-1)","Packed slot allocation");
                    bindings.set("out",{cpp:"out",type:"f64-list"});
                    return [`${indent}std::vector<double> out(size(count),-1);`];
                }
                if(ts.isIdentifier(d.name) && d.name.text==="grown" && d.initializer) {
                    c.assertExpressionShape(d.initializer,"new Float32Array(newLen)","Instance capacity allocation");
                    bindings.set("grown",{cpp:"grown",type:"f32",mutable:true});
                    return [`${indent}std::vector<float> grown(size(newLen));`];
                }
            }
            if(ts.isExpressionStatement(node) && c.expressionMatchesShape(node.expression,"grown.set(data._instances.subarray(0, data._instanceCount * TEXT_INSTANCE_FLOATS))"))
                return [`${indent}std::copy_n(data.instances.begin(), size(data.instance_count * ${c.numericValue(c.variableInitializer(file,"TEXT_INSTANCE_FLOATS"),file)}), grown.begin());`];
            if(ts.isExpressionStatement(node) && c.expressionMatchesShape(node.expression,"liveSlots = slots.slice(0, i)"))
                return [`${indent}liveSlots.emplace(slots.begin(),slots.begin()+static_cast<std::ptrdiff_t>(i));`];
            if(ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)) {
                const e=node.expression;
                if(e.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandEqualsToken)
                    return [`${indent}${lowerer.expression(e.left)} = ${lowerer.expression(e.left)} && ${lowerer.expression(e.right)};`];
                if(e.left.getText(file)==="data._instancesU32") {
                    c.assertExpressionShape(e.right,"new Uint32Array(grown.buffer)","Instance word alias after capacity growth");
                    return [];
                }
            }
            return undefined;
        };
        const lowerer = new PinnedNumericLowerer(file, { bindings, calls:new Map([...pinnedNumericMathCalls(),
            ["Math.fround",(args:readonly string[])=>`static_cast<double>(static_cast<float>(${args[0]}))`],
            ["popFreeSlot",()=>"pop_free_slot(data)"],
            ["growGroup",args=>`grow_group(data,${args[2]})`],
            ["ensureInstanceCapacity",args=>`capacity(data,${args[1]})`],
            ["markDirty",args=>`mark_dirty(data,${args[1]},${args[2]})`],
            ["markSlotDead",args=>`dead(data,${args[2]})`],
            ["out.sort",()=>"std::sort(out.begin(),out.end())"],
            ["group._freeSlots.push",args=>`data.free_slots.push_back(${args[0]})`],
            ["data._instances.copyWithin",args=>`copy_within(data.instances,${args.join(",")})`],
            ["shiftSlotsAtOrAfter",()=>"++data.layout_version"],
            ["writeStyle",args=>`write_style(data,${args.slice(1).join(",")})`],
            ["packGlyphAtSlot",args=>`pack_glyph(data,${[args[2],...args.slice(4)].join(",")})`],
            ["liveSlots.push",args=>`liveSlots->push_back(${args[0]})`],
        ]),
            expression:(node)=> {
                if(c.expressionMatchesShape(node,"run.defaultColor ?? WHITE_COLOR"))return "data.color";
                if(c.expressionMatchesShape(node,"liveSlots ?? slots"))return "liveSlots ? *liveSlots : slots";
                if(c.expressionMatchesShape(node,"liveSlots === null"))return "!liveSlots";
                if(c.expressionMatchesShape(node,"liveSlots !== null"))return "liveSlots.has_value()";
                return undefined;
            },
            forOf:(range,pinned)=> range==="slots" ? {range:"slots",bindings:new Map([[pinned,scalar(pinned)]])}:undefined,
            arrayCopy:(receiver,source,offset)=>`std::copy(${source}.begin(), ${source}.end(), ${receiver}.begin() + size(${offset}));`,
            booleanAnd:true, booleanOr:true, statement,
        });
        return `    // ${c.provenance(module,name)}\n` + declaration.body!.statements.flatMap(s => lowerer.statement(s,"    ")).join("\n");
    }

    public header(): string {
        const c: LoweringContext = this.context;
        const mark = this.body("markDirty",["startInstance","endInstance"]);
        const style = this.body("writeStyle",["entry","invScale","styleParam"]);
        const dead = this.body("markSlotDead",["slot"]);
        const capacity = this.body("ensureInstanceCapacity",["requiredInstances"]);
        const grow = this.body("growGroup",["extraSlots"]);
        const allocate = this.body("allocateSlots",["count"]);
        const free = this.body("freeSlots",[]);
        const packBody = this.body("packGlyphAtSlot",["slot","glyphId","x","y","styleIdx"]);
        const write = this.body("writeRunToSlots",[]);
        const constants = c.sourceFile(module);
        const numeric = (name:string) => c.numericValue(c.variableInitializer(constants,name),constants);
        // Only the source-owned DefaultTextData run reaches this path. Its
        // glyph records have no per-glyph colors and its group has no neighbors.
        // Compare complete body ASTs for the structural specialization; added
        // statements, reordered calls and changed branches cannot be skipped.
        for(const [path,symbol,expected] of defaultTextDataContracts) {
            const fn=c.functionDeclaration(path,symbol).declaration;
            c.assertFunctionBodyShape(fn,expected,`DefaultTextData single-run ${symbol}`);
        }
        return `#pragma once
#include <bblite/upstream_text_layout.hpp>
#include <bblite/upstream_text.hpp>
#include <bblite/js_data.hpp>
#include <cstring>
namespace bbl {
namespace text_update_detail {
inline void mark_dirty(TextLiveData& data, double startInstance, double endInstance) {
${mark}
}
inline void write_style(TextLiveData& data, double entry, const std::array<double,4>& color, double invScale, double styleParam) {
${style}
}
inline std::size_t size(double value) {
    if (!std::isfinite(value) || value < 0 || std::trunc(value) != value || value >= static_cast<double>(std::numeric_limits<std::size_t>::max())) throw std::runtime_error("Text data size is outside native capacity.");
    return static_cast<std::size_t>(value);
}
struct InstanceWords {
    struct Word { float& storage; void operator=(std::uint32_t value) { std::memcpy(&storage,&value,sizeof(value)); } };
    std::vector<float>& storage;
    Word operator[](std::size_t i) const { return {storage.at(i)}; }
};
inline void dead(TextLiveData& data, double slot) {
    InstanceWords outU32{data.instances};
${dead}
}
inline void capacity(TextLiveData& data, double requiredInstances) {
${capacity}
}
inline void free_slots(TextLiveData& data) {
    const auto& slots=data.slots;
${free}
}
inline double pop_free_slot(TextLiveData& data) {
    if(data.free_slots.empty())return -1;
    const auto slot=data.free_slots.back();data.free_slots.pop_back();return slot;
}
inline void copy_within(std::vector<float>& values,double target,double start,double end) {
    const auto length=size(end-start);
    std::memmove(values.data()+size(target),values.data()+size(start),length*sizeof(float));
}
inline double grow_group(TextLiveData& data,double extraSlots) {
${grow}
}
inline std::vector<double> allocate_slots(TextLiveData& data, double count) {
${allocate}
}
inline bool pack_glyph(TextLiveData& data,double slot,double glyphId,double x,double y,double styleIdx) {
    InstanceWords outU32{data.instances};
${packBody}
}
inline std::vector<double> write_run(TextLiveData& data, const TextLayoutResult& layout, const std::vector<double>& slots) {
    const std::array<double,1> styleSlots{0};
${write}
}
inline void publish(TextDataState& state) {
    const auto& live=*state.live; auto& payload=*state.payload;
    const bool styles_changed=state.style_version!=live.style_version;
    state.instance_count=size(live.instance_count); state.style_count=size(live.style_count);
    state.version=live.version; state.style_version=live.style_version; state.layout_version=live.layout_version;
    state.dirty_start=size(live.dirty_start); state.dirty_end=size(live.dirty_end);
    payload.instances.count=state.instance_count; payload.instances.capacity_bytes=live.instances.size()*sizeof(float);
    const bool instances_resized=payload.instances.bytes.size()!=payload.instances.capacity_bytes;
    payload.instances.bytes.resize(payload.instances.capacity_bytes);
    const auto first=instances_resized?0:state.dirty_start*${numeric("TEXT_INSTANCE_FLOATS")}*sizeof(float);
    const auto last=instances_resized?payload.instances.bytes.size():state.dirty_end*${numeric("TEXT_INSTANCE_FLOATS")}*sizeof(float);
    if(last>first)std::memcpy(payload.instances.bytes.data()+first,reinterpret_cast<const std::uint8_t*>(live.instances.data())+first,last-first);
    payload.styles.count=state.style_count; payload.styles.capacity_bytes=live.styles.size()*sizeof(float);
    if(styles_changed || payload.styles.bytes.size()!=payload.styles.capacity_bytes) {
        payload.styles.bytes.resize(payload.styles.capacity_bytes);
        if(!live.styles.empty())std::memcpy(payload.styles.bytes.data(),live.styles.data(),payload.styles.bytes.size());
    }
    auto& group=state.groups.at(0); group.slot_count=size(live.slot_count); group.live_count=live.slots.size();
}
inline void replace(TextDataState& state, const TextLayoutResult& layout, bool group_changed=false) {
    auto& data=*state.live;
    // GPU upload clears the public dirty range between source edits.
    data.dirty_start=static_cast<double>(state.dirty_start); data.dirty_end=static_cast<double>(state.dirty_end);
    const auto old_count=data.slots.size();
    auto slots=data.slots;
    if(group_changed) {
        free_slots(data);
        if(data.slot_count>0) { ++data.layout_version; data.instance_count-=data.slot_count; mark_dirty(data,0,data.instance_count); }
        data.slot_count=0; data.free_slots.clear();
        auto& group=state.groups.at(0);group.bind_group.reset();group.bind_group_version=-1;
        slots=allocate_slots(data,static_cast<double>(layout.glyphs.size()));
        data.slots=write_run(data,layout,slots);
    } else if(!layout.glyphs.empty()) {
        if(layout.glyphs.size()!=old_count) { free_slots(data); slots=allocate_slots(data,static_cast<double>(layout.glyphs.size())); }
        auto live=write_run(data,layout,slots);
        data.slots=std::move(live);
    } else {
        free_slots(data);
        if(data.slot_count>0) { ++data.layout_version; data.instance_count-=data.slot_count; mark_dirty(data,0,data.instance_count); }
        data.slot_count=0; data.free_slots.clear();
        state.groups.at(0).bind_group.reset(); state.groups.at(0).bind_group_version=-1;
        data.slots.clear();
        write_style(data,0,data.color,layout.pixels_per_font_unit!=0?1/layout.pixels_per_font_unit:0,data.style_param);
    }
    state.payload->width=layout.width; state.payload->height=layout.height;
    publish(state);
}
} // namespace text_update_detail
inline js::Array<TextRun> text_data_runs(const TextData& data) {
    if(!data || !data->live)throw std::runtime_error("Text run access lacks a compiled live font repertoire.");
    auto& live=*data->live;
    if(live.runs->empty()) {
        auto run=std::make_shared<TextRunState>();run->layout=layout_text(*live.font,live.initial_text,live.font_size,live.options);
        run->color=live.color;live.runs->push_back(run);
    }
    return js::Array<TextRun>(data->live->runs);
}
inline TextRun clone_text_run(const TextRun& source,const js::Tuple<4>& color) {
    if(!source)throw std::runtime_error("Text run is absent.");
    auto run=std::make_shared<TextRunState>();run->layout=source->layout;
    run->color=color;
    return run;
}
inline void replace_default_text_run(const TextData& data,const TextRun& previous,const TextRun& run) {
    if(!data || !data->live || data->live->runs->size()!=1 || data->live->runs->front()!=previous)
        throw std::runtime_error("updateTextData replaceRun: previous GlyphRun reference is not in this TextData.");
    if(!run)throw std::runtime_error("Text replacement run is absent.");
    auto& live=*data->live;std::copy(run->color.begin(),run->color.end(),live.color.begin());live.style_param=run->weight;
    const bool group_changed=previous->weight!=0;
    text_update_detail::replace(*data,run->layout,group_changed);
    if(group_changed)data->groups.at(0).group_key=TextGroupKey(data->payload->atlases.at(0).curve_set_id);
    live.runs->front()=run;
}
inline void update_default_text_data(const TextData& data, std::string_view text) {
    if(!data || !data->live)throw std::runtime_error("Default text data lacks a compiled live font repertoire.");
    auto layout=layout_text(*data->live->font,text,data->live->font_size,data->live->options);
    (void)text_data_runs(data);
    auto run=std::make_shared<TextRunState>();run->layout=std::move(layout);run->color=data->live->runs->front()->color;
    replace_default_text_run(data,data->live->runs->front(),run);
}
TextData create_compiled_text_data(std::uint32_t index);
inline TextData create_live_text_data(std::uint32_t index, std::string_view text, const std::optional<js::Tuple<4>>& color=std::nullopt) {
    auto data=create_compiled_text_data(index);
    auto& live=*data->live;
    if(color)for(std::size_t i=0;i<4;++i)live.color[i]=(*color)[i];
    auto layout=layout_text(*live.font,text,live.font_size,live.options);
    live.instances.assign(${numeric("TEXT_INSTANCE_FLOATS")},0);
    live.styles.assign(${numeric("TEXT_STYLE_FLOATS")},0);
    live.version=1; live.style_version=2; live.layout_version=0;
    live.instance_count=0; live.style_count=1;
    live.dirty_start=0; live.dirty_end=0;
    live.slots.resize(layout.glyphs.size());
    live.free_slots.clear();
    for(std::size_t i=0;i<live.slots.size();++i)live.slots[i]=static_cast<double>(i);
    text_update_detail::capacity(live,static_cast<double>(layout.glyphs.size()));
    live.slots=text_update_detail::write_run(live,layout,live.slots);
    live.instance_count=static_cast<double>(layout.glyphs.size());
    live.slot_count=live.instance_count;
    live.dirty_start=0; live.dirty_end=live.instance_count;
    ++live.version; ++live.layout_version;
    data->payload->width=layout.width; data->payload->height=layout.height;
    text_update_detail::publish(*data);
    auto run=std::make_shared<TextRunState>();run->layout=std::move(layout);run->color=color?*color:js::Tuple<4>{live.color};live.runs->push_back(run);
    return data;
}
} // namespace bbl
`;
    }
}
