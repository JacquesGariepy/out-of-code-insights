import * as path from 'path';
import { promises as fs } from 'fs';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    let userDataPath: string | undefined;
    let ownsUserDataPath = false;
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        const workspacePath = path.resolve(extensionDevelopmentPath, 'test-fixtures');
        // A reused VS Code profile can retain a stale lock or half-written
        // startup state after a timed-out test process. Give every run an
        // isolated profile so Extension Host startup is deterministic and
        // concurrent local runs cannot interfere with each other.
        const configuredUserDataPath = process.env.VSCODE_TEST_USER_DATA_DIR?.trim();
        ownsUserDataPath = !configuredUserDataPath;
        userDataPath = configuredUserDataPath
            ? path.resolve(configuredUserDataPath)
            : path.resolve(extensionDevelopmentPath, '.vscode-test', `user-data-${process.pid}`);

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [workspacePath, '--disable-extensions', '--disable-gpu', `--user-data-dir=${userDataPath}`],
        });
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    } finally {
        if (userDataPath && ownsUserDataPath) {
            await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {
                // Test results are authoritative; a best-effort cache cleanup
                // must not turn a green suite red on antivirus-locked files.
            });
        }
    }
}

void main();
