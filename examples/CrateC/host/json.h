/*
 * A small JSON reader for host tools. Never linked into a device build: a
 * device reads plan blobs, and the point of the blob is that nothing on the
 * target has to parse text.
 */
#ifndef CRATE_JSON_H
#define CRATE_JSON_H

#include <stddef.h>

typedef enum { JSON_NULL, JSON_BOOL, JSON_NUMBER, JSON_STRING, JSON_ARRAY, JSON_OBJECT } json_type;

typedef struct json_value {
    json_type type;
    double number;
    int boolean;
    char *string;
    /* Arrays and objects. `keys` is NULL for an array. Keys keep document
     * order. */
    struct json_value *items;
    char **keys;
    int count;
} json_value;

/* Parses `text`. Returns NULL and fills `error` on failure. */
json_value *json_parse(const char *text, size_t length, char *error, size_t error_size);
void json_free(json_value *value);

const json_value *json_get(const json_value *object, const char *key);
const char *json_string(const json_value *value, const char *fallback);
double json_number(const json_value *value, double fallback);
int json_is_number(const json_value *value);

/* Reads a whole file. The caller frees the result. */
char *json_read_file(const char *path, size_t *length);

#endif
