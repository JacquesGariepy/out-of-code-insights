// Minimal ambient declaration for @anthropic-ai/claude-code v1.x which ships no bundled .d.ts.
// Remove this file once the package exports proper TypeScript types.
declare module '@anthropic-ai/claude-code' {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export function query(options: Record<string, any>): AsyncIterable<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _default: any;
    export default _default;
}
