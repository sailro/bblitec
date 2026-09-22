/** Settled promises at the synchronous packaged-asset boundary retain values and rejections. */
export const gltfLoadPromise = `template<class T> class GltfLoadPromise {
    std::variant<std::monostate, T, std::exception_ptr> result_;
public:
    GltfLoadPromise() = default;
    explicit GltfLoadPromise(T value) : result_(std::in_place_index<1>, std::move(value)) {}
    explicit operator bool() const { return result_.index() != 0; }
    const T& get() const {
        if (result_.index() == 0) throw std::runtime_error("Cannot await an absent glTF promise.");
        if (const auto* error = std::get_if<2>(&result_)) std::rethrow_exception(*error);
        return std::get<1>(result_);
    }
    template<class Resolve> static GltfLoadPromise settle(Resolve resolve) {
        try { return GltfLoadPromise{resolve()}; }
        catch (...) {
            GltfLoadPromise promise;
            promise.result_.template emplace<2>(std::current_exception());
            return promise;
        }
    }
};`;
