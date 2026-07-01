import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVICE_PATH = resolve(process.cwd(), 'src/main/duckdb/service.ts');

const LEGACY_PROXY_GROUPS = [
  {
    methods: ['log', 'getTaskLogs', 'getRecentLogs', 'cleanupLogs', 'clearLogs'],
    migration:
      'Legacy log facade retained for existing IPC callers; new code should use a dedicated log service accessor.',
  },
  {
    methods: ['getTraceSummary', 'getFailureBundle', 'getTraceTimeline', 'searchRecentFailures'],
    migration:
      'Legacy observation query facade retained for diagnostics callers; new code should use the observation query service boundary.',
  },
  {
    methods: [
      'listDatasets',
      'getDatasetInfo',
      'hardDeleteRows',
      'reorderGroupTabs',
      'renameGroupTab',
      'insertRecord',
      'batchInsertRecords',
      'importRecordsFromFile',
      'updateRecord',
      'batchUpdateRecords',
      'cancelImport',
      'updateColumnMetadata',
      'updateColumnDisplayConfig',
      'previewFilterCount',
      'previewAggregate',
      'previewSample',
      'previewLookup',
      'filterWithAhoCorasick',
      'createTempRowIdTable',
      'dropTempRowIdTable',
      'validateComputeExpression',
      'previewGroup',
      'withDatasetAttached',
      'exportDataset',
    ],
    migration:
      'Legacy dataset facade retained for renderer/store compatibility; new main-process code should call getDatasetService().',
  },
  {
    methods: [
      'saveAutomation',
      'loadAutomation',
      'listAutomations',
      'updateAutomation',
      'deleteAutomation',
      'executeSQLWithParams',
      'executeWithParams',
    ],
    migration:
      'Legacy automation facade retained for compatibility; new code should depend on AutomationPersistenceService directly.',
  },
  {
    methods: [
      'saveTask',
      'updateTaskStatus',
      'loadUnfinishedTasks',
      'deleteTask',
      'cleanupOldTasks',
    ],
    migration:
      'Legacy task facade retained for compatibility; new code should use the scheduled/task persistence service boundary.',
  },
  {
    methods: ['previewClean', 'previewDedupe'],
    migration:
      'Legacy query preview facade retained for renderer query flows; new code should use getQueryEngine().preview.',
  },
  {
    methods: ['listQueryTemplates', 'getQueryTemplate', 'reorderQueryTemplates'],
    migration:
      'Legacy query-template facade retained for renderer compatibility; new code should use the query template service boundary.',
  },
] as const;

interface PureProxyMethod {
  name: string;
  target: string;
  line: number;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function getThisPropertyCallPath(expression: ts.Expression): string[] | null {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isCallExpression(unwrapped)) {
    return null;
  }

  const path: string[] = [];
  let current = unwrapped.expression;
  while (ts.isPropertyAccessExpression(current)) {
    path.unshift(current.name.text);
    current = current.expression;
  }

  return ts.isThis(current) ? path : null;
}

function getDelegateCallPath(statement: ts.Statement): string[] | null {
  if (ts.isReturnStatement(statement) && statement.expression) {
    return getThisPropertyCallPath(statement.expression);
  }
  if (ts.isExpressionStatement(statement)) {
    return getThisPropertyCallPath(statement.expression);
  }
  return null;
}

function isReturnOrThrow(statement: ts.Statement): boolean {
  return ts.isReturnStatement(statement) || ts.isThrowStatement(statement);
}

function getGuardedServiceField(statement: ts.Statement): string | null {
  if (!ts.isIfStatement(statement) || statement.elseStatement) {
    return null;
  }

  const condition = statement.expression;
  if (
    !ts.isPrefixUnaryExpression(condition) ||
    condition.operator !== ts.SyntaxKind.ExclamationToken ||
    !ts.isPropertyAccessExpression(condition.operand) ||
    !ts.isThis(condition.operand.expression)
  ) {
    return null;
  }

  const thenStatement = statement.thenStatement;
  const exits =
    isReturnOrThrow(thenStatement) ||
    (ts.isBlock(thenStatement) &&
      thenStatement.statements.length > 0 &&
      isReturnOrThrow(thenStatement.statements[thenStatement.statements.length - 1]));

  return exits ? condition.operand.name.text : null;
}

function detectPureProxyMethods(): PureProxyMethod[] {
  const sourceText = readFileSync(SERVICE_PATH, 'utf8');
  const sourceFile = ts.createSourceFile(
    SERVICE_PATH,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const proxies: PureProxyMethod[] = [];

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name?.text === 'DuckDBService') {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name)) {
          continue;
        }

        const statements = [...member.body.statements];
        let guardField: string | null = null;
        let delegatePath: string[] | null = null;

        if (statements.length === 1) {
          delegatePath = getDelegateCallPath(statements[0]);
        } else if (statements.length === 2) {
          guardField = getGuardedServiceField(statements[0]);
          delegatePath = getDelegateCallPath(statements[1]);
        }

        if (!delegatePath || delegatePath.length < 2) {
          continue;
        }

        const methodName = member.name.text;
        const targetService = delegatePath[0];
        const targetMethod = delegatePath[delegatePath.length - 1];
        const sameGuard = !guardField || guardField === targetService;

        if (sameGuard && targetMethod === methodName) {
          const position = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile));
          proxies.push({
            name: methodName,
            target: delegatePath.join('.'),
            line: position.line + 1,
          });
        }
      }
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return proxies;
}

function buildAllowedProxyMigrationNotes(): Map<string, string> {
  const notes = new Map<string, string>();
  const duplicates: string[] = [];

  for (const group of LEGACY_PROXY_GROUPS) {
    for (const method of group.methods) {
      if (notes.has(method)) {
        duplicates.push(method);
      }
      notes.set(method, group.migration);
    }
  }

  expect(duplicates).toEqual([]);
  for (const [method, note] of notes) {
    expect(note.trim(), method).not.toBe('');
  }

  return notes;
}

describe('DuckDBService facade contract', () => {
  it('requires migration notes for any pure facade proxy kept on DuckDBService', () => {
    const allowed = buildAllowedProxyMigrationNotes();
    const pureProxyMethods = detectPureProxyMethods();
    const undocumented = pureProxyMethods.filter((method) => !allowed.has(method.name));

    expect(
      undocumented.map(
        (method) => `${method.name} -> ${method.target} (${SERVICE_PATH}:${method.line})`
      )
    ).toEqual([]);
  });

  it('keeps explicit sub-service accessors as the migration path for new main-process callers', () => {
    const sourceText = readFileSync(SERVICE_PATH, 'utf8');
    const sourceFile = ts.createSourceFile(
      SERVICE_PATH,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const methodNames = new Set<string>();

    function visit(node: ts.Node): void {
      if (ts.isClassDeclaration(node) && node.name?.text === 'DuckDBService') {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
            methodNames.add(member.name.text);
          }
        }
        return;
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    expect([...methodNames]).toEqual(
      expect.arrayContaining([
        'getDatasetService',
        'getFolderService',
        'getScheduledTaskService',
        'getProfileService',
        'getProfileGroupService',
        'getAccountService',
        'getSavedSiteService',
        'getTagService',
        'getExtensionPackagesService',
        'getSyncOutboxService',
        'getSyncMetadataService',
        'getRuntimeObservationService',
        'getConnection',
      ])
    );
  });
});
