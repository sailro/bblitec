/** Settled promises at the synchronous packaged-asset boundary retain values and rejections. */
export const gltfLoadPromise = `template<class T> class GltfLoadPromise {
    using Result = std::variant<T, std::exception_ptr>;
    std::shared_ptr<const Result> result_;
public:
    GltfLoadPromise() = default;
    explicit GltfLoadPromise(T value) : result_(std::make_shared<Result>(std::in_place_index<0>, std::move(value))) {}
    explicit operator bool() const { return bool(result_); }
    const T& get() const {
        if (!result_) throw std::runtime_error("Cannot await an absent glTF promise.");
        if (const auto* error = std::get_if<std::exception_ptr>(result_.get())) std::rethrow_exception(*error);
        return std::get<T>(*result_);
    }
    template<class Resolve> static GltfLoadPromise settle(Resolve resolve) {
        try { return GltfLoadPromise{resolve()}; }
        catch (...) {
            GltfLoadPromise promise;
            promise.result_ = std::make_shared<Result>(std::in_place_index<1>, std::current_exception());
            return promise;
        }
    }
};`;
