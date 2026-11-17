#pragma once

#include <bblite/js_error.hpp>
#include <bblite/js_file.hpp>
#include <bblite/js_promise.hpp>
#include <bblite/js_structured_clone.hpp>
#include <bblite/pal_canvas_pixels.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/pal_native_job.hpp>
#include <bblite/pal_offscreen.hpp>
#include <bblite/pal_host_services.hpp>

#include <thread>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace bbl::pal {

struct InvalidCanvasState : std::runtime_error {
    using std::runtime_error::runtime_error;
};
struct CanvasRangeError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

/** Native presentation resources only; sharing these never shares a JS realm. */
struct CanvasEndpoint {
    std::shared_ptr<OffscreenSurface> surface;
    std::shared_ptr<OffscreenDevice> device;
};

/** Optional graphics capability; a computation worker has no provider. */
struct CanvasProvider : HostServices {
    virtual std::shared_ptr<CanvasEndpoint> create_endpoint(std::uint64_t width,
                                                            std::uint64_t height) = 0;
};

struct TransferredCanvas final : TransferredResource {
    std::shared_ptr<CanvasEndpoint> endpoint;
    std::uint64_t width;
    std::uint64_t height;
    TransferredCanvas(std::shared_ptr<CanvasEndpoint> value, std::uint64_t w, std::uint64_t h)
        : endpoint(std::move(value)), width(w), height(h) {}
};

/** One realm's OffscreenCanvas wrapper, with exclusive context ownership. */
class OffscreenCanvas final : public Transferable {
public:
    OffscreenCanvas(std::uint64_t width, std::uint64_t height,
                    std::shared_ptr<CanvasEndpoint> endpoint = {})
        : width_(width), height_(height), endpoint_(std::move(endpoint)) {}
    std::uint64_t width() const {
        require_owner();
        return run_ ? run_->extent().width : width_;
    }
    std::uint64_t height() const {
        require_owner();
        return run_ ? run_->extent().height : height_;
    }
    bool detached() const {
        require_owner();
        return detached_;
    }
    /** A width or height as WebIDL [EnforceRange] unsigned long long converts it. */
    static std::uint64_t dimension(double value) {
        const auto integer = js::enforce_range<std::uint64_t>(value);
        if (!integer)
            throw CanvasRangeError("Canvas dimension is outside the unsigned long long range.");
        return *integer;
    }
    void set_width(double value) {
        const auto width = dimension(value);
        require_attached();
        resize_context(width, height());
        width_ = width;
    }
    void set_height(double value) {
        const auto height = dimension(value);
        require_attached();
        resize_context(width(), height);
        height_ = height;
    }

    /** A dimension native rendering and encoding admit: [1, 16384]. */
    static std::uint32_t rendering_dimension(std::uint64_t value) {
        if (value == 0 || value > maximum_native_extent)
            throw InvalidCanvasState("Native rendering requires canvas dimensions in [1, 16384].");
        return static_cast<std::uint32_t>(value);
    }

    std::shared_ptr<OffscreenRun> rendering_context() {
        require_attached();
        if (run_)
            return run_;
        if (context_2d_)
            throw InvalidCanvasState("An OffscreenCanvas with a 2d context has no WebGPU context.");
        if (!endpoint_ || !endpoint_->device || !endpoint_->surface) {
            throw InvalidCanvasState("Canvas has no native graphics provider.");
        }
        const auto width = rendering_dimension(width_);
        const auto height = rendering_dimension(height_);
        endpoint_->surface->resize(width, height);
        run_ = std::make_shared<OffscreenRun>(endpoint_->surface, endpoint_->device);
        return run_;
    }

    /**
     * `getContext("2d")`'s bitmap and drawing state: made at the canvas's size on the first
     * request, the same one after; null while a WebGPU context owns the canvas.
     */
    UiElementRecord::CanvasState* context_2d() {
        require_attached();
        if (run_)
            return nullptr;
        if (!context_2d_) {
            context_2d_.emplace();
            reset_canvas(*context_2d_, static_cast<double>(width_), static_cast<double>(height_));
        }
        return &*context_2d_;
    }
    /** The 2D context's state, when `getContext("2d")` made one. */
    [[nodiscard]] const UiElementRecord::CanvasState* bitmap_2d() const {
        require_owner();
        return context_2d_ ? &*context_2d_ : nullptr;
    }
    /** Whether a WebGPU context owns the canvas. */
    [[nodiscard]] bool has_rendering_context() const {
        require_owner();
        return static_cast<bool>(run_);
    }

    std::unique_ptr<TransferredResource> transfer() override {
        require_owner();
        if (detached_)
            throw DataCloneError("OffscreenCanvas is already detached.");
        if (run_ || context_2d_)
            throw InvalidCanvasState(
                "An OffscreenCanvas with a rendering context cannot be transferred.");
        // Allocate before mutating the sender. The payload contains only
        // native resources and dimensions, not this source wrapper or refs.
        auto payload = std::make_unique<TransferredCanvas>(endpoint_, width_, height_);
        endpoint_.reset();
        width_ = height_ = 0;
        detached_ = true;
        return payload;
    }
    static std::shared_ptr<OffscreenCanvas> receive(TransferredCanvas payload) {
        return js::make_gc_shared<OffscreenCanvas>(payload.width, payload.height,
                                                   std::move(payload.endpoint));
    }

private:
    void require_owner() const {
        if (owner_ != std::this_thread::get_id())
            throw std::logic_error("Canvas wrapper crossed realm ownership.");
    }
    void require_attached() const {
        require_owner();
        if (detached_)
            throw InvalidCanvasState("OffscreenCanvas is detached.");
    }
    void resize_context(std::uint64_t width, std::uint64_t height) {
        if (run_)
            endpoint_->surface->resize(rendering_dimension(width), rendering_dimension(height));
        // A 2D context resets to its default state over a cleared bitmap of the new size.
        if (context_2d_)
            reset_canvas(*context_2d_, static_cast<double>(width), static_cast<double>(height));
    }
    std::thread::id owner_ = std::this_thread::get_id();
    std::uint64_t width_;
    std::uint64_t height_;
    std::shared_ptr<CanvasEndpoint> endpoint_;
    std::shared_ptr<OffscreenRun> run_;
    std::optional<UiElementRecord::CanvasState> context_2d_;
    bool detached_ = false;
};

/**
 * `canvas.getContext("2d")`: the 2D context, held as its canvas (each canvas has at most one);
 * null while a WebGPU context owns the canvas. A detached canvas throws InvalidStateError.
 */
inline js::Nullable<std::shared_ptr<OffscreenCanvas>>
offscreen_canvas_context_2d(const std::shared_ptr<OffscreenCanvas>& canvas) {
    try {
        if (canvas->context_2d())
            return canvas;
        return std::nullopt;
    } catch (const InvalidCanvasState& error) {
        throw js::make_dom_exception(error.what(), "InvalidStateError");
    }
}

/**
 * `canvas.convertToBlob({ type, quality })`: a copy of the canvas's bitmap now (a 2D context's
 * pixels as `getImageData` composes them, else transparent black) encoded by `encode_image` on
 * the native workers, resolving to a Blob of the encoded type. A detached canvas rejects with
 * InvalidStateError, one without pixels with IndexSizeError, a failed encode with EncodingError;
 * a WebGPU context's pixels are not read back and reject with NotSupportedError.
 */
inline js::Promise<js::Blob>
offscreen_canvas_convert_to_blob(const std::shared_ptr<OffscreenCanvas>& canvas,
                                 std::optional<std::string> type, std::optional<double> quality) {
    try {
        if (canvas->detached())
            throw js::make_dom_exception("The OffscreenCanvas is detached.", "InvalidStateError");
        const auto width = canvas->width();
        const auto height = canvas->height();
        if (width == 0 || height == 0)
            throw js::make_dom_exception("The OffscreenCanvas has no pixels.", "IndexSizeError");
        if (canvas->has_rendering_context())
            throw js::make_dom_exception(
                "Encoding a WebGPU OffscreenCanvas is not represented natively.",
                "NotSupportedError");
        const auto columns = static_cast<int>(OffscreenCanvas::rendering_dimension(width));
        const auto rows = static_cast<int>(OffscreenCanvas::rendering_dimension(height));
        std::vector<std::uint8_t> pixels;
        if (const auto* bitmap = canvas->bitmap_2d()) {
            const auto composed =
                compose_canvas_image_data(*bitmap, no_canvas_source, 0.0, 0.0, columns, rows);
            pixels.assign(composed.data.data(), composed.data.data() + composed.data.size());
        } else {
            pixels.assign(static_cast<std::size_t>(columns) * rows * 4, 0);
        }
        return run_native_job<js::Blob>(
            [pixels = std::move(pixels), columns, rows, type = type.value_or("image/png"),
             quality]() -> std::optional<EncodedImage> {
                try {
                    return encode_image(pixels, columns, rows, type, quality);
                } catch (const std::exception&) {
                    return std::nullopt;
                }
            },
            [](std::optional<EncodedImage> encoded) {
                if (!encoded)
                    throw js::make_dom_exception("The canvas could not be encoded.",
                                                 "EncodingError");
                return js::Blob::from_bytes(std::move(encoded->bytes), std::move(encoded->type));
            });
    } catch (...) {
        js::Promise<js::Blob> rejected;
        rejected.reject(std::current_exception());
        return rejected;
    }
}

/** Main-realm canvas control: creating a placeholder is distinct from transfer. */
class CanvasElement {
public:
    CanvasElement(std::shared_ptr<CanvasEndpoint> endpoint, std::uint64_t width = 300,
                  std::uint64_t height = 150)
        : endpoint_(std::move(endpoint)), width_(width), height_(height) {}
    std::shared_ptr<OffscreenCanvas> transfer_control_to_offscreen() {
        require_owner();
        if (placeholder_ || context_)
            throw InvalidCanvasState(
                "Canvas control is already transferred or has a rendering context.");
        auto offscreen = js::make_gc_shared<OffscreenCanvas>(width_, height_, endpoint_);
        placeholder_ = true;
        return offscreen;
    }
    std::shared_ptr<OffscreenRun> rendering_context() {
        require_owner();
        if (placeholder_)
            throw InvalidCanvasState("A placeholder canvas cannot create a rendering context.");
        if (!context_)
            context_ = js::make_gc_shared<OffscreenCanvas>(width_, height_, endpoint_);
        return context_->rendering_context();
    }
    void resize_layout(std::uint32_t width, std::uint32_t height) {
        require_owner();
        if (placeholder_)
            return; // The source worker owns backing-store size.
        if (width == width_ && height == height_)
            return;
        width_ = width;
        height_ = height;
        if (context_) {
            context_->set_width(width);
            context_->set_height(height);
        }
    }
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(context_); }

private:
    void require_owner() const {
        if (owner_ != std::this_thread::get_id())
            throw std::logic_error("A DOM canvas crossed realm ownership.");
    }
    std::thread::id owner_ = std::this_thread::get_id();
    std::shared_ptr<CanvasEndpoint> endpoint_;
    std::shared_ptr<OffscreenCanvas> context_;
    std::uint64_t width_;
    std::uint64_t height_;
    bool placeholder_ = false;
};

inline std::shared_ptr<OffscreenCanvas>
create_offscreen_canvas(double width_value, double height_value,
                        const std::shared_ptr<HostServices>& services) {
    const auto width = OffscreenCanvas::dimension(width_value);
    const auto height = OffscreenCanvas::dimension(height_value);
    const auto provider = std::dynamic_pointer_cast<CanvasProvider>(services);
    return js::make_gc_shared<OffscreenCanvas>(
        width, height, provider ? provider->create_endpoint(width, height) : nullptr);
}

} // namespace bbl::pal

namespace bbl::js {
template <> struct CloneCodec<std::shared_ptr<pal::OffscreenCanvas>> {
    using Canvas = std::shared_ptr<pal::OffscreenCanvas>;
    static pal::CloneId write(pal::CloneWriter& writer, const Canvas& canvas) {
        if (!canvas)
            return writer.add(pal::CloneNull{});
        return writer.transferable(*canvas);
    }
    static Canvas read(pal::CloneReader& reader, pal::CloneId id) {
        if (std::holds_alternative<pal::CloneNull>(reader.node(id)))
            return {};
        if (const auto* canvas = reader.recalled<Canvas>(id))
            return *canvas;
        auto resource = reader.take_transfer(id);
        auto* payload = dynamic_cast<pal::TransferredCanvas*>(resource.get());
        if (!payload)
            throw pal::DataCloneError("Transferred resource is not an OffscreenCanvas.");
        auto canvas = pal::OffscreenCanvas::receive(std::move(*payload));
        reader.remember(id, canvas);
        return canvas;
    }
};
} // namespace bbl::js
