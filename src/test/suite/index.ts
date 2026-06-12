import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 20000,
        // Optional filter for local debugging: MOCHA_GREP="Scenario H" npm test
        // MOCHA_INVERT=1 excludes the grep matches instead (e.g. skip the
        // clipboard-dependent suites when the OS clipboard is unavailable).
        grep: process.env.MOCHA_GREP || undefined,
        invert: process.env.MOCHA_INVERT === '1',
    });

    const testsRoot = path.resolve(__dirname, '..');
    const files = await glob('**/*.test.js', { cwd: testsRoot });

    files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

    await new Promise<void>((resolve, reject) => {
        try {
            mocha.run((failures) => {
                if (failures > 0) {
                    reject(new Error(`${failures} tests failed.`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}
