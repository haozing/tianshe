/**
 * ESLint 配置 - 针对 Electron 混合架构优化
 *
 * 项目特性：
 * - 主进程：CommonJS (src/main, src/core)
 * - 渲染进程：ESM + React (src/renderer)
 * - Preload：混合环境 (src/preload)
 * - 插件系统：运行在主进程，动态加载
 */

import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
  // ==================== 全局忽略配置 ====================
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/release-build/**',
      '**/*.min.js',
      '**/.git/**',
      '**/coverage/**',
      '**/.vite/**',
      '**/*.config.*.timestamp-*', // Vite 生成的临时文件
      // 示例/演示脚本不参与 lint（可能包含大量临时代码与空块）
      '**/examples/**',
      // 数据文件和运行时生成的文件
      '**/*.duckdb',
      '**/*.duckdb.wal',
    ],
  },

  // ==================== JavaScript 基础配置 ====================
  js.configs.recommended,

  // ==================== TypeScript 通用配置 ====================
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
        // 注意：未启用 project，以提升性能
        // 如需类型感知规则，取消下面注释：
        // project: ['./tsconfig.json', './tsconfig.main.json'],
        // tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // 禁用与 TypeScript 冲突的 JS 规则
      'no-shadow': 'off',
      'no-unused-vars': 'off',
      'no-undef': 'off', // TypeScript 已经处理未定义变量

      // TypeScript 基础规则
      '@typescript-eslint/no-shadow': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Electron 安全性规则
      '@typescript-eslint/no-floating-promises': 'off', // 需要 parserOptions.project
      '@typescript-eslint/await-thenable': 'off', // 需要 parserOptions.project
      '@typescript-eslint/no-misused-promises': 'off', // 需要 parserOptions.project

      // 代码质量规则
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // 通用规则
      'no-console': 'off', // Electron 开发工具，允许 console
      'no-extra-boolean-cast': 'warn',
      'no-useless-escape': 'warn',
    },
  },

  // ==================== 主进程 + 核心模块 (Node.js 环境) ====================
  {
    files: [
      'src/main/**/*.ts',
      'src/core/**/*.ts',
      'src/utils/**/*.ts', // 工具函数可能在主进程使用
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        // Electron 主进程特有
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      // 主进程特定规则
      '@typescript-eslint/no-var-requires': 'off', // 插件系统使用 require()
      'no-restricted-globals': [
        'error',
        {
          name: 'window',
          message: 'window is not available in main process. Use BrowserWindow instead.',
        },
        {
          name: 'document',
          message: 'document is not available in main process.',
        },
      ],
    },
  },

  // ==================== Preload 脚本 (混合环境) ====================
  {
    files: ['src/preload/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      '@typescript-eslint/no-var-requires': 'warn',
      'no-restricted-globals': [
        'error',
        {
          name: 'require',
          message: 'Avoid using require in preload. Use import or contextBridge instead.',
        },
      ],
    },
  },

  // ==================== 渲染进程 - Hooks 和工具 (需要动态类型) ====================
  {
    files: [
      'src/renderer/src/hooks/**/*.ts',
      'src/renderer/src/lib/**/*.ts',
      'src/renderer/index.tsx',
      'src/renderer/src/main.tsx',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // Hooks 和工具函数需要处理动态类型
      '@typescript-eslint/no-non-null-assertion': 'off', // 允许非空断言
    },
  },

  // ==================== 渲染进程 (Browser + React 环境) ====================
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      // React 推荐规则
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,

      // React 18+ 优化
      'react/react-in-jsx-scope': 'off', // 不需要导入 React
      'react/prop-types': 'off', // 使用 TypeScript 类型检查

      // 放宽 React 组件中的类型检查
      '@typescript-eslint/no-explicit-any': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',

      // 渲染进程安全规则
      'no-restricted-globals': [
        'error',
        {
          name: 'require',
          message: 'require is not available in renderer. Use import or window.electron API.',
        },
        {
          name: '__dirname',
          message: '__dirname is not available in renderer process.',
        },
        {
          name: 'process',
          message: 'process is not directly available in renderer. Use window.electron API.',
        },
      ],
    },
  },

  // ==================== DatasetsPage 组件（大量动态数据处理） ====================
  {
    files: ['src/renderer/src/components/DatasetsPage/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/incompatible-library': 'off',
    },
  },

  // ==================== 类型定义文件 ====================
  {
    files: ['src/types/**/*.ts', '**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // 类型定义中允许 any
      '@typescript-eslint/no-unused-vars': 'off', // 类型定义可能未使用
    },
  },

  // ==================== 测试文件 (Node.js 环境 - Vitest) ====================
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/__tests__/**/*.ts',
      '**/__tests__/**/*.tsx',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest, // Vitest 兼容 Jest API
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // 测试中允许 any
      '@typescript-eslint/no-non-null-assertion': 'off', // 测试中允许非空断言
      'no-console': 'off',
      'no-restricted-globals': 'off',
    },
  },

  // ==================== JavaScript 测试文件 (Node.js 环境 - Vitest) ====================
  {
    files: ['**/*.test.js', '**/*.spec.js', '**/__tests__/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
        vi: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // ==================== 配置文件 ====================
  {
    files: ['*.config.js', '*.config.ts', 'scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
      'no-console': 'off',
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // ==================== Root check scripts (Node.js) ====================
  {
    files: ['fpjs-electron-check.js', 'simple-electron-check.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      sourceType: 'script',
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // ==================== Native Module Files ====================
  {
    files: ['src/native/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      sourceType: 'commonjs',
    },
    rules: {
      'no-console': 'off',
      'no-undef': 'off',
      '@typescript-eslint/no-var-requires': 'off',
    },
  },

  // ==================== 插件系统核心代码 (需要动态类型) ====================
  {
    files: [
      'src/core/**/*.ts', // 核心模块
      'src/main/duckdb/**/*.ts', // 数据库服务
      'src/main/ipc-handlers/**/*.ts', // IPC 处理器
      'src/main/ipc.ts',
      'src/main/ipc-utils.ts',
      'src/main/file-storage.ts', // 文件存储
      'src/preload/**/*.ts', // Preload 脚本
      'src/utils/**/*.ts', // 工具函数
      'src/main/logger.ts', // 日志
      'src/renderer/src/utils/**/*.ts', // 渲染进程工具函数
      'src/renderer/src/stores/**/*.ts', // 状态管理
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // 这些模块需要处理动态类型
      '@typescript-eslint/no-non-null-assertion': 'off', // 允许非空断言
    },
  },

  // ==================== Web 静态页面 JS 文件 (Browser 环境) ====================
  {
    files: ['web/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      sourceType: 'script',
      parserOptions: {
        ecmaVersion: 2022,
      },
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_|^(copyCode|toggleSidebar)$', // HTML 中调用的函数
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // ==================== 插件文件 (examples/docs/plugins 中的 JS 文件) ====================
  {
    files: ['examples/**/*.js', 'docs/**/*.js', 'plugins/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
      },
      sourceType: 'module', // 支持 ES6 import/export
      parserOptions: {
        ecmaVersion: 2022,
      },
    },
    rules: {
      'no-console': 'off',
      'no-undef': 'off', // 允许插件中使用未定义的全局变量
      'no-unreachable': 'off', // examples/docs/plugins 允许早退/调试代码
      'no-useless-escape': 'off', // 插件代码中允许正则表达式转义（如 \s）
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // ==================== AI-Dev 分层边界约束 ====================
  {
    files: ['src/core/ai-dev/orchestration/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../mcp',
                '../mcp/*',
                '../mcp/**',
                '../../mcp',
                '../../mcp/*',
                '../../mcp/**',
                '../../../mcp',
                '../../../mcp/*',
                '../../../mcp/**',
                '**/ai-dev/mcp/*',
                '**/ai-dev/mcp/**',
              ],
              message:
                'orchestration 层禁止依赖 mcp 层。请改为依赖 capabilities 或 orchestration 自身抽象。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/main/mcp-server-http.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../core/ai-dev/mcp/*', '../core/ai-dev/mcp/**'],
              message:
                'HTTP 入口禁止直接依赖 mcp 内部模块。请改为依赖 orchestration/capabilities。',
            },
          ],
        },
      ],
    },
  },

  // ==================== Prettier 集成 (必须放最后) ====================
  prettierConfig,
];
