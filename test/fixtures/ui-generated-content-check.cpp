#define BBLITE_WORKERS 1
#define BBLITE_OFFSCREEN_SURFACES 1
#define main generated_main
#include "../../artifacts/ui-generated-content/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() { static Engine document; return document; }
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope; EventLoop loop; WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); }); return 0;
}
}

int main() {
    using namespace bbl;
    using Pseudo = Rml::Element::PseudoElement;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("Generated content fixture",640,480,SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine=pal::window_document_engine();
        assert(generated_main()==0);
        pal::UiRmlRuntime runtime(engine,window,640,480);
        const auto item=ui_get_element_by_id(engine,"item"), panel=ui_get_element_by_id(engine,"panel"), tail=ui_get_element_by_id(engine,"tail");
        const auto raw=[&](UiElementHandle handle) { return runtime.projected_elements.at(handle.value).element; };
        const auto update=[&](std::uint32_t width=640) { pal::update_ui_rml_runtime(runtime,width,480); };
        const auto box=[&](UiElementHandle handle,Pseudo pseudo) -> Rml::Element* {
            auto* origin=raw(handle);
            for(int i=0;i<origin->GetNumChildren();++i) if(origin->GetChild(i)->GetPseudoElement()==pseudo) return origin->GetChild(i);
            return nullptr;
        };
        const auto text=[&](Rml::Element* element) {
            assert(element);
            const auto collect=[](const auto& self,Rml::Element* node) -> std::string {
                if(auto* value=rmlui_dynamic_cast<Rml::ElementText*>(node)) return value->GetText();
                std::string value;
                for(int i=0;i<node->GetNumChildren();++i) value+=self(self,node->GetChild(i));
                return value;
            };
            return collect(collect,element);
        };
        const auto matches=[&](UiElementHandle handle,std::string_view selector) {
            bool found=false;
            runtime.for_each_matching_style_rule(handle,[&](const UiStyleRule& rule,std::size_t) {
                found=found || pal::ui_style_rule_selector(rule)==selector;
            }); return found;
        };
        update();
        assert(box(panel,Pseudo::Before));
        assert(box(panel,Pseudo::Before)->GetBox().GetSize().y==11);
        assert(text(box(item,Pseudo::Before))=="ID:Ready");
        assert(text(box(item,Pseudo::After))=="End");
        assert(text(box(tail,Pseudo::Before))=="/* keep */ @keyframes literal { }");
        assert(box(item,Pseudo::After)->GetBox().GetSize().y==15);
        assert(raw(item)->GetInnerRML().empty());
        assert(raw(panel)->GetChild(0)==box(panel,Pseudo::Before));
        assert(matches(item,".panel > .item:empty"));
        assert(matches(item,".panel > .item:nth-child(1)"));
        assert(matches(tail,".item + .tail"));
        assert(matches(tail,".tail:only-of-type"));
        assert(raw(panel)->QuerySelector(".item:first-child")==raw(item));
        assert(raw(item)->QuerySelector("*")==nullptr);
        const auto color=[&](std::uint8_t r,std::uint8_t g,std::uint8_t b) {
            const auto value=box(item,Pseudo::Before)->GetProperty(Rml::PropertyId::Color)->Get<Rml::Colourb>();
            assert(value.red==r && value.green==g && value.blue==b);
        };
        color(0x11,0x22,0x33);
        ui_remove_attribute(engine,item,"id"); update();
        assert(text(box(item,Pseudo::Before))=="<b>{Ready}");
        ui_set_attribute(engine,item,"id","item"); update();
        raw(panel)->SetPseudoClass("hover",true); update();
        color(0x44,0x55,0x66);
        assert(text(box(item,Pseudo::Before))=="ID:Ready");
        ui_set_attribute(engine,item,"data-label","<em>Now</em>"); update();
        assert(text(box(item,Pseudo::Before))=="ID:<em>Now</em>");
        assert(box(item,Pseudo::Before)->QuerySelector("em")==nullptr);
        ui_set_attribute(engine,item,"class","item off"); update();
        assert(!box(item,Pseudo::Before));
        ui_set_attribute(engine,item,"class","item"); update();
        assert(text(box(item,Pseudo::Before))=="ID:<em>Now</em>");
        update(400); assert(text(box(item,Pseudo::Before))=="Narrow");
        update(640); assert(text(box(item,Pseudo::Before))=="ID:<em>Now</em>");
        ui_set_text(engine,item,"Authored"); update();
        assert(text(box(item,Pseudo::Before))=="ID:<em>Now</em>");
        assert(!matches(item,".panel > .item:empty"));
        assert(raw(item)->GetChild(0)==box(item,Pseudo::Before));
        assert(raw(item)->GetChild(raw(item)->GetNumChildren()-1)==box(item,Pseudo::After));
        ui_append_child(engine,panel,item); update();
        assert(!matches(item,".panel > .item:nth-child(1)"));
        assert(!matches(tail,".item + .tail"));
        ui_remove(engine,ui_get_element_by_id(engine,"sheet")); update();
        assert(!box(panel,Pseudo::Before) && !box(item,Pseudo::Before) && !box(item,Pseudo::After));
    }
    SDL_DestroyWindow(window); SDL_Quit();
}
