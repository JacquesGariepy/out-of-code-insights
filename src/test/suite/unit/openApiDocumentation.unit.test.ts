import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { DocAnnotation } from '../../../docs/AnnotationDocGenerator';
import {
    generateOpenApiDocumentation,
    parseOpenApiGenerationProfile,
    stableJsonStringify,
    validateOpenApiDocument,
    type JsonObject,
    type OpenApiGenerationProfile,
} from '../../../docs/OpenApiDocumentation';

function makeAnnotation(overrides: Partial<DocAnnotation> = {}): DocAnnotation {
    return {
        id: 'ann-users',
        file: 'src/users.ts',
        line: 10,
        state: 'active',
        message: 'GET /admin/from-untrusted-prose',
        timestamp: '2026-07-13T12:00:00.000Z',
        tags: ['openapi:get:/also-not-a-route'],
        ...overrides,
    };
}

function documentRecord(result: ReturnType<typeof generateOpenApiDocumentation>): Record<string, unknown> {
    return result.document as unknown as Record<string, unknown>;
}

function pathsOf(result: ReturnType<typeof generateOpenApiDocumentation>): Record<string, unknown> {
    return documentRecord(result).paths as Record<string, unknown>;
}

function errorCodes(result: ReturnType<typeof generateOpenApiDocumentation>): string[] {
    return result.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => diagnostic.code);
}

suite('OpenApiDocumentation', () => {
    test('accepts OpenAPI 3.1 boolean schemas in explicit parameters', () => {
        const parsed = parseOpenApiGenerationProfile({
            operations: [
                {
                    annotationId: 'ann-users',
                    path: '/users',
                    method: 'get',
                    operationId: 'listUsers',
                    parameters: [{ name: 'debug', in: 'query', schema: true }],
                    responses: { '200': { description: 'OK' } },
                },
            ],
        });
        const result = generateOpenApiDocumentation([makeAnnotation()], parsed.profile);
        assert.deepStrictEqual(errorCodes(result), []);
        assert.ok(result.json.includes('"schema": true'));
    });

    test('requires exactly one schema or content strategy for every inline parameter', () => {
        const missing = parseOpenApiGenerationProfile({
            operations: [
                {
                    annotationId: 'ann-users',
                    path: '/users',
                    method: 'get',
                    operationId: 'listUsers',
                    parameters: [{ name: 'limit', in: 'query' }],
                    responses: { '200': { description: 'OK' } },
                },
            ],
        });
        const conflicting = parseOpenApiGenerationProfile({
            operations: [
                {
                    annotationId: 'ann-users',
                    path: '/users',
                    method: 'get',
                    operationId: 'listUsers',
                    parameters: [
                        {
                            name: 'limit',
                            in: 'query',
                            schema: { type: 'integer' },
                            content: { 'application/json': { schema: { type: 'integer' } } },
                        },
                    ],
                    responses: { '200': { description: 'OK' } },
                },
            ],
        });
        assert.deepStrictEqual(missing.profile.operations, []);
        assert.deepStrictEqual(conflicting.profile.operations, []);
        assert.ok(missing.diagnostics.some((diagnostic) => diagnostic.code === 'parameter-serialization-required'));
        assert.ok(conflicting.diagnostics.some((diagnostic) => diagnostic.code === 'parameter-serialization-required'));

        const generated = generateOpenApiDocumentation([makeAnnotation()], {
            operations: [
                {
                    annotationId: 'ann-users',
                    path: '/users',
                    method: 'get',
                    operationId: 'listUsers',
                    parameters: [{ name: 'limit', in: 'query' }],
                    responses: { '200': { description: 'OK' } },
                },
            ],
        } as unknown as OpenApiGenerationProfile);
        assert.deepStrictEqual(pathsOf(generated), {});
        assert.ok(errorCodes(generated).includes('parameter-serialization-required'));
    });

    test('emits the constrained 3.2 QUERY, querystring, and reusable media type subset', () => {
        const parsed = parseOpenApiGenerationProfile({
            openapiVersion: '3.2.0',
            components: {
                mediaTypes: {
                    SearchQuery: {
                        schema: {
                            type: 'object',
                            properties: { text: { type: 'string' } },
                        },
                    },
                },
            },
            operations: [
                {
                    annotationId: 'ann-users',
                    path: '/users/search',
                    method: 'QUERY',
                    operationId: 'searchUsers',
                    parameters: [
                        {
                            name: 'search',
                            in: 'querystring',
                            content: {
                                'application/x-www-form-urlencoded': {
                                    $ref: '#/components/mediaTypes/SearchQuery',
                                },
                            },
                        },
                    ],
                    responses: { '200': { description: 'Matches' } },
                },
            ],
        });
        assert.deepStrictEqual(
            parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
            []
        );
        const result = generateOpenApiDocumentation([makeAnnotation()], parsed.profile);
        const operation = (pathsOf(result)['/users/search'] as Record<string, unknown>).query as Record<
            string,
            unknown
        >;
        const parameters = operation.parameters as Array<Record<string, unknown>>;
        assert.strictEqual(parameters[0].in, 'querystring');
        assert.ok(parameters[0].content);
        assert.ok(!Object.prototype.hasOwnProperty.call(parameters[0], 'schema'));
        const components = documentRecord(result).components as Record<string, unknown>;
        assert.ok((components.mediaTypes as Record<string, unknown>).SearchQuery);
        assert.deepStrictEqual(errorCodes(result), []);
    });

    test('rejects query/querystring conflicts and multiple whole-query parameters atomically', () => {
        const result = generateOpenApiDocumentation([makeAnnotation()], {
            operations: [
                {
                    annotationId: 'ann-users',
                    path: '/users',
                    method: 'get',
                    operationId: 'listUsers',
                    parameters: [
                        { name: 'limit', in: 'query', schema: { type: 'integer' } },
                        {
                            name: 'first',
                            in: 'querystring',
                            content: { 'application/json': { schema: { type: 'object' } } },
                        },
                        {
                            name: 'second',
                            in: 'querystring',
                            content: { 'text/plain': { schema: { type: 'string' } } },
                        },
                    ],
                    responses: { '200': { description: 'OK' } },
                },
            ],
        });
        assert.deepStrictEqual(pathsOf(result), {});
        assert.ok(errorCodes(result).includes('multiple-querystring-parameters'));
        assert.ok(errorCodes(result).includes('query-parameter-conflict'));
    });

    test('safely parses a valid workspace JSON profile and normalizes the HTTP method', () => {
        const parsed = parseOpenApiGenerationProfile({
            title: 'Workspace API',
            version: '3.0.0',
            includeAnnotationCatalog: false,
            operations: [
                {
                    annotationId: 'ann-users',
                    path: '/users',
                    method: 'GET',
                    operationId: 'listUsers',
                    tags: ['users'],
                    responses: { '200': { description: 'Listed' } },
                },
            ],
        });
        assert.deepStrictEqual(
            parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
            []
        );
        assert.strictEqual(parsed.profile.operations?.[0].method, 'get');
        const generated = generateOpenApiDocumentation([makeAnnotation()], parsed.profile);
        assert.ok(pathsOf(generated)['/users']);
        assert.ok(!documentRecord(generated)['x-ooci-annotation-catalog']);
    });

    test('omits structurally invalid profile operations without throwing or calling string methods on bad values', () => {
        const parsed = parseOpenApiGenerationProfile({
            title: 42,
            includeAnnotationCatalog: 'yes',
            extra: 'ignored',
            operations: [
                {
                    annotationId: ['not', 'a', 'string'],
                    path: { value: '/users' },
                    method: 7,
                    operationId: null,
                    responses: [],
                },
            ],
        });
        assert.deepStrictEqual(parsed.profile.operations, []);
        assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-profile-field'));
        assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.code === 'unknown-profile-field'));
        assert.doesNotThrow(() => generateOpenApiDocumentation([makeAnnotation()], parsed.profile));
    });

    test('never invokes accessors while parsing an untrusted workspace value', () => {
        let getterCalled = false;
        const untrusted: Record<string, unknown> = {};
        Object.defineProperty(untrusted, 'title', {
            enumerable: true,
            get() {
                getterCalled = true;
                throw new Error('must not run');
            },
        });
        const parsed = parseOpenApiGenerationProfile(untrusted);
        assert.strictEqual(getterCalled, false);
        assert.deepStrictEqual(parsed.profile, {});
        assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.code === 'json-accessor-rejected'));
    });

    test('rejects cyclic JSON profile data with a diagnostic', () => {
        const cyclic: Record<string, unknown> = { title: 'Cycle' };
        cyclic.self = cyclic;
        const parsed = parseOpenApiGenerationProfile(cyclic);
        assert.deepStrictEqual(parsed.profile, {});
        assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.code === 'cyclic-json-value'));
    });

    test('produces the current OpenAPI 3.2.0 catalogue without inferring routes from prose or tags', () => {
        const result = generateOpenApiDocumentation([makeAnnotation()]);
        const document = documentRecord(result);
        assert.strictEqual(document.openapi, '3.2.0');
        assert.deepStrictEqual(document.paths, {});
        assert.ok(Array.isArray(document['x-ooci-annotation-catalog']));
        assert.strictEqual(
            document['x-ooci-annotation-catalog-schema'],
            '#/components/schemas/OutOfCodeInsightsAnnotation'
        );
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'catalogue-only'));
        assert.deepStrictEqual(errorCodes(result), []);
        assert.ok(!result.json.includes('/admin/from-untrusted-prose" :'));
        assert.ok(!result.json.includes('/also-not-a-route" :'));
    });

    test('supports an explicit 3.1.2 compatibility profile', () => {
        const parsed = parseOpenApiGenerationProfile({ openapiVersion: '3.1.2' });
        const result = generateOpenApiDocumentation([makeAnnotation()], parsed.profile);
        assert.strictEqual(documentRecord(result).openapi, '3.1.2');
        assert.deepStrictEqual(errorCodes(result), []);
    });

    test('keeps the 3.1.2 projection free of 3.2-only fields', () => {
        const result = generateOpenApiDocumentation([makeAnnotation()], {
            openapiVersion: '3.1.2',
            components: {
                mediaTypes: { Query: { schema: { type: 'object' } } },
            },
            operations: [
                {
                    annotationId: 'ann-users',
                    path: '/users/search',
                    method: 'query',
                    operationId: 'searchUsers',
                    parameters: [
                        {
                            name: 'search',
                            in: 'querystring',
                            content: { 'application/json': { schema: { type: 'object' } } },
                        },
                    ],
                    responses: { '200': { description: 'Matches' } },
                },
            ],
        });
        assert.deepStrictEqual(pathsOf(result), {});
        const components = documentRecord(result).components as Record<string, unknown>;
        assert.ok(!Object.prototype.hasOwnProperty.call(components, 'mediaTypes'));
        assert.ok(errorCodes(result).includes('unsupported-version-feature'));
    });

    test('keeps response constraints synchronized between parser, generator, and profile schema', () => {
        const parsed = parseOpenApiGenerationProfile({
            operations: [
                {
                    annotationId: 'ann-users',
                    path: '/empty',
                    method: 'get',
                    operationId: 'empty',
                    responses: {},
                },
                {
                    annotationId: 'ann-users',
                    path: '/invalid-code',
                    method: 'get',
                    operationId: 'invalidCode',
                    responses: { '600': { description: 'Impossible' } },
                },
                {
                    annotationId: 'ann-users',
                    path: '/missing-description',
                    method: 'get',
                    operationId: 'missingDescription',
                    responses: { '200': { content: { 'application/json': {} } } },
                },
            ],
        });
        assert.deepStrictEqual(parsed.profile.operations, []);
        const codes = parsed.diagnostics.map((diagnostic) => diagnostic.code);
        assert.ok(codes.includes('missing-responses'));
        assert.ok(codes.includes('invalid-response-code'));
        assert.ok(codes.includes('response-description-required'));

        const schemaPath = path.resolve(__dirname, '../../../../schemas/openapi-profile.schema.json');
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as {
            $defs: {
                responses: { minProperties: number; propertyNames: { pattern: string } };
                response: { anyOf: unknown[] };
                parameter: {
                    oneOf: unknown[];
                    properties: { content: { minProperties: number; maxProperties: number } };
                };
            };
        };
        assert.strictEqual(schema.$defs.responses.minProperties, 1);
        assert.strictEqual(schema.$defs.responses.propertyNames.pattern, '^(default|[1-5](?:[0-9]{2}|XX))$');
        assert.strictEqual(schema.$defs.response.anyOf.length, 2);
        assert.strictEqual(schema.$defs.parameter.oneOf.length, 3);
        assert.strictEqual(schema.$defs.parameter.properties.content.minProperties, 1);
        assert.strictEqual(schema.$defs.parameter.properties.content.maxProperties, 1);
    });

    test('rejects unsafe references inside content parameters', () => {
        const result = generateOpenApiDocumentation([makeAnnotation()], {
            operations: [
                {
                    annotationId: 'ann-users',
                    path: '/users',
                    method: 'get',
                    operationId: 'listUsers',
                    parameters: [
                        {
                            name: 'filter',
                            in: 'query',
                            content: {
                                'application/json': { $ref: 'https://example.invalid/media-type.json' },
                            },
                        },
                    ],
                    responses: { '200': { description: 'OK' } },
                },
            ],
        });
        assert.deepStrictEqual(pathsOf(result), {});
        assert.ok(errorCodes(result).includes('external-reference-rejected'));
        assert.ok(!result.json.includes('example.invalid'));
    });

    test('includes a valid explicitly structured operation linked to an existing annotation', () => {
        const profile: OpenApiGenerationProfile = {
            title: 'Users API',
            version: '2.1.0',
            components: {
                schemas: {
                    User: { type: 'object', properties: { id: { type: 'string' } } },
                },
            },
            operations: [
                {
                    annotationId: 'ann-users',
                    path: '/users/{userId}',
                    method: 'get',
                    operationId: 'getUser',
                    summary: 'Fetch one user',
                    parameters: [
                        {
                            name: 'userId',
                            in: 'path',
                            required: true,
                            schema: { type: 'string' },
                        },
                    ],
                    responses: {
                        '200': {
                            description: 'Found',
                            content: {
                                'application/json': { schema: { $ref: '#/components/schemas/User' } },
                            },
                        },
                    },
                },
            ],
        };
        const result = generateOpenApiDocumentation([makeAnnotation()], profile);
        const pathItem = pathsOf(result)['/users/{userId}'] as Record<string, unknown>;
        const operation = pathItem.get as Record<string, unknown>;
        assert.strictEqual(operation.operationId, 'getUser');
        assert.strictEqual(operation['x-ooci-annotation-id'], 'ann-users');
        assert.deepStrictEqual(errorCodes(result), []);
        assert.deepStrictEqual(validateOpenApiDocument(result.document), []);
    });

    test('omits an operation whose template path parameter is absent or not required', () => {
        const result = generateOpenApiDocumentation([makeAnnotation()], {
            operations: [
                {
                    annotationId: 'ann-users',
                    path: '/users/{userId}',
                    method: 'get',
                    operationId: 'getUser',
                    parameters: [{ name: 'userId', in: 'path', required: false, schema: { type: 'string' } }],
                    responses: { '200': { description: 'Found' } },
                },
            ],
        });
        assert.deepStrictEqual(pathsOf(result), {});
        assert.ok(errorCodes(result).includes('path-parameter-not-required'));
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'catalogue-only'));
    });

    test('rejects external and unresolved references instead of emitting their operations', () => {
        const operations: OpenApiGenerationProfile['operations'] = [
            {
                annotationId: 'ann-users',
                path: '/external',
                method: 'get',
                operationId: 'externalRef',
                responses: { '200': { $ref: 'https://example.invalid/response.yaml' } },
            },
            {
                annotationId: 'ann-two',
                path: '/missing',
                method: 'get',
                operationId: 'missingRef',
                responses: { '200': { $ref: '#/components/responses/Missing' } },
            },
        ];
        const result = generateOpenApiDocumentation(
            [makeAnnotation(), makeAnnotation({ id: 'ann-two', file: 'src/two.ts' })],
            { operations }
        );
        assert.deepStrictEqual(pathsOf(result), {});
        assert.ok(errorCodes(result).includes('external-reference-rejected'));
        assert.ok(errorCodes(result).includes('unresolved-local-reference'));
    });

    test('falls back to the built-in catalogue schema when custom components contain unsafe refs', () => {
        const result = generateOpenApiDocumentation([makeAnnotation()], {
            components: {
                schemas: {
                    Unsafe: { $ref: 'https://example.invalid/schema.json' },
                    OtherwiseValid: { type: 'string' },
                },
            },
        });
        const components = documentRecord(result).components as Record<string, unknown>;
        const schemas = components.schemas as Record<string, unknown>;
        assert.deepStrictEqual(Object.keys(schemas), ['OutOfCodeInsightsAnnotation']);
        assert.ok(errorCodes(result).includes('external-reference-rejected'));
        assert.ok(errorCodes(result).includes('components-rejected'));
        assert.ok(!result.json.includes('https://example.invalid'));
    });

    test('enforces globally unique operationIds and deterministic winner selection', () => {
        const annotations = [makeAnnotation({ id: 'ann-b' }), makeAnnotation({ id: 'ann-a' })];
        const result = generateOpenApiDocumentation(annotations, {
            operations: [
                {
                    annotationId: 'ann-b',
                    path: '/b',
                    method: 'get',
                    operationId: 'duplicateId',
                    responses: { '200': { description: 'B' } },
                },
                {
                    annotationId: 'ann-a',
                    path: '/a',
                    method: 'get',
                    operationId: 'duplicateId',
                    responses: { '200': { description: 'A' } },
                },
            ],
        });
        assert.ok(pathsOf(result)['/a']);
        assert.ok(!pathsOf(result)['/b']);
        assert.ok(errorCodes(result).includes('duplicate-operation-id'));
    });

    test('semantic validator reports duplicate operationIds, incomplete path parameters, and refs', () => {
        const document = {
            openapi: '3.1.2',
            info: { title: 'Broken', version: '1' },
            paths: {
                '/users/{id}': {
                    get: {
                        operationId: 'same',
                        parameters: [{ name: 'id', in: 'path', required: false }],
                        responses: { '200': { description: 'OK' } },
                    },
                },
                '/teams': {
                    post: {
                        operationId: 'same',
                        responses: { '200': { $ref: '#/components/responses/Absent' } },
                    },
                },
            },
            components: {},
        };
        const codes = validateOpenApiDocument(document).map((diagnostic) => diagnostic.code);
        assert.ok(codes.includes('duplicate-operation-id'));
        assert.ok(codes.includes('path-parameter-not-required'));
        assert.ok(codes.includes('unresolved-local-reference'));
    });

    test('canonical JSON is stable across annotation, operation, tag, and component insertion order', () => {
        const a = makeAnnotation({ id: 'a', tags: ['z', 'a'] });
        const b = makeAnnotation({ id: 'b', file: 'b.ts' });
        const operationA: NonNullable<OpenApiGenerationProfile['operations']>[number] = {
            annotationId: 'a',
            path: '/a',
            method: 'get',
            operationId: 'a',
            responses: { '200': { description: 'A' } },
        };
        const operationB: NonNullable<OpenApiGenerationProfile['operations']>[number] = {
            annotationId: 'b',
            path: '/b',
            method: 'get',
            operationId: 'b',
            responses: { '200': { description: 'B' } },
        };
        const first = generateOpenApiDocumentation([b, a], {
            components: {
                schemas: { Z: { type: 'string' }, A: { type: 'integer' } },
                mediaTypes: {
                    Z: { schema: { type: 'string', description: 'Z' } },
                    A: { schema: { description: 'A', type: 'integer' } },
                },
            },
            operations: [operationB, operationA],
        });
        const second = generateOpenApiDocumentation([a, b], {
            components: {
                mediaTypes: {
                    A: { schema: { type: 'integer', description: 'A' } },
                    Z: { schema: { description: 'Z', type: 'string' } },
                },
                schemas: { A: { type: 'integer' }, Z: { type: 'string' } },
            },
            operations: [operationA, operationB],
        });
        assert.strictEqual(first.json, second.json);
        assert.deepStrictEqual(first.diagnostics, second.diagnostics);
        assert.strictEqual(stableJsonStringify(first.document as JsonObject), first.json);
    });
});
