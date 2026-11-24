/*
 * Graph document to plan blob. Host only.
 *
 * `buildPlan` in Plan.swift, emitting bytes instead of objects: one walk of
 * the document assigns every distinct node a slot, resolves modes, constants
 * and tables, and records the questions that decide how a block renders.
 * The document is the `ASLGraphDescriptor` JSON that `flattenPatch` and
 * `crate.plugin` files carry, format 1 or format 2 (`{ "ref": id }`).
 */
#ifndef CRATE_BUILD_H
#define CRATE_BUILD_H

#include <stddef.h>

#include "json.h"

#include <stdint.h>

/* Sample tables a graph refers to as `{ "ext": n }` instead of inline JSON
 * arrays. Valid for the builds that follow, until set again; the builder
 * copies what it uses. NULL clears them. */
typedef struct crate_build_table {
    const float *data;
    uint32_t len;
} crate_build_table;
void crate_build_set_external_tables(const crate_build_table *tables, int count);

/* Returns a malloc'd blob and its size, or NULL with `error` filled. */
void *crate_build_plan(const json_value *graph, size_t *size, char *error, size_t error_size);

#endif
