import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    maxWorkers: 3,
    // Several suites replay hundreds of edits or load a project end to end:
    // 2–5 s here, and two or three times that on a 2-core CI runner, where
    // the default 5 s cut them off.
    testTimeout: 20_000,
    // test/ui (and its build in out/) runs inside VS Code via @vscode/test-cli.
    exclude: [...configDefaults.exclude, 'test/ui/**', 'out/**'],
  },
});
