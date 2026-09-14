#include "pal_ui_rml.cpp"

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
}

int main() try {
    using namespace bbl;
    const auto check=[](bool pass,const char* message){if(!pass)throw std::runtime_error(message);};
    const auto expectNear=[&](float actual,float expected,const char* message){
        if(std::abs(actual-expected)>0.1f){std::fprintf(stderr,"%s: %.3f != %.3f\n",message,actual,expected);check(false,message);}
    };
    check(SDL_Init(SDL_INIT_VIDEO),"SDL initialization");
    auto* window=SDL_CreateWindow("Control spacing fixture",640,480,SDL_WINDOW_HIDDEN);
    check(window!=nullptr,"Window creation");
    {
        Engine engine;
        const auto outer=ui_create_element(engine,"div");ui_set_attribute(engine,outer,"style","width:220px;height:100px;");ui_append_to_root(engine,outer);
        const auto panel=ui_create_element(engine,"div");
        ui_set_attribute(engine,panel,"style","width:100px;height:20px;padding-inline:4px 10px;padding-block:3px 7px;margin-inline:auto;background-color:#ff0000;");ui_append_child(engine,outer,panel);
        const auto range=ui_create_element(engine,"input");ui_set_attribute(engine,range,"type","range");
        ui_set_attribute(engine,range,"style","position:absolute;left:250px;top:20px;width:120px;height:16px;background-color:#00ff00;");
        ui_set_attribute(engine,range,"value","50");ui_append_to_root(engine,range);
        pal::UiRmlRuntime runtime(engine,window,640,480);
        const auto update=[&]{pal::update_ui_rml_runtime(runtime,640,480);};update();
        auto* raw=runtime.projected_elements.at(panel.value).element;
        auto* raw_range=runtime.projected_elements.at(range.value).element;
        const auto edge=[&](Rml::BoxEdge edge){return raw->GetBox().GetEdge(Rml::BoxArea::Padding,edge);};
        const auto themeAlpha=[&](std::uint32_t x){
            const auto& frame=pal::record_ui_rml_frame(runtime,640,480);
            for(const auto& texture:frame.textures) if(texture.width==120&&texture.height==16&&texture.rgba)
                return texture.rgba->at((8*texture.width+x)*4+3);
            throw std::runtime_error("Missing range texture");
        };
        expectNear(edge(Rml::BoxEdge::Left),4,"logical start padding");expectNear(edge(Rml::BoxEdge::Right),10,"logical end padding");
        expectNear(edge(Rml::BoxEdge::Top),3,"block start padding");expectNear(edge(Rml::BoxEdge::Bottom),7,"block end padding");
        expectNear(raw->GetBox().GetSize(Rml::BoxArea::Border).x,114,"logical padding contributes to border width");
        expectNear(raw->GetAbsoluteOffset(Rml::BoxArea::Border).x,53,"logical auto margins center border box");
        check(themeAlpha(4)>0,"automatic range track paints");
        ui_set_style_property(engine,range,"appearance","none");update();
        check(themeAlpha(4)==0&&themeAlpha(60)>0,"appearance none removes the track and retains the native thumb");
        check(raw_range->GetBox().GetSize().x==120,"appearance retains control geometry");
        check(raw_range->Focus(),"appearance retains focus");
        auto* control=rmlui_dynamic_cast<Rml::ElementFormControl*>(raw_range);check(control!=nullptr,"range control");
        const auto initial_value=std::stof(control->GetValue());runtime.context->ProcessKeyDown(Rml::Input::KI_RIGHT,0);runtime.context->ProcessKeyUp(Rml::Input::KI_RIGHT,0);update();
        check(std::stof(control->GetValue())>initial_value,"appearance retains range keyboard input");
        ui_set_style_property(engine,range,"-webkit-appearance","auto");update();check(themeAlpha(4)>0,"prefixed alias restores theme");
        ui_set_style_property(engine,panel,"padding-inline","6px 12px");ui_set_style_property(engine,panel,"padding-left","8px");
        ui_set_style_property(engine,panel,"padding-block-end","9px");update();
        expectNear(edge(Rml::BoxEdge::Left),8,"later physical edge wins");expectNear(edge(Rml::BoxEdge::Right),12,"logical other edge remains");expectNear(edge(Rml::BoxEdge::Bottom),9,"logical edge write");
        ui_set_style_property(engine,panel,"padding-inline-start","11px");update();expectNear(edge(Rml::BoxEdge::Left),11,"later logical edge wins");
        ui_set_style_property(engine,panel,"padding-inline","");update();
        expectNear(edge(Rml::BoxEdge::Left),0,"shorthand removal clears first edge");expectNear(edge(Rml::BoxEdge::Right),0,"shorthand removal clears second edge");
        ui_set_attribute(engine,panel,"style","width:100px;height:20px;padding-inline:5px;padding-block:2px;margin-block:3px 6px;");update();
        expectNear(edge(Rml::BoxEdge::Left),5,"cssText resets prior logical writes");expectNear(edge(Rml::BoxEdge::Right),5,"single value replicates");
        expectNear(raw->GetBox().GetEdge(Rml::BoxArea::Margin,Rml::BoxEdge::Top),3,"block margin start");
        expectNear(raw->GetBox().GetEdge(Rml::BoxArea::Margin,Rml::BoxEdge::Bottom),6,"block margin end");
    }
    SDL_DestroyWindow(window);SDL_Quit();return 0;
} catch(const std::exception& error){std::fprintf(stderr,"Control spacing failure: %s\n",error.what());return 1;}
