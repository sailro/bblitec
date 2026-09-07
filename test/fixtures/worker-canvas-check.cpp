#include <bblite/pal_canvas.hpp>
#include <bblite/js_realm_state.hpp>

#include <iostream>
#include <limits>

namespace {
using namespace bbl;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
template <typename Error, typename Action> void rejects(Action action) {
    try { action(); } catch (const Error&) { return; }
    throw std::runtime_error("Operation did not throw the expected error");
}
std::shared_ptr<pal::CanvasEndpoint> endpoint() {
    return std::make_shared<pal::CanvasEndpoint>(
        std::make_shared<pal::OffscreenSurface>(40, 30), std::make_shared<pal::OffscreenDevice>());
}

void canvas_transfer() {
    const js::RealmScope realm;
    auto native = endpoint();
    pal::CanvasElement element(native, 40, 30);
    auto canvas = element.transfer_control_to_offscreen();
    require(!canvas->detached(), "Creating a placeholder detached its OffscreenCanvas");
    rejects<pal::InvalidCanvasState>([&] { element.transfer_control_to_offscreen(); });
    rejects<pal::InvalidCanvasState>([&] { element.rendering_context(); });
    rejects<pal::DataCloneError>([&] { js::serialize_message(canvas); });
    pal::Transferable* duplicate[]{canvas.get(), canvas.get()};
    rejects<pal::DataCloneError>([&] { js::serialize_message(canvas, duplicate); });
    pal::Transferable* transfer[]{canvas.get()};
    rejects<pal::DataCloneError>([&] { js::serialize_message([] {}, transfer); });
    require(!canvas->detached(), "Validation/serialization failure detached a canvas");
    js::Array<std::shared_ptr<pal::OffscreenCanvas>> aliases{canvas, canvas};
    auto message = js::serialize_message(aliases, transfer);
    require(canvas->detached() && !canvas->width() && !canvas->height(), "Transfer left a usable sender canvas");
    rejects<pal::InvalidCanvasState>([&] { canvas->set_width(20); });
    rejects<pal::InvalidCanvasState>([&] { canvas->rendering_context(); });
    rejects<pal::DataCloneError>([&] { js::serialize_message(canvas, transfer); });
    std::exception_ptr failure;
    std::jthread worker([message = std::move(message), &failure, native]() mutable {
        try {
            const js::RealmScope worker_realm;
            pal::CloneReader reader(std::move(message));
            const auto copies = js::clone_read<decltype(aliases)>(reader, reader.root());
            require(copies[0] == copies[1] && copies[0]->width() == 40, "Receiver lost canvas identity or dimensions");
            copies[0]->set_width(80.9);
            auto context = copies[0]->rendering_context();
            require(native->surface->extent().width == 80, "Receiver did not own the transferred surface");
            require(context == copies[1]->rendering_context(), "Canvas created two rendering contexts");
            pal::Transferable* owned[]{copies[0].get()};
            rejects<pal::InvalidCanvasState>([&] { js::serialize_message(copies[0], owned); });
            require(!copies[0]->detached(), "Context transfer failure detached the receiver");
            copies[0]->set_height(60);
            require(native->surface->extent().height == 60, "Context did not resize");
        } catch (...) { failure = std::current_exception(); }
    });
    worker.join();
    if (failure) std::rethrow_exception(failure);
}

void ordered_transfer_failure() {
    const js::RealmScope realm;
    auto first = js::make_gc_shared<pal::OffscreenCanvas>(1, 1);
    auto busy = js::make_gc_shared<pal::OffscreenCanvas>(40, 30, endpoint());
    busy->rendering_context();
    pal::Transferable* transfers[]{first.get(), busy.get()};
    rejects<pal::InvalidCanvasState>([&] { js::serialize_message(1.0, transfers); });
    require(first->detached() && !busy->detached(), "Later failure rolled back an earlier transfer");
}

void dimensions_and_native_lifetime() {
    const js::RealmScope realm;
    require(pal::OffscreenCanvas::dimension(-0.9) == 0, "EnforceRange checked before truncation");
    for (double value : {-1.0, 0x1p64, std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity()}) {
        rejects<pal::CanvasRangeError>([&] { pal::OffscreenCanvas::dimension(value); });
    }
    auto native = endpoint();
    const std::weak_ptr<pal::OffscreenDevice> device = native->device;
    auto canvas = js::make_gc_shared<pal::OffscreenCanvas>(40, 30, native);
    auto context = canvas->rendering_context();
    rejects<pal::CanvasRangeError>([&] { canvas->set_width(-1); });
    require(canvas->width() == 40 && native->surface->extent().width == 40, "Failed dimension conversion mutated the canvas");
    canvas.reset(); native.reset();
    require(!device.expired() && context->extent().width == 40, "Renderer lost its native resources with the source wrapper");
    context.reset();
    require(device.expired(), "Native canvas resources leaked after renderer retirement");
}
}

int main() {
    try { canvas_transfer(); ordered_transfer_failure(); dimensions_and_native_lifetime(); }
    catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
