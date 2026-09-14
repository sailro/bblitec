#include "pal_ui_rml.cpp"

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
}

int main() try {
    using namespace bbl;
    const auto check=[](bool pass,const char* message){if(!pass)throw std::runtime_error(message);};
    check(SDL_Init(SDL_INIT_VIDEO),"SDL initialization");
    auto* window=SDL_CreateWindow("UI presentation fixture",640,480,SDL_WINDOW_HIDDEN);
    check(window!=nullptr,"Window creation");
    {
        Engine engine;
        const auto panel=ui_create_element(engine,"div");
        ui_set_attribute(engine,panel,"style","width:100px;height:30px;border-top:2px #ff0000;border-right:3px #0000ff;border-bottom:4px #00ff00;border-left:5px #112233;font-style:italic;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transform-origin:left bottom;");
        ui_set_text(engine,panel,"A long caption for an intentionally narrow text container");
        ui_append_to_root(engine,panel);
        pal::UiRmlRuntime runtime(engine,window,640,480);
        const auto update=[&]{pal::update_ui_rml_runtime(runtime,640,480);};update();
        auto* raw=runtime.projected_elements.at(panel.value).element;
        const auto& box=raw->GetBox();
        check(box.GetEdge(Rml::BoxArea::Border,Rml::BoxEdge::Top)==2.f&&box.GetEdge(Rml::BoxArea::Border,Rml::BoxEdge::Right)==3.f&&
            box.GetEdge(Rml::BoxArea::Border,Rml::BoxEdge::Bottom)==4.f&&box.GetEdge(Rml::BoxArea::Border,Rml::BoxEdge::Left)==5.f,"independent border edges");
        check(raw->GetComputedValues().font_style()==Rml::Style::FontStyle::Italic&&
            raw->GetComputedValues().text_transform()==Rml::Style::TextTransform::Uppercase&&
            raw->GetComputedValues().text_overflow()==Rml::Style::TextOverflow::Ellipsis,"text presentation");
        const auto& frame=pal::record_ui_rml_frame(runtime,640,480);
        check(std::any_of(frame.vertices.begin(),frame.vertices.end(),[](const auto& v){return v.red==255&&v.green==0&&v.blue==0&&v.alpha==255;}),"border painting");
        ui_set_style_property(engine,panel,"border-width","1px 6px 3px 8px");
        ui_set_style_property(engine,panel,"border-top-color","#abcdef");
        ui_set_style_property(engine,panel,"font-style","normal");
        ui_set_style_property(engine,panel,"text-transform","lowercase");
        ui_set_style_property(engine,panel,"text-overflow","clip");update();
        check(raw->GetBox().GetEdge(Rml::BoxArea::Border,Rml::BoxEdge::Right)==6.f&&
            raw->GetBox().GetEdge(Rml::BoxArea::Border,Rml::BoxEdge::Left)==8.f,"border width replacement");
        check(raw->GetComputedValues().font_style()==Rml::Style::FontStyle::Normal&&
            raw->GetComputedValues().text_transform()==Rml::Style::TextTransform::Lowercase&&
            raw->GetComputedValues().text_overflow()==Rml::Style::TextOverflow::Clip,"live text style replacement");
        ui_set_style_property(engine,panel,"border-width","");update();
        check(raw->GetBox().GetEdge(Rml::BoxArea::Border,Rml::BoxEdge::Right)==0.f,"border shorthand removal clears its width longhands");
    }
    SDL_DestroyWindow(window);SDL_Quit();return 0;
} catch(const std::exception& error){std::fprintf(stderr,"UI presentation failure: %s\n",error.what());return 1;}
