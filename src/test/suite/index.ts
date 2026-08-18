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
    const files = (await glob('**/*.test.js', { cwd: testsRoot })).sort((left, right) =>
        left.localeCompare(right, 'en')
    );

    files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

    // Opt-in pacing for watching the suite run visually in the Extension
    // Development Host window: OOCI_TEST_STEP_DELAY_MS=300 npm test pauses
    // after every test so a human can follow along. 0/unset (default) runs
    // at full speed for CI and normal local runs.
    const stepDelayMs = Number(process.env.OOCI_TEST_STEP_DELAY_MS ?? 0);
    if (stepDelayMs > 0) {
        mocha.suite.afterEach(async function () {
            this.timeout(stepDelayMs + 5000);
            await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
        });
    }

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
