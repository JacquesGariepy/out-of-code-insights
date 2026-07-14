import * as assert from 'assert';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const FILE_TYPE = {
    File: 1,
    Directory: 2,
    SymbolicLink: 64,
} as const;

const OPTIONS = {
    generatorVersion: 'writer-unit-test',
    template: 'test',
    formats: ['markdown'],
    generatedAt: '2026-07-13T00:00:00.000Z',
};

class TestUri {
    public readonly scheme = 'file';
    public readonly authority = '';
    public readonly path: string;

    private constructor(public readonly fsPath: string) {
        this.path = fsPath.replace(/\\/g, '/');
    }

    public static file(filePath: string): TestUri {
        return new TestUri(path.resolve(filePath));
    }

    public static joinPath(root: TestUri, ...segments: string[]): TestUri {
        return TestUri.file(path.join(root.fsPath, ...segments));
    }

    public toString(_skipEncoding?: boolean): string {
        return pathToFileURL(this.fsPath).toString();
    }
}

interface RenameOptions {
    overwrite: boolean;
}

interface DeleteOptions {
    recursive: boolean;
    useTrash: boolean;
}

class LocalWorkspaceFileSystem {
    public readonly events: string[] = [];
    public statFailure: ((uri: TestUri) => Error | undefined) | undefined;
    public renameFailure: ((source: TestUri, destination: TestUri) => Error | undefined) | undefined;

    public async stat(uri: TestUri): Promise<{ type: number; ctime: number; mtime: number; size: number }> {
        const failure = this.statFailure?.(uri);
        if (failure) {
            throw failure;
        }
        const fileStat = await fsPromises.lstat(uri.fsPath);
        const type = fileStat.isSymbolicLink()
            ? FILE_TYPE.SymbolicLink
            : fileStat.isDirectory()
              ? FILE_TYPE.Directory
              : FILE_TYPE.File;
        return { type, ctime: fileStat.ctimeMs, mtime: fileStat.mtimeMs, size: fileStat.size };
    }

    public async readDirectory(uri: TestUri): Promise<Array<[string, number]>> {
        const entries = await fsPromises.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((entry) => [
            entry.name,
            entry.isSymbolicLink()
                ? FILE_TYPE.SymbolicLink
                : entry.isDirectory()
                  ? FILE_TYPE.Directory
                  : FILE_TYPE.File,
        ]);
    }

    public async createDirectory(uri: TestUri): Promise<void> {
        this.events.push(`mkdir:${uri.fsPath}`);
        await fsPromises.mkdir(uri.fsPath, { recursive: true });
    }

    public async readFile(uri: TestUri): Promise<Uint8Array> {
        return fsPromises.readFile(uri.fsPath);
    }

    public async writeFile(uri: TestUri, content: Uint8Array): Promise<void> {
        this.events.push(`write:${uri.fsPath}`);
        await fsPromises.writeFile(uri.fsPath, content);
    }

    public async rename(source: TestUri, destination: TestUri, options: RenameOptions): Promise<void> {
        const failure = this.renameFailure?.(source, destination);
        if (failure) {
            throw failure;
        }
        if (!options.overwrite) {
            try {
                await fsPromises.lstat(destination.fsPath);
                throw Object.assign(new Error(`Destination exists: ${destination.fsPath}`), { code: 'EEXIST' });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
        }
        this.events.push(`rename:${source.fsPath}->${destination.fsPath}`);
        await fsPromises.rename(source.fsPath, destination.fsPath);
    }

    public async delete(uri: TestUri, options: DeleteOptions): Promise<void> {
        const fileStat = await fsPromises.lstat(uri.fsPath);
        if (fileStat.isDirectory()) {
            await fsPromises.rm(uri.fsPath, { recursive: options.recursive, force: false });
        } else {
            await fsPromises.unlink(uri.fsPath);
        }
    }
}

interface WriterModule {
    DOCUMENTATION_TRANSACTION_DIRECTORY: string;
    writeDocumentationBundle(
        workspaceRoot: TestUri,
        outputDirectory: TestUri,
        files: ReadonlyMap<string, string>,
        options: typeof OPTIONS
    ): Promise<{ written: number; removed: number; warnings: string[] }>;
}

interface ModuleLoader {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
}

function loadWriter(fileSystem: LocalWorkspaceFileSystem): WriterModule {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const moduleLoader = require('module') as ModuleLoader;
    const originalLoad = moduleLoader._load;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const realFileSystemPromises = require('fs/promises') as typeof fsPromises;
    const writerPath = require.resolve('../../../docs/WorkspaceDocumentationWriter');
    delete require.cache[writerPath];

    moduleLoader._load = (request, parent, isMain): unknown => {
        if (request === 'vscode') {
            return {
                FileType: FILE_TYPE,
                Uri: TestUri,
                workspace: { fs: fileSystem },
            };
        }
        if (request === 'fs/promises') {
            return {
                ...realFileSystemPromises,
                lstat: async (filePath: fs.PathLike) => {
                    fileSystem.events.push(`lstat:${String(filePath)}`);
                    return realFileSystemPromises.lstat(filePath);
                },
            };
        }
        return originalLoad(request, parent, isMain);
    };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(writerPath) as WriterModule;
    } finally {
        moduleLoader._load = originalLoad;
    }
}

function errorWithCode(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

suite('WorkspaceDocumentationWriter deterministic transaction contracts', () => {
    const roots: string[] = [];

    teardown(() => {
        for (const root of roots.splice(0)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    function fixture(): {
        rootPath: string;
        root: TestUri;
        output: TestUri;
        fileSystem: LocalWorkspaceFileSystem;
        writer: WriterModule;
    } {
        const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ooci-writer-unit-'));
        roots.push(rootPath);
        const fileSystem = new LocalWorkspaceFileSystem();
        return {
            rootPath,
            root: TestUri.file(rootPath),
            output: TestUri.file(path.join(rootPath, 'docs')),
            fileSystem,
            writer: loadWriter(fileSystem),
        };
    }

    test('serializes concurrent writers for one output and publishes each journal through temp rename', async () => {
        const { root, output, fileSystem, writer } = fixture();

        await Promise.all([
            writer.writeDocumentationBundle(root, output, new Map([['guide.md', '# first\n']]), OPTIONS),
            writer.writeDocumentationBundle(root, output, new Map([['guide.md', '# second\n']]), OPTIONS),
        ]);

        assert.strictEqual(fs.readFileSync(path.join(output.fsPath, 'guide.md'), 'utf8'), '# second\n');
        assert.strictEqual(fs.existsSync(path.join(output.fsPath, writer.DOCUMENTATION_TRANSACTION_DIRECTORY)), false);
        assert.strictEqual(
            fileSystem.events.filter((event) => event.includes('write:') && event.endsWith('journal.json')).length,
            0,
            'the final journal is never written directly'
        );
        assert.strictEqual(
            fileSystem.events.filter(
                (event) =>
                    event.includes('rename:') && event.includes('journal.json.tmp->') && event.endsWith('journal.json')
            ).length,
            2,
            'each queued transaction atomically publishes one verified journal'
        );

        for (let index = 0; index < fileSystem.events.length; index++) {
            const event = fileSystem.events[index];
            if (!event.startsWith('rename:')) {
                continue;
            }
            const destination = event.slice(event.indexOf('->') + 2);
            assert.strictEqual(
                fileSystem.events[index - 1],
                `lstat:${path.dirname(destination)}`,
                `rename destination parent must be revalidated immediately: ${destination}`
            );
        }
    });

    test('does not require a rollback backup for a previously managed file already absent at preflight', async () => {
        const { root, output, fileSystem, writer } = fixture();
        await writer.writeDocumentationBundle(
            root,
            output,
            new Map([
                ['guide.md', '# previous\n'],
                ['obsolete.md', '# obsolete\n'],
            ]),
            OPTIONS
        );
        fs.unlinkSync(path.join(output.fsPath, 'obsolete.md'));

        let injected = false;
        fileSystem.renameFailure = (source, destination) => {
            if (
                !injected &&
                source.fsPath.includes(`${path.sep}stage${path.sep}`) &&
                destination.fsPath.endsWith('guide.md')
            ) {
                injected = true;
                return errorWithCode('EIO', 'injected install failure');
            }
            return undefined;
        };

        let failure: unknown;
        try {
            await writer.writeDocumentationBundle(root, output, new Map([['guide.md', '# next\n']]), OPTIONS);
        } catch (error) {
            failure = error;
        }
        assert.match(String(failure), /injected install failure/);
        assert.ok(
            fs.existsSync(path.join(output.fsPath, 'guide.md')),
            `guide must be restored; failure=${String(failure)}; events=${JSON.stringify(fileSystem.events)}`
        );
        assert.strictEqual(fs.readFileSync(path.join(output.fsPath, 'guide.md'), 'utf8'), '# previous\n');
        assert.strictEqual(
            fs.existsSync(path.join(output.fsPath, writer.DOCUMENTATION_TRANSACTION_DIRECTORY)),
            false,
            'rollback is complete even though obsolete.md had no preflight destination or backup'
        );
    });

    test('propagates permission failures from workspace stat instead of treating them as missing', async () => {
        const { root, output, fileSystem, writer } = fixture();
        fileSystem.statFailure = (uri) =>
            uri.fsPath === output.fsPath ? errorWithCode('EACCES', 'permission denied by provider') : undefined;

        await assert.rejects(
            writer.writeDocumentationBundle(root, output, new Map([['guide.md', '# blocked\n']]), OPTIONS),
            (error: unknown) => (error as NodeJS.ErrnoException).code === 'EACCES'
        );
        assert.strictEqual(fs.existsSync(output.fsPath), false);
    });
});
