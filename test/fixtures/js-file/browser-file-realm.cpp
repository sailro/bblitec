#include <bblite/js_file.hpp>
#include <bblite/pal_async_engine.hpp>
#include <bblite/pal_window_realm.hpp>

#include <cassert>

namespace {
bbl::Engine document;
std::shared_ptr<bbl::Engine> renderer;
int downloads = 0;
} // namespace

namespace bbl::pal {
Engine& window_document_engine() { return document; }

std::shared_ptr<Engine> create_realm_engine(EngineOptions,
                                            const std::shared_ptr<OffscreenCanvas>&) {
    assert(document.object_urls.size() == 1);
    assert(document.object_urls.front().active);
    renderer = std::make_shared<Engine>();
    return renderer;
}

bool save_file(Engine& engine, const FileDialogOptions& options,
               std::span<const std::uint8_t> bytes, const std::function<void()>& validate) {
    assert(&engine == &document);
    assert(options.suggested_name == "result.txt");
    assert(std::string(bytes.begin(), bytes.end()) == "retained");
    validate();
    ++downloads;
    return true;
}

int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    assert(renderer && renderer->object_urls.empty());
    assert(document.object_urls.size() == 3);
    assert(document.free_object_url_slots.size() == 3);
    for (const auto& record : document.object_urls)
        assert(!record.active && !record.bytes);
    assert(downloads == 1);
    renderer.reset();
    return 0;
}
} // namespace bbl::pal

namespace bbl {
UiElementHandle ui_create_element(Engine& engine, std::string_view tag) {
    assert(&engine == &document);
    UiElementRecord record;
    record.tag = tag;
    const UiElementHandle handle{static_cast<std::uint32_t>(engine.ui_elements.size())};
    engine.ui_elements.push_back(std::move(record));
    return handle;
}
void ui_set_download_url(Engine& engine, UiElementHandle handle, ObjectUrlHandle url) {
    assert(&engine == &document);
    static_cast<void>(js::object_url_record(engine, url));
    handle_at(engine.ui_elements, handle).download_url = url;
}
void ui_set_download_name(Engine& engine, UiElementHandle handle, std::string name) {
    assert(&engine == &document);
    handle_at(engine.ui_elements, handle).download_name = std::move(name);
}
void ui_click(Engine& engine, UiElementHandle handle, bool) {
    assert(&engine == &document);
    js::click_download_anchor(engine, handle);
}
} // namespace bbl
