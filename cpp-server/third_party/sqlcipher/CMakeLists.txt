# Import prebuilt static SQLCipher library (built from source with OpenSSL crypto backend).
add_library(sqlcipher STATIC IMPORTED GLOBAL)
set_target_properties(sqlcipher PROPERTIES
    IMPORTED_LOCATION "${CMAKE_CURRENT_SOURCE_DIR}/libsqlcipher.a"
    INTERFACE_INCLUDE_DIRECTORIES "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
