import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const HELPERS_FILE = path.resolve(PROJECT_ROOT, 'src/core/js-plugin/helpers.ts');
const HELPERS_REFERENCE_DOC = path.resolve(
  PROJECT_ROOT,
  'skills/airpa-plugin-create-codex/references/helpers-reference.md'
);

const findPluginHelpersClass = (sourceFile: ts.SourceFile): ts.ClassDeclaration => {
  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text === 'PluginHelpers') {
      return statement;
    }
  }
  throw new Error(`Class "PluginHelpers" not found in ${sourceFile.fileName}`);
};

const extractHelperNamespaces = (helpersFilePath: string): string[] => {
  const sourceText = readFileSync(helpersFilePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    helpersFilePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const classDecl = findPluginHelpersClass(sourceFile);
  const namespaces = new Set<string>();

  for (const member of classDecl.members) {
    if (!ts.isPropertyDeclaration(member)) {
      continue;
    }
    if (!member.type || !ts.isTypeReferenceNode(member.type)) {
      continue;
    }
    if (!ts.isIdentifier(member.name)) {
      continue;
    }

    const typeName = member.type.typeName.getText(sourceFile);
    if (typeName.endsWith('Namespace')) {
      namespaces.add(member.name.text);
    }
  }

  return Array.from(namespaces).sort();
};

const extractDocNamespaces = (docPath: string): string[] => {
  const docText = readFileSync(docPath, 'utf8');
  const regex = /^##\s+helpers\.([A-Za-z0-9_.-]+)/gm;
  const names = new Set<string>();
  let matched: RegExpExecArray | null = regex.exec(docText);

  while (matched) {
    names.add(matched[1]);
    matched = regex.exec(docText);
  }

  return Array.from(names).sort();
};

describe('helpers docs contract', () => {
  it('helpers reference 文档覆盖全部运行时命名空间', () => {
    const runtimeNamespaces = extractHelperNamespaces(HELPERS_FILE);
    const docNamespaces = extractDocNamespaces(HELPERS_REFERENCE_DOC);
    const docNamespaceSet = new Set(docNamespaces);
    const missing = runtimeNamespaces.filter((name) => !docNamespaceSet.has(name));

    expect(missing).toEqual([]);
  });

  it('helpers reference 文档不包含已失效命名空间', () => {
    const runtimeNamespaceSet = new Set(extractHelperNamespaces(HELPERS_FILE));
    const stale = extractDocNamespaces(HELPERS_REFERENCE_DOC).filter(
      (name) => name !== 'profile.launch' && !runtimeNamespaceSet.has(name)
    );

    expect(stale).toEqual([]);
  });
});
