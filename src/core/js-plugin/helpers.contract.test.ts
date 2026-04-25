import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

type ClassMethodContract = {
  name: string;
  requiredParams: number;
  returnType: string;
};

type ClassPropertyContract = {
  name: string;
  type: string;
};

type ClassContract = {
  methods: ClassMethodContract[];
  properties: ClassPropertyContract[];
};

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const HELPERS_FILE = path.resolve(PROJECT_ROOT, 'src/core/js-plugin/helpers.ts');

const NAMESPACE_CLASS_MAP: Record<string, { file: string; className: string }> = {
  plugin: { file: 'src/core/js-plugin/namespaces/plugin.ts', className: 'PluginNamespace' },
  database: { file: 'src/core/js-plugin/namespaces/database.ts', className: 'DatabaseNamespace' },
  network: { file: 'src/core/js-plugin/namespaces/network.ts', className: 'NetworkNamespace' },
  ui: { file: 'src/core/js-plugin/namespaces/ui.ts', className: 'UINamespace' },
  storage: { file: 'src/core/js-plugin/namespaces/storage.ts', className: 'StorageNamespace' },
  utils: { file: 'src/core/js-plugin/namespaces/utils/index.ts', className: 'UtilsNamespace' },
  window: { file: 'src/core/js-plugin/namespaces/window.ts', className: 'WindowNamespace' },
  ffi: { file: 'src/core/js-plugin/namespaces/ffi.ts', className: 'FFINamespace' },
  taskQueue: { file: 'src/core/js-plugin/namespaces/task-queue.ts', className: 'TaskQueueNamespace' },
  button: { file: 'src/core/js-plugin/namespaces/button.ts', className: 'ButtonNamespace' },
  scheduler: { file: 'src/core/js-plugin/namespaces/scheduler.ts', className: 'SchedulerNamespace' },
  openai: { file: 'src/core/js-plugin/namespaces/openai.ts', className: 'OpenAINamespace' },
  webhook: { file: 'src/core/js-plugin/namespaces/webhook.ts', className: 'WebhookNamespace' },
  raw: { file: 'src/core/js-plugin/namespaces/raw.ts', className: 'RawNamespace' },
  advanced: { file: 'src/core/js-plugin/namespaces/advanced.ts', className: 'AdvancedNamespace' },
  profile: { file: 'src/core/js-plugin/namespaces/profile.ts', className: 'ProfileNamespace' },
  account: { file: 'src/core/js-plugin/namespaces/account.ts', className: 'AccountNamespace' },
  savedSite: {
    file: 'src/core/js-plugin/namespaces/saved-site.ts',
    className: 'SavedSiteNamespace',
  },
  cloud: {
    file: 'src/core/js-plugin/namespaces/cloud.ts',
    className: 'CloudNamespace',
  },
  customField: {
    file: 'src/core/js-plugin/namespaces/custom-field.ts',
    className: 'CustomFieldNamespace',
  },
  onnx: { file: 'src/core/js-plugin/namespaces/onnx.ts', className: 'ONNXNamespace' },
  image: { file: 'src/core/js-plugin/namespaces/image.ts', className: 'ImageNamespace' },
  imageSearch: {
    file: 'src/core/js-plugin/namespaces/image-search.ts',
    className: 'ImageSearchNamespace',
  },
  ocr: { file: 'src/core/js-plugin/namespaces/ocr.ts', className: 'OCRNamespace' },
  cv: { file: 'src/core/js-plugin/namespaces/cv.ts', className: 'CVNamespace' },
  vectorIndex: {
    file: 'src/core/js-plugin/namespaces/vector-index.ts',
    className: 'VectorIndexNamespace',
  },
};

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean => {
  return !!node.modifiers?.some((modifier) => modifier.kind === kind);
};

const isPublicInstanceMember = (node: ts.Node): boolean => {
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return false;
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return false;
  if (hasModifier(node, ts.SyntaxKind.StaticKeyword)) return false;
  return true;
};

const normalizeTypeText = (text: string): string => text.replace(/\s+/g, ' ').trim();

const getRequiredParamsCount = (params: readonly ts.ParameterDeclaration[]): number => {
  return params.filter((param) => !param.questionToken && !param.initializer && !param.dotDotDotToken)
    .length;
};

const loadSourceFile = (filePath: string): ts.SourceFile => {
  const text = readFileSync(filePath, 'utf8');
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
};

const findClass = (sourceFile: ts.SourceFile, className: string): ts.ClassDeclaration => {
  for (const stmt of sourceFile.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === className) {
      return stmt;
    }
  }
  throw new Error(`Class "${className}" not found in ${sourceFile.fileName}`);
};

const getMemberName = (name: ts.PropertyName | ts.PrivateIdentifier, sourceFile: ts.SourceFile): string => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  return name.getText(sourceFile);
};

const extractClassContract = (filePath: string, className: string): ClassContract => {
  const sourceFile = loadSourceFile(filePath);
  const classDecl = findClass(sourceFile, className);
  const methods: ClassMethodContract[] = [];
  const properties: ClassPropertyContract[] = [];

  for (const member of classDecl.members) {
    if (!isPublicInstanceMember(member)) continue;

    if (ts.isMethodDeclaration(member) && member.name) {
      const name = getMemberName(member.name, sourceFile);
      if (name === 'constructor') continue;
      methods.push({
        name,
        requiredParams: getRequiredParamsCount(member.parameters),
        returnType: normalizeTypeText(member.type?.getText(sourceFile) ?? 'any'),
      });
      continue;
    }

    if (ts.isPropertyDeclaration(member) && member.name) {
      const typeText = normalizeTypeText(member.type?.getText(sourceFile) ?? 'any');
      properties.push({
        name: getMemberName(member.name, sourceFile),
        type: typeText,
      });
    }
  }

  const uniqueMethods = Array.from(
    new Map(
      methods
        .map((method) => [`${method.name}|${method.requiredParams}|${method.returnType}`, method] as const)
        .sort((a, b) => a[0].localeCompare(b[0]))
    ).values()
  );

  return {
    methods: uniqueMethods.sort((a, b) => a.name.localeCompare(b.name)),
    properties: properties.sort((a, b) => a.name.localeCompare(b.name)),
  };
};

describe('PluginHelpers contract snapshot', () => {
  it('helpers public surface is stable', () => {
    const helpersContract = extractClassContract(HELPERS_FILE, 'PluginHelpers');
    const helperNamespaces = helpersContract.properties
      .filter((property) => property.type.endsWith('Namespace'))
      .map((property) => property.name)
      .sort();

    expect(helperNamespaces).toEqual(Object.keys(NAMESPACE_CLASS_MAP).sort());

    const namespaceContracts = Object.fromEntries(
      helperNamespaces.map((namespaceName) => {
        const namespaceMeta = NAMESPACE_CLASS_MAP[namespaceName];
        const namespaceFile = path.resolve(PROJECT_ROOT, namespaceMeta.file);
        const namespaceContract = extractClassContract(namespaceFile, namespaceMeta.className);
        return [namespaceName, namespaceContract.methods];
      })
    );

    const publicHelpersMethods = helpersContract.methods.sort((a, b) => a.name.localeCompare(b.name));

    expect({
      helperNamespaces,
      publicHelpersMethods,
      namespaceContracts,
    }).toMatchSnapshot();
  });
});
