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
        if(std::abs(actual-expected)>.1f){std::fprintf(stderr,"%s: %.3f != %.3f\n",message,actual,expected);check(false,message);}
    };
    check(SDL_Init(SDL_INIT_VIDEO),"SDL initialization");
    auto* window=SDL_CreateWindow("Grid track fixture",640,480,SDL_WINDOW_HIDDEN);
    check(window!=nullptr,"Window creation");
    {
        Engine engine;
        const auto make=[&](const char* style){auto h=ui_create_element(engine,"div");ui_set_attribute(engine,h,"style",style);return h;};
        const auto grid=make("position:absolute;left:10px;top:10px;display:grid;width:200px;gap:10px;grid-template-columns:minmax(0,1fr) minmax(80px,1fr);");
        std::vector<UiElementHandle> cells;
        for(int i=0;i<4;++i){auto cell=make("height:20px;background-color:#00ff00;");ui_set_attribute(engine,cell,"class","cell");ui_append_child(engine,grid,cell);cells.push_back(cell);}
        ui_append_to_root(engine,grid);
        const auto line=make("position:absolute;left:10px;top:200px;width:300px;");
        const auto inline_grid=make("display:inline-grid;grid-template-columns:repeat(3,24px);gap:8px;");
        for(int i=0;i<3;++i)ui_append_child(engine,inline_grid,make("height:20px;"));
        const auto adjacent=make("display:inline-block;width:40px;height:20px;");
        ui_append_child(engine,line,inline_grid);ui_append_child(engine,line,adjacent);ui_append_to_root(engine,line);
        const auto text_line=make("position:absolute;left:10px;top:260px;width:300px;font-size:14px;line-height:20px;");
        const auto text_grid=make("display:inline-grid;width:60px;grid-template-columns:1fr;");
        const auto paragraph=make("");ui_set_text(engine,paragraph,"alpha beta gamma");ui_append_child(engine,text_grid,paragraph);
        const auto text_peer=make("display:inline-block;width:60px;");ui_set_text(engine,text_peer,"alpha");
        ui_append_child(engine,text_line,text_grid);ui_append_child(engine,text_line,text_peer);ui_append_to_root(engine,text_line);
        const auto controls=make("position:absolute;left:10px;top:340px;width:300px;display:grid;grid-template-columns:70px 1fr 48px;gap:8px;");
        ui_append_child(engine,controls,make("height:20px;"));
        const auto range=ui_create_element(engine,"input");ui_set_attribute(engine,range,"type","range");
        ui_set_attribute(engine,range,"style","width:100%;box-sizing:border-box;padding:0;margin:0;border-width:0;");
        ui_append_child(engine,controls,range);ui_append_child(engine,controls,make("height:20px;"));ui_append_to_root(engine,controls);
        const auto responsive=make("position:absolute;left:320px;top:200px;width:200px;");
        ui_set_attribute(engine,responsive,"class","responsive");ui_set_attribute(engine,responsive,"id","responsive-grid");
        const auto responsive_first=make("height:10px;");const auto responsive_second=make("height:20px;");
        ui_append_child(engine,responsive,responsive_first);ui_append_child(engine,responsive,responsive_second);ui_append_to_root(engine,responsive);
        const auto base_sheet=ui_create_element(engine,"style");ui_append_to_root(engine,base_sheet);
        ui_add_class_style(engine,base_sheet,"responsive","display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;");
        ui_add_class_style(engine,base_sheet,"wide-cell","width:130px;");
        ui_add_style_rule(engine,base_sheet,UiStyleSelectorKind::Class,"responsive",{},{},false,480,"grid-template-columns:1fr;");
        const auto override_sheet=ui_create_element(engine,"style");ui_append_to_root(engine,override_sheet);
        ui_add_id_style(engine,override_sheet,"responsive-grid","grid-template-columns:2fr 1fr;");
        pal::UiRmlRuntime runtime(engine,window,640,480);
        const auto update=[&](int width=640){pal::update_ui_rml_runtime(runtime,width,480);};
        const auto raw=[&](UiElementHandle h){return runtime.projected_elements.at(h.value).element;};
        const auto offset=[&](UiElementHandle h,UiElementHandle parent){return raw(h)->GetAbsoluteOffset(Rml::BoxArea::Border)-raw(parent)->GetAbsoluteOffset(Rml::BoxArea::Content);};
        update();
        expectNear(raw(cells[0])->GetBox().GetSize().x,95.f,"equal flexible columns");
        expectNear(offset(cells[1],grid).x,105.f,"second column includes gap");
        expectNear(offset(cells[2],grid).y,30.f,"row-major placement");
        expectNear(raw(grid)->GetBox().GetSize().y,50.f,"auto row height and gap");
        expectNear(raw(inline_grid)->GetBox().GetSize().x,88.f,"inline grid intrinsic track width");
        expectNear(offset(adjacent,line).x,88.f,"inline grid shares its line");
        expectNear(offset(adjacent,line).y,0.f,"inline grid outer display");
        expectNear(offset(inline_grid,line).y,0.f,"textless grid exports the first item's bottom baseline");
        check(raw(text_grid)->GetClientHeight()>30.f,"baseline fixture wraps onto multiple lines");
        expectNear(offset(text_grid,text_line).y,offset(text_peer,text_line).y,"inline grid exports the first text line baseline");
        expectNear(raw(range)->GetBox().GetSize(Rml::BoxArea::Border).x,166.f,"percentage range width resolves against fractional cell");
        ui_set_style_property(engine,controls,"width","240px");update();
        expectNear(raw(range)->GetBox().GetSize().x,106.f,"percentage range compresses below its intrinsic minimum");
        ui_set_style_property(engine,range,"width","auto");update();
        expectNear(raw(range)->GetBox().GetSize().x,129.f,"automatic range width retains its intrinsic minimum");
        ui_set_style_property(engine,range,"max-width","100%");update();
        expectNear(raw(range)->GetBox().GetSize().x,106.f,"percentage maximum compresses a replaced grid contribution");
        ui_set_style_property(engine,range,"min-width","120px");update();
        expectNear(raw(range)->GetBox().GetSize().x,120.f,"explicit minimum floors a compressed contribution");
        ui_set_style_property(engine,range,"width","100%");
        ui_remove_style_property(engine,range,"max-width");ui_remove_style_property(engine,range,"min-width");
        ui_set_style_property(engine,controls,"width","300px");update();
        expectNear(raw(responsive_first)->GetClientWidth(),190.f*2.f/3.f,"ID rule wins across grid declarations");
        update(400);
        expectNear(raw(responsive_first)->GetClientWidth(),190.f*2.f/3.f,"specificity wins over later responsive class rule");
        ui_remove(engine,override_sheet);update(400);
        expectNear(raw(responsive_first)->GetClientWidth(),200.f,"responsive query changes column count after sheet removal");
        expectNear(offset(responsive_second,responsive).y,20.f,"responsive rows use independent item heights");
        update();
        expectNear(raw(responsive_first)->GetClientWidth(),95.f,"viewport reversion restores two columns");
        ui_set_attribute(engine,responsive_first,"class","wide-cell");update();
        expectNear(raw(responsive_first)->GetClientWidth(),130.f,"class mutation can overflow fixed cell allocation");
        expectNear(offset(responsive_second,responsive).x,105.f,"overflowing item does not move the next track");
        ui_set_attribute(engine,responsive,"class","");update();
        check(raw(responsive)->GetDisplay()==Rml::Style::Display::Block,"class reset restores block display");
        check(raw(responsive_first)->GetParentNode()==raw(responsive),"display changes preserve authored parent");
        ui_set_attribute(engine,responsive_first,"class","");
        ui_set_attribute(engine,responsive,"class","responsive");ui_append_to_root(engine,override_sheet);update();
        expectNear(offset(responsive_second,responsive).x,190.f*2.f/3.f+10.f,"reattached sheet restores track cascade");
        Rml::ElementList matches;raw(grid)->QuerySelectorAll(matches,":scope > .cell");check(matches.size()==4,"grid retains direct-child selectors");
        ui_set_style_property(engine,grid,"width","120px");update();
        expectNear(raw(cells[0])->GetBox().GetSize().x,30.f,"minimum freezes larger fractional column");
        expectNear(raw(cells[1])->GetBox().GetSize().x,80.f,"pixel minimum retained");
        expectNear(offset(cells[1],grid).x,40.f,"frozen column offset");
        ui_set_style_property(engine,grid,"grid-template-columns","repeat(3,24px)");
        ui_set_style_property(engine,grid,"column-gap","8px");update();
        expectNear(offset(cells[2],grid).x,64.f,"live fixed column list");
        expectNear(offset(cells[3],grid).y,30.f,"live column count changes row placement");
        expectNear(raw(cells[0])->GetBox().GetSize().x,24.f,"fixed track stretch");
        ui_set_style_property(engine,grid,"justify-content","space-between");update();
        expectNear(offset(cells[1],grid).x,48.f,"track distribution includes authored gap");
        expectNear(offset(cells[2],grid).x,96.f,"last distributed track");
        ui_set_style_property(engine,grid,"justify-content","");
        ui_set_style_property(engine,cells[0],"display","none");update();
        expectNear(offset(cells[1],grid).x,0.f,"hidden item leaves placement");
        expectNear(raw(grid)->GetBox().GetSize().y,20.f,"hidden item removes auto row");
        ui_set_style_property(engine,cells[0],"display","block");
        ui_set_style_property(engine,grid,"grid-template-rows","repeat(3,30px)");update();
        expectNear(offset(cells[3],grid).y,40.f,"fixed row height");
        expectNear(raw(grid)->GetBox().GetSize().y,110.f,"empty explicit row contributes size");
        ui_set_style_property(engine,grid,"grid-template-rows","");
        ui_set_style_property(engine,grid,"grid-template-columns","none");update();
        expectNear(raw(cells[0])->GetBox().GetSize().x,120.f,"none restores one implicit column");
        expectNear(offset(cells[3],grid).y,90.f,"none restores independent rows");
        ui_set_style_property(engine,grid,"justify-content","normal");update();
        expectNear(raw(cells[0])->GetBox().GetSize().x,120.f,"explicit normal stretches auto tracks");
        ui_set_style_property(engine,grid,"grid-template-columns","REPEAT(2, MINMAX(0, 1FR))");update();
        expectNear(raw(cells[0])->GetBox().GetSize().x,56.f,"case-insensitive native track parsing");
        ui_set_style_property(engine,grid,"height","110px");
        ui_set_style_property(engine,grid,"grid-template-rows","minmax(0,1fr) minmax(0,2fr)");update();
        expectNear(offset(cells[2],grid).y,100.f/3.f+10.f,"fractional rows share definite block space");
        ui_set_style_property(engine,grid,"height","");ui_set_style_property(engine,grid,"grid-template-rows","");
        ui_set_style_property(engine,grid,"grid-template-columns","minmax(0,.25fr) minmax(0,.25fr)");
        ui_set_style_property(engine,grid,"column-gap","0px");update();
        expectNear(raw(cells[0])->GetBox().GetSize().x,30.f,"fractions below one retain unused space");
        expectNear(offset(cells[1],grid).x,30.f,"partial fractions retain track offsets");
        ui_set_style_property(engine,grid,"grid-template-columns","1fr 1fr");
        ui_set_style_property(engine,grid,"width","160px");
        ui_set_text(engine,cells[0],"alpha beta gamma");update();
        expectNear(raw(cells[0])->GetBox().GetSize().x,80.f,"automatic minimum uses unbreakable content");
        expectNear(raw(cells[1])->GetBox().GetSize().x,80.f,"wrapped text does not force max-content columns");
        ui_set_style_property(engine,cells[0],"min-width","100px");update();
        expectNear(raw(cells[0])->GetBox().GetSize().x,100.f,"explicit item minimum sizes auto-minimum fraction");
        expectNear(raw(cells[1])->GetBox().GetSize().x,60.f,"remaining fraction respects item minimum");
        ui_set_style_property(engine,cells[0],"min-width","0px");
        ui_set_style_property(engine,grid,"width","40px");update();
        expectNear(raw(cells[0])->GetBox().GetSize().x,20.f,"explicit zero disables automatic item minimum");
        ui_set_text(engine,cells[0],"");
        ui_remove(engine,cells[1]);update();
        check(raw(cells[2])->GetParentNode()==raw(grid),"child removal retains authored parents");
        expectNear(offset(cells[2],grid).x,20.f,"child removal repacks columns");
        ui_set_style_property(engine,grid,"width","200px");
        ui_set_style_property(engine,grid,"grid-template-columns","repeat(2,minmax(0,1fr))");
        ui_set_style_property(engine,cells[0],"width","100%");
        ui_set_style_property(engine,cells[0],"padding-left","10%");ui_set_style_property(engine,cells[0],"padding-right","10%");
        ui_set_style_property(engine,cells[0],"box-sizing","border-box");update();
        expectNear(raw(cells[0])->GetBox().GetSize(Rml::BoxArea::Border).x,100.f,"percentage width uses cell border box");
        expectNear(raw(cells[0])->GetClientWidth(),100.f,"client width includes percentage padding");
        expectNear(raw(cells[0])->GetBox().GetSize().x,80.f,"percentage padding uses the cell inline size");
        ui_set_style_property(engine,cells[0],"max-width","50%");update();
        expectNear(raw(cells[0])->GetBox().GetSize(Rml::BoxArea::Border).x,50.f,"percentage maximum uses cell size");
        ui_set_style_property(engine,cells[0],"padding-left","");ui_set_style_property(engine,cells[0],"padding-right","");
        ui_set_style_property(engine,cells[0],"width","20%");ui_set_style_property(engine,cells[0],"min-width","60%");ui_set_style_property(engine,cells[0],"max-width","80%");
        ui_set_style_property(engine,cells[0],"margin-left","5%");update();
        expectNear(raw(cells[0])->GetBox().GetSize().x,60.f,"percentage minimum overrides specified width");
        expectNear(offset(cells[0],grid).x,5.f,"percentage margin uses cell size");
        ui_set_style_property(engine,grid,"grid-template-columns","repeat(0,20px)");
        bool refused=false;try{update();}catch(const std::runtime_error& error){refused=std::string(error.what()).find("UI grid tracks")!=std::string::npos;}
        check(refused,"invalid native track syntax refuses");
    }
    SDL_DestroyWindow(window);SDL_Quit();return 0;
} catch(const std::exception& error){std::fprintf(stderr,"Grid tracks failure: %s\n",error.what());return 1;}
