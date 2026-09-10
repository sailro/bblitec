/** Native storage adapter for authored JSON matrices. */
export function gltfMatrixReaderCpp(): string {
    return `Matrix gltf_matrix_from_json(const ts::JsonValue* source) {
    if (!source || source->as_array().size() != 16) throw std::runtime_error("glTF node matrix must have 16 values.");
    Matrix result{};
    for (std::size_t index = 0; index < result.size(); ++index) result[index] = static_cast<float>(source->as_array()[index].as_number());
    return result;
}`;
}
