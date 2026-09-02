vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO libsdl-org/SDL_image
    REF "release-${VERSION}"
    SHA512 a20269e064e68dd892084d8d6d6f3d5d44a6a75994808a1579ed7deeedc22c4230ec982d1166a0b85aca0b9a3625ac84e6fe9093dccebb78bf0b7cc01bc6c711
    HEAD_REF main
    PATCHES
        dependencies.diff
        pkgconfig-libname.diff
        # A palette-less greyscale PNG is expanded over a synthetic ramp
        # built as (i * 255) / ncolors (IMG_libpng.c), which tops out at
        # 254 and decodes every grey a level dark; the divisor has to be
        # the last index so the top entry lands on 255. For upstreaming;
        # drop this overlay once an SDL_image release builds the ramp
        # over the last index.
        png-grey-ramp-last-index.patch
)

vcpkg_check_features(
    OUT_FEATURE_OPTIONS FEATURE_OPTIONS
    FEATURES
        avif    SDLIMAGE_AVIF
        jpeg    SDLIMAGE_JPG
        jxl     SDLIMAGE_JXL
        png     SDLIMAGE_PNG
        tiff    SDLIMAGE_TIF
        webp    SDLIMAGE_WEBP
)

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        ${FEATURE_OPTIONS}
        # bblitec decodes PNG, JPEG and WebP -- the three image types
        # generation can name in BBLITE_IMAGE_CODECS (src/cli.ts,
        # `optionalImageCodecs`) -- and nothing else. The port builds every
        # dependency-free format in by default, and a static executable
        # keeps the SVG, XPM and BMP decoders it never calls (127 KiB of
        # SDL_image in a 2.3 MB scene 1 executable, 81 of them formats no
        # scene reaches). Everything but the feature-driven three is off.
        -DSDLIMAGE_ANI=OFF
        -DSDLIMAGE_BMP=OFF
        -DSDLIMAGE_GIF=OFF
        -DSDLIMAGE_LBM=OFF
        -DSDLIMAGE_PCX=OFF
        -DSDLIMAGE_PNM=OFF
        -DSDLIMAGE_QOI=OFF
        -DSDLIMAGE_SVG=OFF
        -DSDLIMAGE_TGA=OFF
        -DSDLIMAGE_XCF=OFF
        -DSDLIMAGE_XPM=OFF
        -DSDLIMAGE_XV=OFF
        -DCMAKE_FIND_PACKAGE_PREFER_CONFIG=OFF
        -DSDLIMAGE_BACKEND_IMAGEIO=OFF
        -DSDLIMAGE_BACKEND_STB=OFF
        -DSDLIMAGE_DEPS_SHARED=OFF
        -DSDLIMAGE_RELOCATABLE=ON
        -DSDLIMAGE_SAMPLES=OFF
        -DSDLIMAGE_STRICT=ON
        -DSDLIMAGE_VENDORED=OFF
)
vcpkg_cmake_install()
vcpkg_copy_pdbs()
vcpkg_fixup_pkgconfig()

if(EXISTS "${CURRENT_PACKAGES_DIR}/cmake")
    vcpkg_cmake_config_fixup(PACKAGE_NAME SDL3_image CONFIG_PATH cmake)
else()
    vcpkg_cmake_config_fixup(PACKAGE_NAME SDL3_image CONFIG_PATH lib/cmake/SDL3_image)
endif()

file(REMOVE_RECURSE
    "${CURRENT_PACKAGES_DIR}/debug/share"
    "${CURRENT_PACKAGES_DIR}/debug/include"
)

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE.txt")
