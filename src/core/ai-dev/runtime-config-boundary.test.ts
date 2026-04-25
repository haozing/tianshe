import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = 'src';

const shouldSkipFile = (filePath: string): boolean => {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized.includes('/__tests__/') ||
    normalized.includes('/e2e/') ||
    normalized.includes('/renderer/src/test/') ||
    normalized.endsWith('.test.ts') ||
    normalized.endsWith('.test.tsx')
  );
};

const collectSourceFiles = (dir: string): string[] => {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!fullPath.endsWith('.ts') && !fullPath.endsWith('.tsx')) {
      continue;
    }

    if (shouldSkipFile(fullPath)) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
};

const isProcessEnvAccess = (expression: ts.Expression): boolean => {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'process' &&
    expression.name.text === 'env'
  );
};

const isImportMetaEnvAccess = (expression: ts.Expression): boolean => {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isMetaProperty(expression.expression) &&
    expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    expression.expression.name.text === 'meta' &&
    expression.name.text === 'env'
  );
};

const collectEnvViolations = (filePath: string): string[] => {
  const source = readFileSync(filePath, 'utf8');
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);

  const violations: string[] = [];

  const pushViolation = (node: ts.Node, reason: string): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push(
      `${relative(process.cwd(), filePath).replace(/\\/g, '/')}:${line + 1}:${character + 1} ${reason}`
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      if (isProcessEnvAccess(node)) {
        pushViolation(node, 'process.env is forbidden; use src/constants/runtime-config.ts');
      }

      if (isImportMetaEnvAccess(node.expression)) {
        pushViolation(node, 'import.meta.env is forbidden; use runtime mode/config from main process');
      }
    }

    if (ts.isElementAccessExpression(node)) {
      if (isProcessEnvAccess(node.expression)) {
        pushViolation(node, 'process.env[...] is forbidden; use src/constants/runtime-config.ts');
      }

      if (isImportMetaEnvAccess(node.expression)) {
        pushViolation(node, 'import.meta.env[...] is forbidden; use runtime mode/config from main process');
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return violations;
};

describe('Runtime config boundary', () => {
  it('runtime source files must not read process.env/import.meta.env directly', () => {
    const files = collectSourceFiles(SRC_ROOT);
    const violations = files.flatMap((file) => collectEnvViolations(file));

    expect(violations).toEqual([]);
  });
});
