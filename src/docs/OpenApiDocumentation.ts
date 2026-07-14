// SPDX-License-Identifier: MPL-2.0
//
// Safe OpenAPI projection for annotation documentation. Routes are accepted
// only from explicit structured bindings; messages and tags are never parsed
// as HTTP metadata.

import type { DocAnnotation } from './AnnotationDocGenerator';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
    readonly [key: string]: JsonValue;
}

type MutableJsonObject = { [key: string]: JsonValue };

export type OpenApiVersion = '3.2.0' | '3.1.2';
export type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace' | 'query';
export type OpenApiParameterLocation = 'query' | 'querystring' | 'header' | 'path' | 'cookie';
export type OpenApiDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface OpenApiDiagnostic {
    severity: OpenApiDiagnosticSeverity;
    code: string;
    message: string;
    location?: string;
    annotationId?: string;
}

interface OpenApiInlineParameterBase {
    $ref?: never;
    name: string;
    in: OpenApiParameterLocation;
    description?: string;
    required?: boolean;
    deprecated?: boolean;
}

export interface OpenApiParameterReference {
    /** A local component reference, used instead of all inline fields. */
    $ref: string;
}

export interface OpenApiSchemaParameterMetadata extends OpenApiInlineParameterBase {
    /** OpenAPI 3.1 Schema Object (JSON Schema 2020-12), including boolean schemas. */
    schema: JsonObject | boolean;
    content?: never;
}

export interface OpenApiContentParameterMetadata extends OpenApiInlineParameterBase {
    schema?: never;
    /** Exactly one media type mapped to a Media Type Object or local Reference Object. */
    content: JsonObject;
}

/** Inline parameters use exactly one serialization strategy: `schema` or `content`. */
export type OpenApiParameterMetadata =
    | OpenApiParameterReference
    | OpenApiSchemaParameterMetadata
    | OpenApiContentParameterMetadata;

export interface OpenApiOperationMetadata {
    /** Existing annotation that owns and documents this operation. */
    annotationId: string;
    /** Explicit OpenAPI path template. Messages and tags are never inspected for one. */
    path: string;
    method: HttpMethod;
    operationId: string;
    summary?: string;
    description?: string;
    tags?: readonly string[];
    deprecated?: boolean;
    parameters?: readonly OpenApiParameterMetadata[];
    requestBody?: JsonObject;
    responses: Readonly<Record<string, JsonObject>>;
    security?: readonly JsonObject[];
    /** Only `x-...` keys are accepted. */
    extensions?: Readonly<Record<string, JsonValue>>;
}

export interface OpenApiGenerationProfile {
    /** Constrained serializer version. Defaults to 3.2.0; 3.1.2 disables 3.2-only fields. */
    openapiVersion?: OpenApiVersion;
    title?: string;
    version?: string;
    description?: string;
    /** The sole route source: explicit, structured bindings to annotation ids. */
    operations?: readonly OpenApiOperationMetadata[];
    /** Standard OpenAPI component maps and `x-...` extensions. */
    components?: JsonObject;
    /** Include the deterministic annotation vendor-extension catalogue. Default: true. */
    includeAnnotationCatalog?: boolean;
}

export interface OpenApiDocumentationResult {
    document: JsonObject;
    /** Canonical, two-space-indented JSON with recursively sorted object keys. */
    json: string;
    diagnostics: readonly OpenApiDiagnostic[];
}

export interface ParsedOpenApiGenerationProfile {
    /** Sanitized profile that is safe to pass to `generateOpenApiDocumentation`. */
    profile: OpenApiGenerationProfile;
    /** Structural/security diagnostics; invalid operations are omitted atomically. */
    diagnostics: readonly OpenApiDiagnostic[];
}

interface CloneResult {
    ok: boolean;
    value?: JsonValue;
}

const HTTP_METHODS: readonly HttpMethod[] = [
    'get',
    'put',
    'post',
    'delete',
    'options',
    'head',
    'patch',
    'trace',
    'query',
];
const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);
const PARAMETER_LOCATIONS: readonly OpenApiParameterLocation[] = ['query', 'querystring', 'header', 'path', 'cookie'];
const PARAMETER_LOCATION_SET = new Set<string>(PARAMETER_LOCATIONS);
const COMPONENT_KEYS = new Set([
    'schemas',
    'responses',
    'parameters',
    'examples',
    'requestBodies',
    'headers',
    'securitySchemes',
    'links',
    'callbacks',
    'pathItems',
    'mediaTypes',
]);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ANNOTATION_SCHEMA_NAME = 'OutOfCodeInsightsAnnotation';

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return isRecord(value);
}

function pushDiagnostic(
    diagnostics: OpenApiDiagnostic[],
    severity: OpenApiDiagnosticSeverity,
    code: string,
    message: string,
    location?: string,
    annotationId?: string
): void {
    diagnostics.push({ severity, code, message, location, annotationId });
}

function cloneJson(
    value: unknown,
    location: string,
    diagnostics: OpenApiDiagnostic[],
    stack = new WeakSet<object>(),
    depth = 0
): CloneResult {
    if (depth > 64) {
        pushDiagnostic(diagnostics, 'error', 'json-depth-limit', 'Structured metadata exceeds 64 levels.', location);
        return { ok: false };
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return { ok: true, value };
    }
    if (typeof value === 'number') {
        if (Number.isFinite(value)) {
            return { ok: true, value };
        }
        pushDiagnostic(
            diagnostics,
            'error',
            'non-json-number',
            'NaN and infinite values are not valid JSON.',
            location
        );
        return { ok: false };
    }
    if (typeof value !== 'object' || value === null) {
        pushDiagnostic(
            diagnostics,
            'error',
            'non-json-value',
            'Structured metadata must contain JSON values only.',
            location
        );
        return { ok: false };
    }
    if (stack.has(value)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'cyclic-json-value',
            'Structured metadata cannot contain cycles.',
            location
        );
        return { ok: false };
    }
    stack.add(value);
    if (Array.isArray(value)) {
        const result: JsonValue[] = [];
        for (let index = 0; index < value.length; index++) {
            const child = cloneJson(value[index], `${location}/${index}`, diagnostics, stack, depth + 1);
            if (!child.ok || child.value === undefined) {
                stack.delete(value);
                return { ok: false };
            }
            result.push(child.value);
        }
        stack.delete(value);
        return { ok: true, value: result };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        pushDiagnostic(
            diagnostics,
            'error',
            'non-plain-json-object',
            'Structured metadata objects must be plain.',
            location
        );
        stack.delete(value);
        return { ok: false };
    }
    const result: MutableJsonObject = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors).sort(compareText)) {
        if (UNSAFE_KEYS.has(key)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'unsafe-json-key',
                `Unsafe object key "${key}" was rejected.`,
                location
            );
            stack.delete(value);
            return { ok: false };
        }
        const descriptor = descriptors[key];
        if (!('value' in descriptor)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'json-accessor-rejected',
                'Getters and setters are not read.',
                `${location}/${key}`
            );
            stack.delete(value);
            return { ok: false };
        }
        const child = cloneJson(descriptor.value, `${location}/${key}`, diagnostics, stack, depth + 1);
        if (!child.ok || child.value === undefined) {
            stack.delete(value);
            return { ok: false };
        }
        result[key] = child.value;
    }
    stack.delete(value);
    return { ok: true, value: result };
}

const PROFILE_KEYS = new Set([
    '$schema',
    'openapiVersion',
    'title',
    'version',
    'description',
    'operations',
    'components',
    'includeAnnotationCatalog',
]);
const OPERATION_KEYS = new Set([
    'annotationId',
    'path',
    'method',
    'operationId',
    'summary',
    'description',
    'tags',
    'deprecated',
    'parameters',
    'requestBody',
    'responses',
    'security',
    'extensions',
]);
const PARAMETER_KEYS = new Set(['$ref', 'name', 'in', 'description', 'required', 'deprecated', 'schema', 'content']);

function reportUnknownKeys(
    value: Readonly<Record<string, unknown>>,
    allowed: ReadonlySet<string>,
    location: string,
    diagnostics: OpenApiDiagnostic[]
): void {
    for (const key of Object.keys(value).sort(compareText)) {
        if (!allowed.has(key)) {
            pushDiagnostic(
                diagnostics,
                'warning',
                'unknown-profile-field',
                `Unknown profile field "${key}" was ignored.`,
                `${location}/${key}`
            );
        }
    }
}

function requiredString(
    value: Readonly<Record<string, unknown>>,
    key: string,
    location: string,
    diagnostics: OpenApiDiagnostic[]
): string | null {
    const candidate = value[key];
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-profile-field',
            `Field "${key}" must be a non-empty string.`,
            `${location}/${key}`
        );
        return null;
    }
    return candidate.trim();
}

function optionalString(
    value: Readonly<Record<string, unknown>>,
    key: string,
    location: string,
    diagnostics: OpenApiDiagnostic[]
): string | undefined | null {
    const candidate = value[key];
    if (candidate === undefined) {
        return undefined;
    }
    if (typeof candidate !== 'string') {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-profile-field',
            `Field "${key}" must be a string when present.`,
            `${location}/${key}`
        );
        return null;
    }
    return candidate;
}

function optionalBoolean(
    value: Readonly<Record<string, unknown>>,
    key: string,
    location: string,
    diagnostics: OpenApiDiagnostic[]
): boolean | undefined | null {
    const candidate = value[key];
    if (candidate === undefined) {
        return undefined;
    }
    if (typeof candidate !== 'boolean') {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-profile-field',
            `Field "${key}" must be boolean when present.`,
            `${location}/${key}`
        );
        return null;
    }
    return candidate;
}

function parseParameterProfile(
    input: unknown,
    location: string,
    diagnostics: OpenApiDiagnostic[]
): OpenApiParameterMetadata | null {
    if (!isRecord(input)) {
        pushDiagnostic(diagnostics, 'error', 'invalid-parameter-profile', 'Parameter must be an object.', location);
        return null;
    }
    reportUnknownKeys(input, PARAMETER_KEYS, location, diagnostics);
    const reference = optionalString(input, '$ref', location, diagnostics);
    if (reference === null) {
        return null;
    }
    if (reference !== undefined) {
        const siblings = Object.keys(input).filter((key) => key !== '$ref');
        if (siblings.length > 0) {
            pushDiagnostic(
                diagnostics,
                'error',
                'parameter-reference-siblings',
                'A parameter $ref cannot be mixed with inline parameter fields.',
                location
            );
            return null;
        }
        if (!reference.startsWith('#/components/parameters/')) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-parameter-reference',
                'Parameter $ref must target #/components/parameters/.',
                `${location}/$ref`
            );
            return null;
        }
        return { $ref: reference };
    }
    const name = requiredString(input, 'name', location, diagnostics);
    const parameterIn = requiredString(input, 'in', location, diagnostics);
    if (!name || !parameterIn || !PARAMETER_LOCATION_SET.has(parameterIn)) {
        if (parameterIn && !PARAMETER_LOCATION_SET.has(parameterIn)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-parameter-location',
                `Unsupported parameter location "${parameterIn}".`,
                `${location}/in`
            );
        }
        return null;
    }
    const description = optionalString(input, 'description', location, diagnostics);
    const required = optionalBoolean(input, 'required', location, diagnostics);
    const deprecated = optionalBoolean(input, 'deprecated', location, diagnostics);
    if (description === null || required === null || deprecated === null) {
        return null;
    }
    const schema = input.schema;
    if (schema !== undefined && typeof schema !== 'boolean' && !isJsonObject(schema as JsonValue)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-parameter-schema',
            'Parameter schema must be an object or boolean.',
            `${location}/schema`
        );
        return null;
    }
    const content = input.content;
    if (content !== undefined) {
        if (!isJsonObject(content as JsonValue)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-parameter-content',
                'Parameter content must be an object map.',
                `${location}/content`
            );
            return null;
        }
        const contentObject = content as JsonObject;
        const mediaTypes = Object.keys(contentObject);
        if (mediaTypes.length !== 1 || !isJsonObject(contentObject[mediaTypes[0]])) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-parameter-content',
                'Parameter content must contain exactly one media type mapped to an object.',
                `${location}/content`
            );
            return null;
        }
    }
    if ((schema === undefined) === (content === undefined)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'parameter-serialization-required',
            'An inline parameter must contain exactly one of `schema` or `content`.',
            location
        );
        return null;
    }
    if (parameterIn === 'querystring' && content === undefined) {
        pushDiagnostic(
            diagnostics,
            'error',
            'querystring-content-required',
            'A querystring parameter must use `content`.',
            location
        );
        return null;
    }
    const common = {
        name,
        in: parameterIn as OpenApiParameterLocation,
        ...(description !== undefined ? { description } : {}),
        ...(required !== undefined ? { required } : {}),
        ...(deprecated !== undefined ? { deprecated } : {}),
    };
    return schema !== undefined
        ? { ...common, schema: schema as JsonObject | boolean }
        : { ...common, content: content as JsonObject };
}

function parseOperationProfile(
    input: unknown,
    index: number,
    diagnostics: OpenApiDiagnostic[]
): OpenApiOperationMetadata | null {
    const location = `#/operations/${index}`;
    if (!isRecord(input)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-operation-profile',
            'Operation binding must be an object.',
            location
        );
        return null;
    }
    reportUnknownKeys(input, OPERATION_KEYS, location, diagnostics);
    const annotationId = requiredString(input, 'annotationId', location, diagnostics);
    const path = requiredString(input, 'path', location, diagnostics);
    const methodInput = requiredString(input, 'method', location, diagnostics);
    const operationId = requiredString(input, 'operationId', location, diagnostics);
    const method = methodInput?.toLowerCase();
    if (!annotationId || !path || !method || !operationId || !HTTP_METHOD_SET.has(method)) {
        if (method && !HTTP_METHOD_SET.has(method)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-http-method',
                `Unsupported HTTP method "${methodInput}".`,
                `${location}/method`,
                annotationId ?? undefined
            );
        }
        return null;
    }
    const responsesInput = input.responses;
    if (!isRecord(responsesInput)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-responses-profile',
            'Operation responses must be an object map.',
            `${location}/responses`,
            annotationId
        );
        return null;
    }
    if (!validateResponsesObject(responsesInput, diagnostics, `${location}/responses`, annotationId)) {
        return null;
    }
    const responses: Record<string, JsonObject> = {};
    for (const [code, response] of Object.entries(responsesInput).sort(([left], [right]) => compareText(left, right))) {
        if (!isJsonObject(response as JsonValue)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-response-profile',
                `Response "${code}" must be an object.`,
                `${location}/responses/${code}`,
                annotationId
            );
            return null;
        }
        responses[code] = response as JsonObject;
    }
    const summary = optionalString(input, 'summary', location, diagnostics);
    const description = optionalString(input, 'description', location, diagnostics);
    const deprecated = optionalBoolean(input, 'deprecated', location, diagnostics);
    if (summary === null || description === null || deprecated === null) {
        return null;
    }
    let tags: string[] | undefined;
    if (input.tags !== undefined) {
        if (!Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === 'string')) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-operation-tags',
                'Operation tags must be an array of strings.',
                `${location}/tags`,
                annotationId
            );
            return null;
        }
        tags = input.tags;
    }
    let parameters: OpenApiParameterMetadata[] | undefined;
    if (input.parameters !== undefined) {
        if (!Array.isArray(input.parameters)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-parameters-profile',
                'Operation parameters must be an array.',
                `${location}/parameters`,
                annotationId
            );
            return null;
        }
        parameters = [];
        for (let parameterIndex = 0; parameterIndex < input.parameters.length; parameterIndex++) {
            const parameter = parseParameterProfile(
                input.parameters[parameterIndex],
                `${location}/parameters/${parameterIndex}`,
                diagnostics
            );
            if (!parameter) {
                return null;
            }
            parameters.push(parameter);
        }
    }
    const requestBody = input.requestBody;
    if (requestBody !== undefined && !isJsonObject(requestBody as JsonValue)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-request-body-profile',
            'requestBody must be an object.',
            `${location}/requestBody`,
            annotationId
        );
        return null;
    }
    let security: JsonObject[] | undefined;
    if (input.security !== undefined) {
        if (
            !Array.isArray(input.security) ||
            !input.security.every((requirement) => isJsonObject(requirement as JsonValue))
        ) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-security-profile',
                'security must be an array of objects.',
                `${location}/security`,
                annotationId
            );
            return null;
        }
        security = input.security as JsonObject[];
    }
    const extensions = input.extensions;
    if (extensions !== undefined && !isJsonObject(extensions as JsonValue)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-extensions-profile',
            'extensions must be an object.',
            `${location}/extensions`,
            annotationId
        );
        return null;
    }
    return {
        annotationId,
        path,
        method: method as HttpMethod,
        operationId,
        responses,
        ...(summary !== undefined ? { summary } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(deprecated !== undefined ? { deprecated } : {}),
        ...(parameters !== undefined ? { parameters } : {}),
        ...(requestBody !== undefined ? { requestBody: requestBody as JsonObject } : {}),
        ...(security !== undefined ? { security } : {}),
        ...(extensions !== undefined ? { extensions: extensions as Record<string, JsonValue> } : {}),
    };
}

/**
 * Parse an untrusted workspace JSON value without invoking accessors or using
 * unchecked property methods. Invalid operation records are omitted in full.
 */
export function parseOpenApiGenerationProfile(input: unknown): ParsedOpenApiGenerationProfile {
    const diagnostics: OpenApiDiagnostic[] = [];
    const cloned = cloneJson(input, '#', diagnostics);
    if (!cloned.ok || !isJsonObject(cloned.value)) {
        if (cloned.ok) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-profile',
                'OpenAPI generation profile must be an object.',
                '#'
            );
        }
        return { profile: {}, diagnostics: sortAndDedupeDiagnostics(diagnostics) };
    }
    const root = cloned.value;
    reportUnknownKeys(root, PROFILE_KEYS, '#', diagnostics);
    const openapiVersion = optionalString(root, 'openapiVersion', '#', diagnostics);
    const title = optionalString(root, 'title', '#', diagnostics);
    const version = optionalString(root, 'version', '#', diagnostics);
    const description = optionalString(root, 'description', '#', diagnostics);
    const includeAnnotationCatalog = optionalBoolean(root, 'includeAnnotationCatalog', '#', diagnostics);
    const profile: OpenApiGenerationProfile = {};
    if (openapiVersion !== null && openapiVersion !== undefined) {
        if (openapiVersion === '3.2.0' || openapiVersion === '3.1.2') {
            profile.openapiVersion = openapiVersion;
        } else {
            pushDiagnostic(
                diagnostics,
                'error',
                'unsupported-openapi-version-profile',
                'openapiVersion must be "3.2.0" or the compatibility value "3.1.2".',
                '#/openapiVersion'
            );
        }
    }
    if (title !== null && title !== undefined) {
        profile.title = title;
    }
    if (version !== null && version !== undefined) {
        profile.version = version;
    }
    if (description !== null && description !== undefined) {
        profile.description = description;
    }
    if (includeAnnotationCatalog !== null && includeAnnotationCatalog !== undefined) {
        profile.includeAnnotationCatalog = includeAnnotationCatalog;
    }
    if (root.components !== undefined) {
        if (isJsonObject(root.components)) {
            profile.components = root.components;
        } else {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-components-profile',
                'components must be an object.',
                '#/components'
            );
        }
    }
    if (root.operations !== undefined) {
        if (!Array.isArray(root.operations)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-operations-profile',
                'operations must be an array.',
                '#/operations'
            );
        } else {
            const operations: OpenApiOperationMetadata[] = [];
            for (let index = 0; index < root.operations.length; index++) {
                const operation = parseOperationProfile(root.operations[index], index, diagnostics);
                if (operation) {
                    operations.push(operation);
                }
            }
            profile.operations = operations;
        }
    }
    return { profile, diagnostics: sortAndDedupeDiagnostics(diagnostics) };
}

function annotationSchema(): JsonObject {
    return {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'file', 'line', 'message', 'state', 'timestamp'],
        properties: {
            id: { type: 'string' },
            file: { type: 'string' },
            line: { type: 'integer', minimum: -1 },
            message: { type: 'string' },
            state: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' },
            author: { type: 'string' },
            severity: { type: 'string' },
            resolved: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
    };
}

function componentMapIsStructurallyValid(
    section: string,
    value: JsonObject,
    diagnostics: OpenApiDiagnostic[]
): boolean {
    let valid = true;
    for (const [name, entry] of Object.entries(value).sort(([left], [right]) => compareText(left, right))) {
        const location = `#/components/${section}/${name}`;
        if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-component-name',
                `Component name "${name}" contains unsupported characters.`,
                location
            );
            valid = false;
        }
        if (section === 'schemas') {
            if (typeof entry !== 'boolean' && !isJsonObject(entry)) {
                pushDiagnostic(
                    diagnostics,
                    'error',
                    'invalid-component-entry',
                    `Schema component "${name}" must be an object or boolean schema.`,
                    location
                );
                valid = false;
            }
        } else if (!isJsonObject(entry)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-component-entry',
                `Component "${name}" in section "${section}" must be an object.`,
                location
            );
            valid = false;
        }
    }
    return valid;
}

function buildComponents(
    profile: OpenApiGenerationProfile,
    diagnostics: OpenApiDiagnostic[],
    openapiVersion: OpenApiVersion
): MutableJsonObject {
    const components: MutableJsonObject = {};
    if (profile.components !== undefined) {
        const cloned = cloneJson(profile.components, '#/components', diagnostics);
        if (cloned.ok && isJsonObject(cloned.value)) {
            for (const [key, value] of Object.entries(cloned.value).sort(([left], [right]) =>
                compareText(left, right)
            )) {
                if (!COMPONENT_KEYS.has(key) && !key.startsWith('x-')) {
                    pushDiagnostic(
                        diagnostics,
                        'warning',
                        'unsupported-component-section',
                        `Component section "${key}" is outside the supported OpenAPI projection and was omitted.`,
                        `#/components/${key}`
                    );
                    continue;
                }
                if (key === 'mediaTypes' && openapiVersion !== '3.2.0') {
                    pushDiagnostic(
                        diagnostics,
                        'error',
                        'unsupported-version-feature',
                        'components.mediaTypes requires OpenAPI 3.2.0 and was omitted.',
                        '#/components/mediaTypes'
                    );
                    continue;
                }
                if (COMPONENT_KEYS.has(key) && !isJsonObject(value)) {
                    pushDiagnostic(
                        diagnostics,
                        'error',
                        'invalid-component-map',
                        `Component section "${key}" must be an object map and was omitted.`,
                        `#/components/${key}`
                    );
                    continue;
                }
                if (
                    COMPONENT_KEYS.has(key) &&
                    !componentMapIsStructurallyValid(key, value as JsonObject, diagnostics)
                ) {
                    pushDiagnostic(
                        diagnostics,
                        'error',
                        'component-section-rejected',
                        `Component section "${key}" contains invalid entries and was omitted atomically.`,
                        `#/components/${key}`
                    );
                    continue;
                }
                components[key] = value;
            }
        }
    }
    const existingSchemas = components.schemas;
    const schemas: MutableJsonObject = isJsonObject(existingSchemas) ? { ...existingSchemas } : {};
    if (Object.prototype.hasOwnProperty.call(schemas, ANNOTATION_SCHEMA_NAME)) {
        pushDiagnostic(
            diagnostics,
            'warning',
            'reserved-schema-replaced',
            `Profile schema "${ANNOTATION_SCHEMA_NAME}" is reserved and was replaced by the catalogue schema.`,
            `#/components/schemas/${ANNOTATION_SCHEMA_NAME}`
        );
    }
    schemas[ANNOTATION_SCHEMA_NAME] = annotationSchema();
    components.schemas = schemas;
    return components;
}

function sortedAnnotations(annotations: readonly DocAnnotation[]): DocAnnotation[] {
    return [...annotations].sort(
        (left, right) =>
            compareText(left.id, right.id) ||
            compareText(left.file, right.file) ||
            left.line - right.line ||
            compareText(left.timestamp, right.timestamp) ||
            compareText(left.message, right.message)
    );
}

function annotationCatalogue(annotations: readonly DocAnnotation[]): JsonValue[] {
    return sortedAnnotations(annotations).map((annotation) => {
        const item: MutableJsonObject = {
            id: annotation.id,
            file: annotation.file,
            line: annotation.line,
            message: annotation.message,
            state: annotation.state,
            timestamp: annotation.timestamp,
        };
        if (annotation.author) {
            item.author = annotation.author;
        }
        if (annotation.severity) {
            item.severity = annotation.severity;
        }
        if (annotation.resolved !== undefined) {
            item.resolved = annotation.resolved;
        }
        if (annotation.tags?.length) {
            item.tags = [...new Set(annotation.tags.map((tag) => tag.trim()).filter(Boolean))].sort(compareText);
        }
        return item;
    });
}

function decodePointerSegment(segment: string): string | null {
    try {
        return decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
        return null;
    }
}

function resolveLocalReference(root: unknown, reference: string): unknown {
    if (!reference.startsWith('#/')) {
        return undefined;
    }
    let current: unknown = root;
    for (const rawSegment of reference.slice(2).split('/')) {
        const segment = decodePointerSegment(rawSegment);
        if (segment === null || !isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
            return undefined;
        }
        current = current[segment];
    }
    return current;
}

interface LocatedReference {
    ref: string;
    location: string;
}

function collectReferences(value: unknown, location: string, seen = new WeakSet<object>()): LocatedReference[] {
    if (typeof value !== 'object' || value === null || seen.has(value)) {
        return [];
    }
    seen.add(value);
    const references: LocatedReference[] = [];
    if (Array.isArray(value)) {
        value.forEach((entry, index) => references.push(...collectReferences(entry, `${location}/${index}`, seen)));
        return references;
    }
    for (const [key, entry] of Object.entries(value)) {
        const childLocation = `${location}/${key}`;
        if (key === '$ref' && typeof entry === 'string') {
            references.push({ ref: entry, location: childLocation });
        } else {
            references.push(...collectReferences(entry, childLocation, seen));
        }
    }
    return references;
}

function validateReferences(
    value: unknown,
    root: unknown,
    diagnostics: OpenApiDiagnostic[],
    annotationId?: string,
    requireComponents = false
): boolean {
    let valid = true;
    for (const reference of collectReferences(value, '#')) {
        if (!reference.ref.startsWith('#/')) {
            pushDiagnostic(
                diagnostics,
                'error',
                'external-reference-rejected',
                `Only local JSON Pointer references are allowed; rejected "${reference.ref}".`,
                reference.location,
                annotationId
            );
            valid = false;
            continue;
        }
        if (requireComponents && !reference.ref.startsWith('#/components/')) {
            pushDiagnostic(
                diagnostics,
                'error',
                'operation-reference-outside-components',
                `Operation references must target #/components; rejected "${reference.ref}".`,
                reference.location,
                annotationId
            );
            valid = false;
            continue;
        }
        if (resolveLocalReference(root, reference.ref) === undefined) {
            pushDiagnostic(
                diagnostics,
                'error',
                'unresolved-local-reference',
                `Local reference "${reference.ref}" does not resolve.`,
                reference.location,
                annotationId
            );
            valid = false;
        }
    }
    return valid;
}

function templateParameters(path: string): string[] | null {
    const names: string[] = [];
    const stripped = path.replace(/\{([^{}/]+)\}/g, (_whole, name: string) => {
        names.push(name);
        return '';
    });
    if (/[{}]/.test(stripped)) {
        return null;
    }
    return [...new Set(names)].sort(compareText);
}

function responseCodeIsValid(code: string): boolean {
    return code === 'default' || /^[1-5](?:\d{2}|XX)$/.test(code);
}

function validateResponseDefinition(
    response: unknown,
    diagnostics: OpenApiDiagnostic[],
    location: string,
    label: string,
    annotationId?: string
): boolean {
    if (!isRecord(response)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-response-profile',
            `Response "${label}" must be an object.`,
            location,
            annotationId
        );
        return false;
    }
    let valid = true;
    if (response.$ref !== undefined && (typeof response.$ref !== 'string' || response.$ref.length === 0)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-response-reference',
            `Response "${label}" has an invalid $ref.`,
            `${location}/$ref`,
            annotationId
        );
        valid = false;
    }
    if (typeof response.description !== 'string' && typeof response.$ref !== 'string') {
        pushDiagnostic(
            diagnostics,
            'error',
            'response-description-required',
            `Response "${label}" requires a description or $ref.`,
            location,
            annotationId
        );
        valid = false;
    }
    return valid;
}

function validateResponsesObject(
    responsesValue: unknown,
    diagnostics: OpenApiDiagnostic[],
    location: string,
    annotationId?: string
): boolean {
    if (!isRecord(responsesValue) || Object.keys(responsesValue).length === 0) {
        pushDiagnostic(
            diagnostics,
            'error',
            'missing-responses',
            'Every operation requires at least one response.',
            location,
            annotationId
        );
        return false;
    }
    let valid = true;
    for (const code of Object.keys(responsesValue).sort(compareText)) {
        const responseLocation = `${location}/${code}`;
        if (!responseCodeIsValid(code)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-response-code',
                `Response key "${code}" is not an HTTP status code, range, or default.`,
                responseLocation,
                annotationId
            );
            valid = false;
        }
        if (!validateResponseDefinition(responsesValue[code], diagnostics, responseLocation, code, annotationId)) {
            valid = false;
        }
    }
    return valid;
}

function buildParameter(
    input: OpenApiParameterMetadata,
    location: string,
    diagnostics: OpenApiDiagnostic[],
    annotationId: string,
    openapiVersion: OpenApiVersion
): MutableJsonObject | null {
    if (input.$ref !== undefined) {
        if (
            typeof input.$ref !== 'string' ||
            input.$ref.trim().length === 0 ||
            !input.$ref.startsWith('#/components/parameters/')
        ) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-parameter-reference',
                'Parameter $ref must target #/components/parameters/.',
                location,
                annotationId
            );
            return null;
        }
        return { $ref: input.$ref };
    }
    if (!input.name?.trim() || !input.in || !PARAMETER_LOCATION_SET.has(input.in)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-parameter',
            'Inline parameters require a non-empty name and a supported `in` value.',
            location,
            annotationId
        );
        return null;
    }
    if (input.in === 'querystring' && openapiVersion !== '3.2.0') {
        pushDiagnostic(
            diagnostics,
            'error',
            'unsupported-version-feature',
            'The querystring parameter location requires OpenAPI 3.2.0.',
            location,
            annotationId
        );
        return null;
    }
    const hasSchema = input.schema !== undefined;
    const hasContent = input.content !== undefined;
    if (hasSchema === hasContent) {
        pushDiagnostic(
            diagnostics,
            'error',
            'parameter-serialization-required',
            'An inline parameter must contain exactly one of `schema` or `content`.',
            location,
            annotationId
        );
        return null;
    }
    if (input.in === 'querystring' && !hasContent) {
        pushDiagnostic(
            diagnostics,
            'error',
            'querystring-content-required',
            'A querystring parameter must use `content`.',
            location,
            annotationId
        );
        return null;
    }
    const parameter: MutableJsonObject = { name: input.name.trim(), in: input.in };
    if (input.description !== undefined) {
        parameter.description = input.description;
    }
    if (input.required !== undefined) {
        parameter.required = input.required;
    }
    if (input.deprecated !== undefined) {
        parameter.deprecated = input.deprecated;
    }
    if (input.schema !== undefined) {
        const schema = cloneJson(input.schema, `${location}/schema`, diagnostics);
        if (!schema.ok || (typeof schema.value !== 'boolean' && !isJsonObject(schema.value))) {
            return null;
        }
        parameter.schema = schema.value;
    }
    if (input.content !== undefined) {
        const content = cloneJson(input.content, `${location}/content`, diagnostics);
        if (!content.ok || !isJsonObject(content.value)) {
            return null;
        }
        const mediaTypes = Object.keys(content.value);
        if (mediaTypes.length !== 1 || !isJsonObject(content.value[mediaTypes[0]])) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-parameter-content',
                'Parameter content must contain exactly one media type mapped to an object.',
                `${location}/content`,
                annotationId
            );
            return null;
        }
        parameter.content = content.value;
    }
    return parameter;
}

function referencedParameter(
    parameter: JsonValue,
    root: unknown,
    seenReferences = new Set<string>()
): Record<string, unknown> | null {
    if (!isRecord(parameter)) {
        return null;
    }
    if (typeof parameter.$ref === 'string') {
        if (seenReferences.has(parameter.$ref)) {
            return null;
        }
        seenReferences.add(parameter.$ref);
        const target = resolveLocalReference(root, parameter.$ref);
        return isRecord(target) ? referencedParameter(target as unknown as JsonValue, root, seenReferences) : null;
    }
    return parameter;
}

function validateParameterObject(
    parameterValue: unknown,
    root: unknown,
    openapiVersion: OpenApiVersion,
    diagnostics: OpenApiDiagnostic[],
    location: string,
    annotationId?: string
): boolean {
    if (!isRecord(parameterValue)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-parameter',
            'Parameter must be an object.',
            location,
            annotationId
        );
        return false;
    }
    if (parameterValue.$ref !== undefined) {
        if (typeof parameterValue.$ref !== 'string' || !parameterValue.$ref.startsWith('#/components/parameters/')) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-parameter-reference',
                'Parameter $ref must target #/components/parameters/.',
                location,
                annotationId
            );
            return false;
        }
        return true;
    }
    if (
        typeof parameterValue.name !== 'string' ||
        parameterValue.name.trim().length === 0 ||
        typeof parameterValue.in !== 'string' ||
        !PARAMETER_LOCATION_SET.has(parameterValue.in)
    ) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-parameter',
            'Inline parameters require a non-empty name and a supported `in` value.',
            location,
            annotationId
        );
        return false;
    }
    if (parameterValue.in === 'querystring' && openapiVersion !== '3.2.0') {
        pushDiagnostic(
            diagnostics,
            'error',
            'unsupported-version-feature',
            'The querystring parameter location requires OpenAPI 3.2.0.',
            location,
            annotationId
        );
        return false;
    }
    const hasSchema = Object.prototype.hasOwnProperty.call(parameterValue, 'schema');
    const hasContent = Object.prototype.hasOwnProperty.call(parameterValue, 'content');
    if (hasSchema === hasContent) {
        pushDiagnostic(
            diagnostics,
            'error',
            'parameter-serialization-required',
            'An inline parameter must contain exactly one of `schema` or `content`.',
            location,
            annotationId
        );
        return false;
    }
    if (hasSchema && typeof parameterValue.schema !== 'boolean' && !isRecord(parameterValue.schema)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-parameter-schema',
            'Parameter schema must be an object or boolean.',
            `${location}/schema`,
            annotationId
        );
        return false;
    }
    if (hasContent) {
        if (!isRecord(parameterValue.content)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-parameter-content',
                'Parameter content must be an object map.',
                `${location}/content`,
                annotationId
            );
            return false;
        }
        const mediaTypes = Object.keys(parameterValue.content);
        if (mediaTypes.length !== 1 || !isRecord(parameterValue.content[mediaTypes[0]])) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-parameter-content',
                'Parameter content must contain exactly one media type mapped to an object.',
                `${location}/content`,
                annotationId
            );
            return false;
        }
    }
    if (parameterValue.in === 'querystring' && !hasContent) {
        pushDiagnostic(
            diagnostics,
            'error',
            'querystring-content-required',
            'A querystring parameter must use `content`.',
            location,
            annotationId
        );
        return false;
    }
    return true;
}

function validateParameterCollection(
    parameters: readonly unknown[],
    root: unknown,
    openapiVersion: OpenApiVersion,
    diagnostics: OpenApiDiagnostic[],
    location: string,
    annotationId?: string
): boolean {
    let valid = true;
    let querystringCount = 0;
    let queryCount = 0;
    const identities = new Set<string>();
    for (let index = 0; index < parameters.length; index++) {
        const parameterLocation = `${location}/parameters/${index}`;
        if (
            !validateParameterObject(
                parameters[index],
                root,
                openapiVersion,
                diagnostics,
                parameterLocation,
                annotationId
            )
        ) {
            valid = false;
            continue;
        }
        const parameter = referencedParameter(parameters[index] as JsonValue, root);
        if (!parameter || typeof parameter.name !== 'string' || typeof parameter.in !== 'string') {
            continue;
        }
        const identity = `${parameter.in}\u0000${parameter.name}`;
        if (identities.has(identity)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'duplicate-parameter',
                `Parameter "${parameter.name}" in "${parameter.in}" is declared more than once.`,
                parameterLocation,
                annotationId
            );
            valid = false;
        }
        identities.add(identity);
        if (parameter.in === 'query') {
            queryCount++;
        } else if (parameter.in === 'querystring') {
            querystringCount++;
        }
    }
    if (querystringCount > 1) {
        pushDiagnostic(
            diagnostics,
            'error',
            'multiple-querystring-parameters',
            'An operation can contain at most one querystring parameter.',
            `${location}/parameters`,
            annotationId
        );
        valid = false;
    }
    if (querystringCount > 0 && queryCount > 0) {
        pushDiagnostic(
            diagnostics,
            'error',
            'query-parameter-conflict',
            'query and querystring parameters cannot be used by the same operation.',
            `${location}/parameters`,
            annotationId
        );
        valid = false;
    }
    return valid;
}

function validateOperationParameterProjection(
    operation: unknown,
    root: unknown,
    openapiVersion: OpenApiVersion,
    diagnostics: OpenApiDiagnostic[],
    location: string,
    depth: number
): boolean {
    if (!isRecord(operation)) {
        return true;
    }
    let valid = true;
    if (operation.parameters !== undefined) {
        if (!Array.isArray(operation.parameters)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-parameters-profile',
                'Operation parameters must be an array.',
                `${location}/parameters`
            );
            valid = false;
        } else if (!validateParameterCollection(operation.parameters, root, openapiVersion, diagnostics, location)) {
            valid = false;
        }
    }
    if (operation.callbacks !== undefined) {
        if (!isRecord(operation.callbacks)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-callbacks',
                'Operation callbacks must be an object map.',
                `${location}/callbacks`
            );
            valid = false;
        } else {
            for (const [callbackName, callback] of Object.entries(operation.callbacks)) {
                if (
                    !validateCallbackParameterProjection(
                        callback,
                        root,
                        openapiVersion,
                        diagnostics,
                        `${location}/callbacks/${callbackName}`,
                        depth + 1
                    )
                ) {
                    valid = false;
                }
            }
        }
    }
    return valid;
}

function validateCallbackParameterProjection(
    callback: unknown,
    root: unknown,
    openapiVersion: OpenApiVersion,
    diagnostics: OpenApiDiagnostic[],
    location: string,
    depth: number
): boolean {
    if (!isRecord(callback) || typeof callback.$ref === 'string') {
        return true;
    }
    if (depth > 32) {
        pushDiagnostic(
            diagnostics,
            'error',
            'component-depth-limit',
            'Nested callback/path-item components exceed 32 levels.',
            location
        );
        return false;
    }
    let valid = true;
    for (const [expression, pathItem] of Object.entries(callback)) {
        if (
            !validatePathItemParameterProjection(
                pathItem,
                root,
                openapiVersion,
                diagnostics,
                `${location}/${expression}`,
                depth + 1
            )
        ) {
            valid = false;
        }
    }
    return valid;
}

function validatePathItemParameterProjection(
    pathItem: unknown,
    root: unknown,
    openapiVersion: OpenApiVersion,
    diagnostics: OpenApiDiagnostic[],
    location: string,
    depth = 0
): boolean {
    if (!isRecord(pathItem) || typeof pathItem.$ref === 'string') {
        return true;
    }
    if (depth > 32) {
        pushDiagnostic(
            diagnostics,
            'error',
            'component-depth-limit',
            'Nested callback/path-item components exceed 32 levels.',
            location
        );
        return false;
    }
    let valid = true;
    if (pathItem.parameters !== undefined) {
        if (!Array.isArray(pathItem.parameters)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-parameters-profile',
                'Path-item parameters must be an array.',
                `${location}/parameters`
            );
            valid = false;
        } else if (!validateParameterCollection(pathItem.parameters, root, openapiVersion, diagnostics, location)) {
            valid = false;
        }
    }
    for (const method of HTTP_METHODS) {
        if (pathItem[method] === undefined) {
            continue;
        }
        if (method === 'query' && openapiVersion !== '3.2.0') {
            pushDiagnostic(
                diagnostics,
                'error',
                'unsupported-version-feature',
                'The QUERY operation requires OpenAPI 3.2.0.',
                `${location}/query`
            );
            valid = false;
            continue;
        }
        if (
            !validateOperationParameterProjection(
                pathItem[method],
                root,
                openapiVersion,
                diagnostics,
                `${location}/${method}`,
                depth
            )
        ) {
            valid = false;
        }
    }
    if (pathItem.additionalOperations !== undefined) {
        pushDiagnostic(
            diagnostics,
            'error',
            'unsupported-projection-feature',
            'Path Item additionalOperations is outside this constrained projection.',
            `${location}/additionalOperations`
        );
        valid = false;
    }
    return valid;
}

function validateComponentProjection(
    components: JsonObject,
    root: unknown,
    openapiVersion: OpenApiVersion,
    diagnostics: OpenApiDiagnostic[]
): boolean {
    let valid = true;
    if (openapiVersion !== '3.2.0' && components.mediaTypes !== undefined) {
        pushDiagnostic(
            diagnostics,
            'error',
            'unsupported-version-feature',
            'components.mediaTypes requires OpenAPI 3.2.0.',
            '#/components/mediaTypes'
        );
        valid = false;
    }
    if (isJsonObject(components.parameters)) {
        for (const [name, parameter] of Object.entries(components.parameters)) {
            if (
                !validateParameterObject(
                    parameter,
                    root,
                    openapiVersion,
                    diagnostics,
                    `#/components/parameters/${name}`
                )
            ) {
                valid = false;
            }
        }
    }
    if (isJsonObject(components.responses)) {
        for (const [name, response] of Object.entries(components.responses)) {
            if (!validateResponseDefinition(response, diagnostics, `#/components/responses/${name}`, name)) {
                valid = false;
            }
        }
    }
    if (isJsonObject(components.pathItems)) {
        for (const [name, pathItem] of Object.entries(components.pathItems)) {
            if (
                !validatePathItemParameterProjection(
                    pathItem,
                    root,
                    openapiVersion,
                    diagnostics,
                    `#/components/pathItems/${name}`
                )
            ) {
                valid = false;
            }
        }
    }
    if (isJsonObject(components.callbacks)) {
        for (const [name, callback] of Object.entries(components.callbacks)) {
            if (
                !validateCallbackParameterProjection(
                    callback,
                    root,
                    openapiVersion,
                    diagnostics,
                    `#/components/callbacks/${name}`,
                    0
                )
            ) {
                valid = false;
            }
        }
    }
    return valid;
}

function validatePathParameters(
    path: string,
    parameters: readonly JsonValue[],
    root: unknown,
    diagnostics: OpenApiDiagnostic[],
    location: string,
    annotationId?: string
): boolean {
    const expected = templateParameters(path);
    if (!expected) {
        pushDiagnostic(
            diagnostics,
            'error',
            'malformed-path-template',
            `Path "${path}" has unmatched braces.`,
            location,
            annotationId
        );
        return false;
    }
    const provided = new Map<string, boolean>();
    let valid = true;
    for (let index = 0; index < parameters.length; index++) {
        const parameter = referencedParameter(parameters[index], root);
        if (!parameter) {
            continue;
        }
        if (parameter.in !== 'path' || typeof parameter.name !== 'string') {
            continue;
        }
        if (!expected.includes(parameter.name)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'extraneous-path-parameter',
                `Path parameter "${parameter.name}" is not present in "${path}".`,
                `${location}/parameters/${index}`,
                annotationId
            );
            valid = false;
        }
        if (provided.has(parameter.name)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'duplicate-path-parameter',
                `Path parameter "${parameter.name}" is declared more than once.`,
                `${location}/parameters/${index}`,
                annotationId
            );
            valid = false;
        }
        provided.set(parameter.name, parameter.required === true);
    }
    for (const name of expected) {
        if (!provided.has(name)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'missing-path-parameter',
                `Path template variable "{${name}}" requires an explicit path parameter.`,
                location,
                annotationId
            );
            valid = false;
        } else if (!provided.get(name)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'path-parameter-not-required',
                `Path parameter "${name}" must set required: true.`,
                location,
                annotationId
            );
            valid = false;
        }
    }
    return valid;
}

function buildOperation(
    input: OpenApiOperationMetadata,
    root: JsonObject,
    diagnostics: OpenApiDiagnostic[],
    openapiVersion: OpenApiVersion
): MutableJsonObject | null {
    const annotationId = input.annotationId;
    const location = `#/paths/${input.path}/${input.method}`;
    if (!input.path.startsWith('/') || /[?#\s]/.test(input.path)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-operation-path',
            'An operation path must start with `/` and contain no query, fragment, or whitespace.',
            location,
            annotationId
        );
        return null;
    }
    if (!HTTP_METHOD_SET.has(input.method)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-http-method',
            `Unsupported HTTP method "${input.method}".`,
            location,
            annotationId
        );
        return null;
    }
    if (input.method === 'query' && openapiVersion !== '3.2.0') {
        pushDiagnostic(
            diagnostics,
            'error',
            'unsupported-version-feature',
            'The QUERY operation requires OpenAPI 3.2.0.',
            location,
            annotationId
        );
        return null;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(input.operationId)) {
        pushDiagnostic(
            diagnostics,
            'error',
            'invalid-operation-id',
            'operationId must start with a letter or underscore and contain only letters, digits, `_`, `.`, or `-`.',
            location,
            annotationId
        );
        return null;
    }
    if (!input.responses || Object.keys(input.responses).length === 0) {
        pushDiagnostic(
            diagnostics,
            'error',
            'missing-responses',
            'Every operation requires at least one response.',
            location,
            annotationId
        );
        return null;
    }
    const responses: MutableJsonObject = {};
    for (const code of Object.keys(input.responses).sort(compareText)) {
        if (!responseCodeIsValid(code)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-response-code',
                `Response key "${code}" is not an HTTP status code, range, or default.`,
                `${location}/responses/${code}`,
                annotationId
            );
            return null;
        }
        const cloned = cloneJson(input.responses[code], `${location}/responses/${code}`, diagnostics);
        if (!cloned.ok || !isJsonObject(cloned.value)) {
            return null;
        }
        if (
            cloned.value.$ref !== undefined &&
            (typeof cloned.value.$ref !== 'string' || cloned.value.$ref.length === 0)
        ) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-response-reference',
                `Response "${code}" has an invalid $ref.`,
                `${location}/responses/${code}/$ref`,
                annotationId
            );
            return null;
        }
        if (typeof cloned.value.description !== 'string' && typeof cloned.value.$ref !== 'string') {
            pushDiagnostic(
                diagnostics,
                'error',
                'response-description-required',
                `Response "${code}" requires a description or $ref.`,
                `${location}/responses/${code}`,
                annotationId
            );
            return null;
        }
        responses[code] = cloned.value;
    }
    const operation: MutableJsonObject = {
        operationId: input.operationId,
        responses,
        'x-ooci-annotation-id': annotationId,
    };
    if (input.summary !== undefined) {
        operation.summary = input.summary;
    }
    if (input.description !== undefined) {
        operation.description = input.description;
    }
    if (input.deprecated !== undefined) {
        operation.deprecated = input.deprecated;
    }
    if (input.tags?.length) {
        operation.tags = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))].sort(compareText);
    }
    const parameters: JsonValue[] = [];
    const inputParameters = input.parameters ?? [];
    for (let index = 0; index < inputParameters.length; index++) {
        const parameter = buildParameter(
            inputParameters[index],
            `${location}/parameters/${index}`,
            diagnostics,
            annotationId,
            openapiVersion
        );
        if (!parameter) {
            return null;
        }
        parameters.push(parameter);
    }
    if (parameters.length) {
        operation.parameters = parameters;
    }
    if (!validateParameterCollection(parameters, root, openapiVersion, diagnostics, location, annotationId)) {
        return null;
    }
    if (input.requestBody !== undefined) {
        const requestBody = cloneJson(input.requestBody, `${location}/requestBody`, diagnostics);
        if (!requestBody.ok || !isJsonObject(requestBody.value)) {
            return null;
        }
        operation.requestBody = requestBody.value;
    }
    if (input.security !== undefined) {
        const security = cloneJson(input.security, `${location}/security`, diagnostics);
        if (!security.ok || !Array.isArray(security.value) || !security.value.every(isJsonObject)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-security',
                'Security requirements must be an array of objects.',
                `${location}/security`,
                annotationId
            );
            return null;
        }
        operation.security = security.value;
    }
    for (const [key, value] of Object.entries(input.extensions ?? {}).sort(([left], [right]) =>
        compareText(left, right)
    )) {
        if (!key.startsWith('x-')) {
            pushDiagnostic(
                diagnostics,
                'error',
                'invalid-operation-extension',
                `Operation extension "${key}" must start with "x-".`,
                `${location}/${key}`,
                annotationId
            );
            return null;
        }
        if (key === 'x-ooci-annotation-id') {
            pushDiagnostic(
                diagnostics,
                'warning',
                'reserved-operation-extension',
                'x-ooci-annotation-id is managed by the generator and the profile value was ignored.',
                `${location}/${key}`,
                annotationId
            );
            continue;
        }
        const cloned = cloneJson(value, `${location}/${key}`, diagnostics);
        if (!cloned.ok || cloned.value === undefined) {
            return null;
        }
        operation[key] = cloned.value;
    }
    if (!validateReferences(operation, root, diagnostics, annotationId, true)) {
        return null;
    }
    if (!validatePathParameters(input.path, parameters, root, diagnostics, location, annotationId)) {
        return null;
    }
    return operation;
}

function sortedOperations(operations: readonly OpenApiOperationMetadata[]): OpenApiOperationMetadata[] {
    return [...operations].sort(
        (left, right) =>
            compareText(left.path, right.path) ||
            compareText(left.method, right.method) ||
            compareText(left.operationId, right.operationId) ||
            compareText(left.annotationId, right.annotationId)
    );
}

function diagnosticKey(diagnostic: OpenApiDiagnostic): string {
    return [
        diagnostic.severity,
        diagnostic.code,
        diagnostic.location ?? '',
        diagnostic.annotationId ?? '',
        diagnostic.message,
    ].join('\u0000');
}

function sortAndDedupeDiagnostics(diagnostics: readonly OpenApiDiagnostic[]): OpenApiDiagnostic[] {
    const unique = new Map<string, OpenApiDiagnostic>();
    for (const diagnostic of diagnostics) {
        unique.set(diagnosticKey(diagnostic), diagnostic);
    }
    return [...unique.values()].sort(
        (left, right) =>
            compareText(left.location ?? '', right.location ?? '') ||
            compareText(left.code, right.code) ||
            compareText(left.annotationId ?? '', right.annotationId ?? '') ||
            compareText(left.message, right.message)
    );
}

/**
 * Validate the semantic invariants that JSON Schema alone cannot guarantee:
 * unique operationIds, complete required path parameters, and resolvable local
 * references. It intentionally does not claim to replace a full OAS validator.
 */
export function validateOpenApiDocument(document: unknown): OpenApiDiagnostic[] {
    const diagnostics: OpenApiDiagnostic[] = [];
    if (!isRecord(document)) {
        pushDiagnostic(diagnostics, 'error', 'invalid-document', 'The OpenAPI document must be an object.', '#');
        return diagnostics;
    }
    const openapiVersion: OpenApiVersion = document.openapi === '3.1.2' ? '3.1.2' : '3.2.0';
    if (document.openapi !== '3.2.0' && document.openapi !== '3.1.2') {
        pushDiagnostic(
            diagnostics,
            'error',
            'unsupported-openapi-version',
            'Expected OpenAPI version 3.2.0 or compatibility version 3.1.2.',
            '#/openapi'
        );
    }
    if (isRecord(document.components)) {
        validateComponentProjection(
            document.components as unknown as JsonObject,
            document,
            openapiVersion,
            diagnostics
        );
    }
    if (!isRecord(document.paths)) {
        pushDiagnostic(diagnostics, 'error', 'invalid-paths', 'The paths field must be an object.', '#/paths');
    } else {
        const operationIds = new Map<string, string>();
        for (const path of Object.keys(document.paths).sort(compareText)) {
            const pathItem = document.paths[path];
            if (!isRecord(pathItem)) {
                pushDiagnostic(
                    diagnostics,
                    'error',
                    'invalid-path-item',
                    `Path item "${path}" must be an object.`,
                    `#/paths/${path}`
                );
                continue;
            }
            const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
            validateParameterCollection(pathParameters, document, openapiVersion, diagnostics, `#/paths/${path}`);
            for (const method of HTTP_METHODS) {
                const operation = pathItem[method];
                if (operation === undefined) {
                    continue;
                }
                const location = `#/paths/${path}/${method}`;
                if (method === 'query' && openapiVersion !== '3.2.0') {
                    pushDiagnostic(
                        diagnostics,
                        'error',
                        'unsupported-version-feature',
                        'The QUERY operation requires OpenAPI 3.2.0.',
                        location
                    );
                    continue;
                }
                if (!isRecord(operation)) {
                    pushDiagnostic(diagnostics, 'error', 'invalid-operation', 'Operation must be an object.', location);
                    continue;
                }
                if (typeof operation.operationId !== 'string' || operation.operationId.length === 0) {
                    pushDiagnostic(
                        diagnostics,
                        'error',
                        'missing-operation-id',
                        'Operation requires operationId.',
                        location
                    );
                } else {
                    const first = operationIds.get(operation.operationId);
                    if (first) {
                        pushDiagnostic(
                            diagnostics,
                            'error',
                            'duplicate-operation-id',
                            `operationId "${operation.operationId}" is already used at ${first}.`,
                            location
                        );
                    } else {
                        operationIds.set(operation.operationId, location);
                    }
                }
                validateResponsesObject(operation.responses, diagnostics, `${location}/responses`);
                const operationParameters = Array.isArray(operation.parameters) ? operation.parameters : [];
                validateParameterCollection(operationParameters, document, openapiVersion, diagnostics, location);
                validatePathParameters(
                    path,
                    [...pathParameters, ...operationParameters] as JsonValue[],
                    document,
                    diagnostics,
                    location
                );
            }
        }
    }
    validateReferences(document, document, diagnostics);
    return sortAndDedupeDiagnostics(diagnostics);
}

function canonicalize(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (!isJsonObject(value)) {
        return value;
    }
    const result: MutableJsonObject = {};
    for (const key of Object.keys(value).sort(compareText)) {
        result[key] = canonicalize(value[key]);
    }
    return result;
}

/** Serialize any JSON value with deterministic recursive object-key ordering. */
export function stableJsonStringify(value: JsonValue): string {
    return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

/**
 * Build an OpenAPI document and annotation catalogue. Invalid bindings
 * are diagnosed and excluded as a whole, leaving a valid catalogue-only
 * document instead of guessing routes from prose.
 */
export function generateOpenApiDocumentation(
    annotations: readonly DocAnnotation[],
    profile: OpenApiGenerationProfile = {}
): OpenApiDocumentationResult {
    const diagnostics: OpenApiDiagnostic[] = [];
    const openapiVersion = profile.openapiVersion ?? '3.2.0';
    let components = buildComponents(profile, diagnostics, openapiVersion);
    const componentRoot: MutableJsonObject = { components };
    if (
        !validateReferences(components, componentRoot, diagnostics, undefined, true) ||
        !validateComponentProjection(components, componentRoot, openapiVersion, diagnostics)
    ) {
        pushDiagnostic(
            diagnostics,
            'error',
            'components-rejected',
            'Custom components contained unsafe or unresolved references; all custom components were omitted.',
            '#/components'
        );
        components = { schemas: { [ANNOTATION_SCHEMA_NAME]: annotationSchema() } };
    }
    const paths: MutableJsonObject = {};
    const document: MutableJsonObject = {
        openapi: openapiVersion,
        info: {
            title: profile.title?.trim() || 'Annotation API catalogue',
            version: profile.version?.trim() || '1.0.0',
            ...(profile.description?.trim() ? { description: profile.description.trim() } : {}),
        },
        paths,
        components,
    };
    if (profile.includeAnnotationCatalog ?? true) {
        document['x-ooci-annotation-catalog'] = annotationCatalogue(annotations);
        document['x-ooci-annotation-catalog-schema'] = `#/components/schemas/${ANNOTATION_SCHEMA_NAME}`;
    }
    const annotationsById = new Map<string, DocAnnotation[]>();
    for (const annotation of sortedAnnotations(annotations)) {
        const bucket = annotationsById.get(annotation.id);
        if (bucket) {
            bucket.push(annotation);
        } else {
            annotationsById.set(annotation.id, [annotation]);
        }
    }
    const operationIds = new Set<string>();
    let includedOperations = 0;
    for (const input of sortedOperations(profile.operations ?? [])) {
        const matches = annotationsById.get(input.annotationId) ?? [];
        if (matches.length !== 1) {
            pushDiagnostic(
                diagnostics,
                'error',
                matches.length === 0 ? 'unknown-annotation-binding' : 'ambiguous-annotation-binding',
                matches.length === 0
                    ? `Operation references unknown annotation "${input.annotationId}".`
                    : `Operation annotation id "${input.annotationId}" is not unique.`,
                `#/paths/${input.path}/${input.method}`,
                input.annotationId
            );
            continue;
        }
        const pathItem = isJsonObject(paths[input.path]) ? (paths[input.path] as MutableJsonObject) : {};
        if (pathItem[input.method] !== undefined) {
            pushDiagnostic(
                diagnostics,
                'error',
                'duplicate-path-operation',
                `The ${input.method.toUpperCase()} operation for "${input.path}" is already defined.`,
                `#/paths/${input.path}/${input.method}`,
                input.annotationId
            );
            continue;
        }
        if (operationIds.has(input.operationId)) {
            pushDiagnostic(
                diagnostics,
                'error',
                'duplicate-operation-id',
                `operationId "${input.operationId}" is already used; this binding was omitted.`,
                `#/paths/${input.path}/${input.method}`,
                input.annotationId
            );
            continue;
        }
        const operation = buildOperation(input, document, diagnostics, openapiVersion);
        if (!operation) {
            continue;
        }
        pathItem[input.method] = operation;
        paths[input.path] = pathItem;
        operationIds.add(input.operationId);
        includedOperations++;
    }
    if (includedOperations === 0) {
        pushDiagnostic(
            diagnostics,
            'info',
            'catalogue-only',
            'No valid explicit operation bindings were supplied; no routes were inferred from annotation text.',
            '#/paths'
        );
    }
    diagnostics.push(...validateOpenApiDocument(document));
    const finalDiagnostics = sortAndDedupeDiagnostics(diagnostics);
    return {
        document,
        json: stableJsonStringify(document),
        diagnostics: finalDiagnostics,
    };
}
