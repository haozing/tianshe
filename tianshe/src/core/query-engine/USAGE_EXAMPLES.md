# QueryEngine 使用示例

本文档提供 QueryEngine 的完整使用示例，帮助开发者快速上手。

## 目录

- [基础用法](#基础用法)
- [筛选功能](#筛选功能)
- [数据清洗](#数据清洗)
- [聚合分析](#聚合分析)
- [数据关联](#数据关联)
- [预览功能](#预览功能)
- [高级用法](#高级用法)

---

## 基础用法

### 1. 初始化 QueryEngine

```typescript
import { QueryEngine } from './core/query-engine';
import { DuckDBService } from './main/duckdb/service';

// 初始化 DuckDB 服务
const duckdbService = new DuckDBService();
await duckdbService.initialize();

// 创建 QueryEngine 实例
const queryEngine = new QueryEngine(duckdbService);
```

### 2. 简单查询

```typescript
import type { QueryConfig } from './core/query-engine/types';

// 配置查询
const config: QueryConfig = {
  columns: {
    select: ['name', 'age', 'email']
  },
  sort: {
    columns: [{ field: 'age', direction: 'DESC' }],
    pagination: { page: 1, pageSize: 10 }
  }
};

// 执行查询
const result = await queryEngine.execute('users', config);

if (result.success) {
  console.log('查询成功');
  console.log('行数:', result.rowCount);
  console.log('数据:', result.rows);
  console.log('生成的 SQL:', result.generatedSQL);
} else {
  console.error('查询失败:', result.error);
}
```

### 3. 仅生成 SQL（不执行）

```typescript
const sql = await queryEngine.buildSQL('users', config);
console.log('生成的 SQL:', sql);
```

---

## 筛选功能

### 单条件筛选

```typescript
const config: QueryConfig = {
  filter: {
    combinator: 'and',
    conditions: [
      {
        field: 'age',
        type: 'greater_than',
        value: 25
      }
    ]
  }
};

// WHERE age > 25
```

### 多条件筛选 (AND)

```typescript
const config: QueryConfig = {
  filter: {
    combinator: 'and',
    conditions: [
      {
        field: 'age',
        type: 'greater_than',
        value: 25
      },
      {
        field: 'city',
        type: 'equal',
        value: '北京'
      }
    ]
  }
};

// WHERE age > 25 AND city = '北京'
```

### 多条件筛选 (OR)

```typescript
const config: QueryConfig = {
  filter: {
    combinator: 'or',
    conditions: [
      {
        field: 'city',
        type: 'equal',
        value: '北京'
      },
      {
        field: 'city',
        type: 'equal',
        value: '上海'
      }
    ]
  }
};

// WHERE city = '北京' OR city = '上海'
```

### 范围筛选

```typescript
const config: QueryConfig = {
  filter: {
    combinator: 'and',
    conditions: [
      {
        field: 'age',
        type: 'between',
        value: 25,
        value2: 35
      }
    ]
  }
};

// WHERE age BETWEEN 25 AND 35
```

### IN 筛选

```typescript
const config: QueryConfig = {
  filter: {
    combinator: 'and',
    conditions: [
      {
        field: 'city',
        type: 'in',
        values: ['北京', '上海', '深圳']
      }
    ]
  }
};

// WHERE city IN ('北京', '上海', '深圳')
```

### 字符串模糊匹配

```typescript
const config: QueryConfig = {
  filter: {
    combinator: 'and',
    conditions: [
      {
        field: 'name',
        type: 'contains',
        value: '张'
      }
    ]
  }
};

// WHERE name LIKE '%张%'
```

### 正则表达式筛选

```typescript
const config: QueryConfig = {
  filter: {
    combinator: 'and',
    conditions: [
      {
        field: 'email',
        type: 'regex',
        value: '^[a-z]+@test\\.com$'
      }
    ]
  }
};

// WHERE REGEXP_MATCHES(email, '^[a-z]+@test\.com$')
```

### 空值检查

```typescript
const config: QueryConfig = {
  filter: {
    combinator: 'and',
    conditions: [
      {
        field: 'email',
        type: 'not_null'
      }
    ]
  }
};

// WHERE email IS NOT NULL
```

### 词库筛选（Aho-Corasick 优化）

```typescript
// 1. 白名单模式：只保留包含词库词汇的记录
const config: QueryConfig = {
  filter: {
    combinator: 'and',
    conditions: [
      {
        field: 'content',
        type: 'contains_multi',
        inputMode: 'dictionary',
        options: {
          dictionaryDatasetId: 'keywords',
          dictionaryField: 'word'
        }
      }
    ]
  }
};

// 2. 黑名单模式：排除包含敏感词的记录
const config: QueryConfig = {
  filter: {
    combinator: 'and',
    conditions: [
      {
        field: 'content',
        type: 'excludes_multi',
        inputMode: 'dictionary',
        options: {
          dictionaryDatasetId: 'sensitive_words',
          dictionaryField: 'word'
        }
      }
    ]
  }
};

// 性能提升：100-300 倍速度提升（相比 LIKE ANY）
```

---

## 数据清洗

### 字符串清洗

```typescript
const config: QueryConfig = {
  clean: [
    {
      field: 'email',
      operations: [
        { type: 'trim' },          // 去除首尾空格
        { type: 'lowercase' }      // 转小写
      ]
    }
  ]
};
```

### 多字段清洗

```typescript
const config: QueryConfig = {
  clean: [
    {
      field: 'name',
      operations: [
        { type: 'trim' },
        { type: 'uppercase' }
      ]
    },
    {
      field: 'email',
      operations: [
        { type: 'trim' },
        { type: 'lowercase' }
      ]
    },
    {
      field: 'phone',
      operations: [
        { type: 'remove_non_numeric' }
      ]
    }
  ]
};
```

### 空值填充

```typescript
const config: QueryConfig = {
  clean: [
    {
      field: 'city',
      operations: [
        {
          type: 'fill_null',
          fillValue: '未知'
        }
      ]
    }
  ]
};
```

### 输出到新列

```typescript
const config: QueryConfig = {
  clean: [
    {
      field: 'email',
      outputField: 'clean_email',  // 保留原字段
      operations: [
        { type: 'trim' },
        { type: 'lowercase' }
      ]
    }
  ]
};
```

### 预览清洗效果

```typescript
const result = await queryEngine.preview.previewClean(
  'users',
  [
    {
      field: 'email',
      operations: [{ type: 'trim' }, { type: 'lowercase' }]
    }
  ],
  {
    limit: 10,
    offset: 0
  }
);

console.log('原始数据:', result.originalData);
console.log('清洗后数据:', result.cleanedData);
console.log('变更统计:', result.stats);
console.log('总变更:', result.stats.totalChanges);
console.log('受影响行数:', result.stats.changedRows);
```

---

## 聚合分析

### 基础分组聚合

```typescript
const config: QueryConfig = {
  aggregate: {
    groupBy: ['city'],
    measures: [
      {
        field: 'age',
        aggregation: 'avg',
        alias: 'avg_age'
      },
      {
        aggregation: 'count',
        alias: 'user_count'
      }
    ]
  }
};

// SELECT city, AVG(age) AS avg_age, COUNT(*) AS user_count
// FROM users
// GROUP BY city
```

### 多字段分组

```typescript
const config: QueryConfig = {
  aggregate: {
    groupBy: ['city', 'gender'],
    measures: [
      {
        field: 'salary',
        aggregation: 'sum',
        alias: 'total_salary'
      },
      {
        field: 'salary',
        aggregation: 'avg',
        alias: 'avg_salary'
      },
      {
        aggregation: 'count',
        alias: 'count'
      }
    ]
  }
};
```

### 多种聚合函数

```typescript
const config: QueryConfig = {
  aggregate: {
    groupBy: ['department'],
    measures: [
      { field: 'salary', aggregation: 'sum', alias: 'total_salary' },
      { field: 'salary', aggregation: 'avg', alias: 'avg_salary' },
      { field: 'salary', aggregation: 'max', alias: 'max_salary' },
      { field: 'salary', aggregation: 'min', alias: 'min_salary' },
      { aggregation: 'count', alias: 'emp_count' }
    ]
  },
  sort: {
    columns: [{ field: 'total_salary', direction: 'DESC' }]
  }
};
```

### 预览聚合结果

```typescript
const result = await queryEngine.preview.previewAggregate(
  'users',
  {
    groupBy: ['city'],
    measures: [
      { aggregation: 'count', alias: 'count' }
    ]
  },
  { limit: 5 }
);

console.log('分组数量:', result.estimatedRows);
console.log('降维比例:', result.reductionRatio);
console.log('样本数据:', result.sampleRows);
console.log('统计信息:', result.stats);
```

---

## 数据关联

### 基础 JOIN

```typescript
const config: QueryConfig = {
  lookup: [
    {
      type: 'join',
      lookupDatasetId: 'departments',
      leftKey: 'dept_id',
      lookupKey: 'id',
      selectFields: ['dept_name', 'location']
    }
  ]
};

// 自动使用 LEFT JOIN 保留主表所有数据
```

### MAP 类型关联（字典映射）

```typescript
const config: QueryConfig = {
  lookup: [
    {
      type: 'map',
      lookupDatasetId: 'code_table',
      leftKey: 'status_code',
      lookupKey: 'code',
      codeMapping: {
        sourceField: 'code',
        targetField: 'name'
      },
      alias: 'status_name'
    }
  ]
};

// 将状态码映射为状态名称
```

### 预览关联效果

```typescript
const result = await queryEngine.preview.previewLookup(
  'users',
  {
    type: 'join',
    lookupDatasetId: 'departments',
    leftKey: 'dept_id',
    lookupKey: 'id',
    selectFields: ['dept_name']
  },
  { limit: 5 }
);

console.log('匹配统计:', result.stats);
console.log('匹配率:', result.stats.matchRate);
console.log('未匹配行数:', result.stats.unmatchedRows);
console.log('匹配样本:', result.sampleMatched);
console.log('未匹配样本:', result.sampleUnmatched);
```

---

## 预览功能

### 1. 预览筛选结果

```typescript
const result = await queryEngine.previewFilterCount(
  'users',
  {
    combinator: 'and',
    conditions: [
      { field: 'age', type: 'greater_than', value: 25 }
    ]
  }
);

console.log('总行数:', result.totalRows);
console.log('匹配行数:', result.matchedRows);
console.log('过滤行数:', result.filteredRows);
console.log('匹配率:', result.matchRate);
```

### 2. 预览去重效果

```typescript
const result = await queryEngine.preview.previewDedupe(
  'users',
  {
    type: 'row_number',
    partitionBy: ['email'],
    orderBy: [{ field: 'created_at', direction: 'DESC' }]
  },
  {
    sampleSize: 100,
    limitStats: 10
  }
);

console.log('总行数:', result.stats.totalRows);
console.log('唯一行数:', result.stats.uniqueRows);
console.log('重复行数:', result.stats.duplicateRows);
console.log('将保留:', result.stats.willBeKept);
console.log('将删除:', result.stats.willBeRemoved);
console.log('保留样本:', result.sampleKept);
console.log('删除样本:', result.sampleRemoved);
```

### 3. 预览采样结果

```typescript
const result = await queryEngine.preview.previewSample(
  'users',
  {
    type: 'percentage',
    value: 10,  // 10% 采样
    seed: 42    // 固定随机种子
  }
);

console.log('采样行数:', result.sampleSize);
console.log('采样比例:', result.samplingRatio);
```

### 4. 验证计算表达式

```typescript
const result = await queryEngine.preview.validateComputeExpression(
  'users',
  'age * 2 + 10',
  { limit: 3 }
);

if (result.valid) {
  console.log('表达式有效');
  console.log('预览值:', result.previewValues);
  console.log('数据类型:', result.stats.dataType);
  console.log('空值数量:', result.stats.nullCount);
} else {
  console.error('表达式无效:', result.error);
}
```

---

## 高级用法

### 1. 复杂查询组合

```typescript
const config: QueryConfig = {
  // 1. 先采样（减少数据量）
  sample: {
    type: 'percentage',
    value: 50,
    seed: 42
  },

  // 2. 筛选数据
  filter: {
    combinator: 'and',
    conditions: [
      { field: 'age', type: 'greater_than', value: 20 },
      { field: 'status', type: 'equal', value: 'active' }
    ]
  },

  // 3. 数据清洗
  clean: [
    {
      field: 'email',
      operations: [{ type: 'trim' }, { type: 'lowercase' }]
    }
  ],

  // 4. 关联数据
  lookup: [
    {
      type: 'join',
      lookupDatasetId: 'departments',
      leftKey: 'dept_id',
      lookupKey: 'id',
      selectFields: ['dept_name']
    }
  ],

  // 5. 聚合分析
  aggregate: {
    groupBy: ['dept_name', 'city'],
    measures: [
      { field: 'salary', aggregation: 'avg', alias: 'avg_salary' },
      { aggregation: 'count', alias: 'emp_count' }
    ]
  },

  // 6. 排序和分页
  sort: {
    columns: [
      { field: 'avg_salary', direction: 'DESC' }
    ],
    pagination: { page: 1, pageSize: 20 }
  }
};

const result = await queryEngine.execute('users', config);
```

### 2. 错误处理

```typescript
try {
  const result = await queryEngine.execute('users', config);

  if (result.success) {
    console.log('查询成功');
    console.log('数据:', result.rows);

    // 检查是否被截断
    if (result.isTruncated) {
      console.warn('结果已被截断，请添加分页参数');
    }

    // 显示警告信息
    if (result.warnings) {
      result.warnings.forEach(warning => console.warn(warning));
    }
  } else {
    console.error('查询失败:', result.error);
    if (result.errorDetails) {
      console.error('详细信息:', result.errorDetails);
    }
  }
} catch (error) {
  if (error instanceof QueryEngineError) {
    console.error('查询引擎错误:', error.getUserMessage());
    console.error('错误码:', error.code);
    console.error('上下文:', error.context);
  } else {
    console.error('未知错误:', error);
  }
}
```

### 3. 配置验证

```typescript
const validation = await queryEngine.validateConfig('users', config);

if (!validation.success) {
  console.error('配置错误:');
  validation.errors?.forEach(error => console.error('  -', error));
}

if (validation.warnings) {
  console.warn('配置警告:');
  validation.warnings.forEach(warning => console.warn('  -', warning));
}
```

### 4. 缓存管理

```typescript
// 清除特定数据集的缓存
queryEngine.clearColumnCache('users');

// 清除所有缓存
queryEngine.clearColumnCache();
```

### 5. 性能优化建议

```typescript
// ✅ 推荐：先筛选再聚合
const goodConfig: QueryConfig = {
  filter: {  // 1. 先减少数据量
    combinator: 'and',
    conditions: [{ field: 'status', type: 'equal', value: 'active' }]
  },
  aggregate: {  // 2. 再聚合
    groupBy: ['city'],
    measures: [{ aggregation: 'count', alias: 'count' }]
  }
};

// ❌ 不推荐：在大数据集上直接聚合
const badConfig: QueryConfig = {
  aggregate: {
    groupBy: ['city', 'status', 'department'],  // 太多维度
    measures: [{ aggregation: 'count', alias: 'count' }]
  }
};

// ✅ 推荐：使用词库筛选时用 Aho-Corasick
const optimizedConfig: QueryConfig = {
  filter: {
    combinator: 'and',
    conditions: [
      {
        field: 'content',
        type: 'contains_multi',  // 使用 AC 算法
        inputMode: 'dictionary',
        options: {
          dictionaryDatasetId: 'keywords',
          dictionaryField: 'word'
        }
      }
    ]
  }
};
```

---

## 常见问题

### Q1: 如何提高大数据集的查询性能？

**A:**
1. 使用筛选条件减少数据量
2. 避免 SELECT *，只选择需要的列
3. 使用分页避免一次加载过多数据
4. 词库筛选使用 `contains_multi` + `inputMode: 'dictionary'`

### Q2: 如何处理空值？

**A:**
```typescript
// 方法1: 使用筛选排除空值
filter: {
  conditions: [{ field: 'email', type: 'not_null' }]
}

// 方法2: 使用清洗填充空值
clean: [{
  field: 'city',
  operations: [{ type: 'fill_null', fillValue: '未知' }]
}]
```

### Q3: 聚合后为什么不能使用 row_number 去重？

**A:** 聚合操作已经降维，数据结构已改变，再使用 row_number 去重没有意义。如需去重，请在聚合前进行。

### Q4: 如何查看生成的 SQL？

**A:**
```typescript
const result = await queryEngine.execute('users', config);
console.log(result.generatedSQL);
```

---

## 更多资源

- [类型定义](./types.ts)
- [错误处理](./errors.ts)
- [示例代码](./examples.ts)
- [测试用例](./__tests__/QueryEngine.test.ts)
