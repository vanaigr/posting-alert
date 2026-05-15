import tseslint from 'typescript-eslint';

export default tseslint.config({
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {
        parserOptions: {
            projectService: true,
            tsconfigRootDir: import.meta.dirname,
        },
    },
    rules: {
        // A promise-returning call must be either awaited or explicitly
        // discarded with `void`. `ignoreVoid` is on by default.
        '@typescript-eslint/no-floating-promises': 'error',
    },
});
