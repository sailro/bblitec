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
    auto* window=SDL_CreateWindow("Implicit grid fixture",640,480,SDL_WINDOW_HIDDEN);
    check(window!=nullptr,"Window creation");
    {
        Engine engine;
        const auto make=[&](const char* tag,const char* style){const auto h=ui_create_element(engine,tag);ui_set_attribute(engine,h,"style",style);return h;};
        const auto grid=make("div","position:absolute;left:10px;top:10px;display:grid;width:120px;height:100px;row-gap:10px;align-items:center;justify-items:center;");
        const auto first=make("div","width:20px;height:10px;background-color:#ff0000;pointer-events:auto;flex:1 1 0px;");
        const auto second=make("div","width:40px;height:30px;background-color:#00ff00;pointer-events:auto;");
        ui_set_attribute(engine,first,"class","item");ui_set_attribute(engine,second,"class","item");
        ui_append_child(engine,grid,first);ui_append_child(engine,grid,second);ui_append_to_root(engine,grid);
        const auto caption=make("button","position:absolute;left:200px;top:10px;width:80px;height:60px;padding:0;border-width:0;display:grid;align-items:center;justify-items:center;");
        ui_set_text(engine,caption,"Label");ui_append_to_root(engine,caption);
        const auto list=make("ul","position:absolute;left:400px;top:10px;width:100px;margin:0;padding:0;");
        const auto li1=make("li","height:10px;background-color:#0000ff;");
        const auto li2=make("li","height:20px;background-color:#0000ff;");
        ui_append_child(engine,list,li1);ui_append_child(engine,list,li2);ui_append_to_root(engine,list);
        const auto static_grid=make("div","display:grid;width:60px;height:40px;background-color:#990099;pointer-events:auto;");
        const auto later_block=make("div","width:60px;height:40px;margin-top:-40px;background-color:#0000ff;pointer-events:auto;");
        ui_append_to_root(engine,static_grid);ui_append_to_root(engine,later_block);
        pal::UiRmlRuntime runtime(engine,window,640,480);
        const auto update=[&]{pal::update_ui_rml_runtime(runtime,640,480);};update();
        const auto raw=[&](UiElementHandle h){return runtime.projected_elements.at(h.value).element;};
        const auto offset=[&](UiElementHandle h,UiElementHandle parent){return raw(h)->GetAbsoluteOffset(Rml::BoxArea::Border)-raw(parent)->GetAbsoluteOffset(Rml::BoxArea::Content);};
        check(raw(grid)->GetDisplay()==Rml::Style::Display::Grid,"native grid display");
        const auto later_position=raw(later_block)->GetAbsoluteOffset(Rml::BoxArea::Border);
        check(runtime.context->GetElementAtPoint(later_position+Rml::Vector2f(2,2))==raw(later_block),"static grid uses block stacking order");
        expectNear(offset(first,grid).x,50.f,"first centered x");expectNear(offset(first,grid).y,12.5f,"first auto row y");
        expectNear(offset(second,grid).x,40.f,"second centered x");expectNear(offset(second,grid).y,57.5f,"second auto row y");
        expectNear(raw(first)->GetBox().GetSize().x,20.f,"grid ignores child flex sizing");
        check(raw(first)->GetParentNode()==raw(grid)&&raw(second)->GetParentNode()==raw(grid),"authored parents retained");
        Rml::ElementList matches;raw(grid)->QuerySelectorAll(matches,":scope > .item");check(matches.size()==2,"structural selectors retain grid children");
        auto* text=raw(caption)->GetChild(0);check(text!=nullptr,"anonymous text item");
        const auto text_size=text->GetBox().GetSize(Rml::BoxArea::Border);
        const auto text_offset=text->GetAbsoluteOffset(Rml::BoxArea::Border)-raw(caption)->GetAbsoluteOffset(Rml::BoxArea::Content);
        check(text_size.x>0&&text_size.y>0,"text has intrinsic size");
        expectNear(text_offset.x,(80.f-text_size.x)*0.5f,"text centered x");expectNear(text_offset.y,(60.f-text_size.y)*0.5f,"text centered y");
        expectNear(offset(li1,list).y,0.f,"first unmarked list item");expectNear(offset(li2,list).y,10.f,"list items remain blocks");
        expectNear(raw(list)->GetBox().GetSize().y,30.f,"unmarked list content height");
        const auto first_position=raw(first)->GetAbsoluteOffset(Rml::BoxArea::Border);
        check(runtime.context->GetElementAtPoint(first_position+Rml::Vector2f(2,2))==raw(first),"grid hit testing");
        const auto& frame=pal::record_ui_rml_frame(runtime,640,480);
        check(std::any_of(frame.vertices.begin(),frame.vertices.end(),[](const auto& v){return v.red==255&&v.green==0&&v.blue==0&&v.alpha==255;}),"grid item painting");
        ui_set_style_property(engine,grid,"width","160px");ui_set_style_property(engine,grid,"height","140px");update();
        expectNear(offset(first,grid).x,70.f,"resized centered x");expectNear(offset(first,grid).y,22.5f,"resized first row");expectNear(offset(second,grid).y,87.5f,"resized second row");
        ui_set_style_property(engine,second,"display","none");update();
        expectNear(offset(first,grid).y,65.f,"hidden item removes implicit row and gap");
        ui_set_style_property(engine,second,"display","block");ui_set_style_property(engine,first,"justify-self","end");ui_set_style_property(engine,second,"align-self","start");update();
        expectNear(offset(first,grid).x,140.f,"inline self override");expectNear(offset(second,grid).y,65.f,"block self override");
        const auto third=make("div","width:30px;height:20px;");ui_append_child(engine,grid,third);update();
        check(raw(third)->GetParentNode()==raw(grid),"live child keeps authored parent");
        expectNear(offset(third,grid).y,110.f,"live child gets third auto row");
        ui_remove(engine,second);update();
        expectNear(offset(third,grid).y,95.f,"removed child removes row");
        ui_remove(engine,third);ui_append_child(engine,grid,second);
        ui_set_style_property(engine,first,"justify-self","");ui_set_style_property(engine,second,"align-self","");
        ui_set_style_property(engine,grid,"width","10px");ui_set_style_property(engine,grid,"height","100px");update();
        expectNear(offset(first,grid).x,10.f,"overflow uses common intrinsic column");expectNear(offset(second,grid).x,0.f,"widest item establishes column minimum");
        ui_set_style_property(engine,grid,"width","120px");ui_set_style_property(engine,grid,"place-items","stretch");
        ui_set_style_property(engine,first,"width","auto");ui_set_style_property(engine,first,"height","auto");
        ui_set_style_property(engine,second,"width","auto");ui_set_style_property(engine,second,"height","auto");update();
        expectNear(raw(first)->GetBox().GetSize().x,120.f,"auto item inline stretch");expectNear(raw(first)->GetBox().GetSize().y,45.f,"auto item block stretch");
        expectNear(offset(second,grid).y,55.f,"stretched rows retain separate gap");
        ui_set_style_property(engine,first,"width","20px");ui_set_style_property(engine,first,"height","10px");
        ui_set_style_property(engine,second,"width","40px");ui_set_style_property(engine,second,"height","30px");
        ui_set_style_property(engine,grid,"place-items","center");ui_set_style_property(engine,grid,"align-content","center");update();
        expectNear(offset(first,grid).y,25.f,"content alignment centers auto tracks");expectNear(offset(second,grid).y,45.f,"content alignment keeps gap");
        ui_set_style_property(engine,grid,"align-content","");ui_set_style_property(engine,grid,"justify-content","center");
        ui_set_style_property(engine,grid,"place-items","center start");update();
        expectNear(offset(first,grid).x,40.f,"track centering is independent of item start alignment");expectNear(offset(second,grid).x,40.f,"single intrinsic track");
        ui_set_style_property(engine,grid,"justify-content","");ui_set_style_property(engine,grid,"place-items","center");
        ui_set_style_property(engine,first,"margin-left","auto");ui_set_style_property(engine,second,"margin-top","auto");update();
        expectNear(offset(first,grid).x,100.f,"inline auto margin precedes alignment");expectNear(offset(second,grid).y,70.f,"block auto margin precedes alignment");
        ui_set_style_property(engine,first,"margin-left","");ui_set_style_property(engine,second,"margin-top","");ui_remove(engine,second);
        ui_set_style_property(engine,grid,"height","auto");ui_set_style_property(engine,grid,"min-height","80px");update();
        expectNear(raw(grid)->GetBox().GetSize().y,80.f,"minimum auto height");expectNear(offset(first,grid).y,35.f,"minimum height stretches auto row");
        ui_set_style_property(engine,grid,"place-items","");update();
        expectNear(offset(first,grid).x,0.f,"shorthand removal clears its inline longhands");
        ui_set_style_property(engine,grid,"place-items","center");
        ui_set_style_property(engine,first,"width","50%");
        bool refused=false;try {update();}catch(const std::runtime_error& error){refused=std::string(error.what()).find("percentage-dependent")!=std::string::npos;}
        check(refused,"unrepresented percentage sizing refuses instead of producing flex geometry");
    }
    SDL_DestroyWindow(window);SDL_Quit();return 0;
} catch(const std::exception& error){std::fprintf(stderr,"Implicit grid failure: %s\n",error.what());return 1;}
