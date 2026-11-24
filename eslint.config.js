import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const commonRules = {
  'max-lines': ['error', { max: 1000, skipBlankLines: false, skipComments: false }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'eqeqeq': ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'no-duplicate-imports': 'error',
  'no-throw-literal': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'curly': ['error', 'multi-line'],
  'object-shorthand': ['warn', 'always'],
  '@stylistic/semi': ['error', 'always'],
  '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
  '@stylistic/no-trailing-spaces': 'error',
  '@stylistic/no-tabs': 'error',
  '@stylistic/eol-last': ['error', 'always'],
  '@stylistic/comma-dangle': ['error', 'always-multiline'],
};

const baseRules = {
  ...js.configs.recommended.rules,
  ...commonRules,
  'no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],
};

const tsRules = {
  ...js.configs.recommended.rules,
  ...commonRules,
  'no-undef': 'off',
  'no-unused-vars': 'off',
  '@typescript-eslint/no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],
};

export default [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'config.json',
      'im-plugin.js',
      'im-plugin.ts',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      '@stylistic': stylistic,
    },
    rules: tsRules,
  },
  {
    files: ['**/*.js'],
    ignores: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: {
      '@stylistic': stylistic,
    },
    rules: baseRules,
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: globals.browser,
    },
    plugins: {
      '@stylistic': stylistic,
    },
    rules: baseRules,
  },
];
