/**
 * QueryEngine 使用示例
 * 演示各种查询场景
 */

import type { QueryConfig } from './types';

/**
 * 示例1：基础筛选和排序
 */
export const example1_BasicFilter: QueryConfig = {
  filter: {
    conditions: [
      { type: 'equal', field: 'status', value: 'active' },
      { type: 'greater_than', field: 'age', value: 18 },
    ],
    combinator: 'AND',
  },
  sort: {
    columns: [{ field: 'created_at', direction: 'DESC' }],
    topK: 100,
  },
};

/**
 * 示例2：正则筛选（带安全限制）
 */
export const example2_RegexFilter: QueryConfig = {
  filter: {
    conditions: [
      {
        type: 'regex',
        field: 'email',
        value: '^[a-zA-Z0-9._%+-]+@company\\.com$',
        options: {
          regexMaxLength: 1000, // 最大匹配长度
          regexTimeout: 5000, // 超时时间（毫秒）
        },
      },
    ],
  },
};

/**
 * 示例3：软删除显示设置（视图级配置）
 */
export const example3_SoftDelete: QueryConfig = {
  softDelete: {
    field: 'deleted_at', // 软删除字段名
    show: 'active', // 显示模式: 'active' | 'deleted' | 'all'
  },
};

/**
 * 示例4：相对时间筛选
 */
export const example4_RelativeTime: QueryConfig = {
  filter: {
    conditions: [
      {
        type: 'relative_time',
        field: 'created_at',
        options: {
          relativeTimeUnit: 'day',
          relativeTimeValue: 7,
          relativeTimeDirection: 'past', // 过去7天
        },
      },
    ],
  },
};

/**
 * 示例5：数据清洗（链式操作）
 */
export const example5_DataCleaning: QueryConfig = {
  clean: [
    {
      field: 'name',
      operations: [
        { type: 'trim' }, // 去除空格
        { type: 'upper' }, // 转大写
      ],
    },
    {
      field: 'phone',
      operations: [
        { type: 'trim' },
        {
          type: 'regex_replace', // 只保留数字
          params: {
            pattern: '[^0-9]',
            replacement: '',
          },
        },
      ],
    },
  ],
};

/**
 * 示例6：计算列 - 订单金额
 */
export const example6_AmountCalculation: QueryConfig = {
  compute: [
    {
      name: 'total_amount',
      type: 'amount',
      params: {
        priceField: 'unit_price',
        quantityField: 'quantity',
      },
    },
    {
      name: 'discounted_amount',
      type: 'custom',
      expression: 'total_amount * 0.9', // 9折
    },
  ],
};

/**
 * 示例7：分桶分析 - 年龄段
 */
export const example7_AgeBucketing: QueryConfig = {
  compute: [
    {
      name: 'age_group',
      type: 'bucket',
      params: {
        field: 'age',
        boundaries: [18, 30, 50, 65],
        labels: ['未成年', '青年', '中年', '中老年', '老年'],
      },
    },
  ],
};

/**
 * 示例8：去重 - 每个用户只保留最新记录
 */
export const example8_Deduplication: QueryConfig = {
  dedupe: {
    type: 'row_number',
    partitionBy: ['user_id'],
    orderBy: [{ field: 'created_at', direction: 'DESC' }],
    keepStrategy: 'last', // 保留最后一条
  },
};

/**
 * 示例9：去重 - 按邮箱保留第一条记录
 */
export const example9_DeduplicateByEmail: QueryConfig = {
  dedupe: {
    type: 'row_number',
    partitionBy: ['email'],
    keepStrategy: 'first',
  },
};

/**
 * 示例10：数据验证 - 过滤无效数据
 */
export const example10_DataValidation: QueryConfig = {
  validation: [
    {
      field: 'email',
      rules: [
        {
          type: 'is_email',
          action: 'filter',
        },
      ],
    },
    {
      field: 'age',
      rules: [
        {
          type: 'range',
          params: { min: 0, max: 120 },
          action: 'filter',
        },
      ],
    },
  ],
};

/**
 * 示例11：数据验证 - 标记无效数据
 */
export const example11_ValidationMarking: QueryConfig = {
  validation: [
    {
      field: 'phone',
      rules: [
        {
          type: 'regex',
          params: { pattern: '^1[3-9]\\d{9}$' },
          action: 'mark',
          markColumn: 'phone_valid',
        },
      ],
    },
  ],
};

/**
 * 示例12：Lookup - 关联维表
 */
export const example12_LookupJoin: QueryConfig = {
  lookup: [
    {
      type: 'join',
      lookupDatasetId: 'user_profiles',
      joinKey: 'user_id',
      lookupKey: 'id',
      selectColumns: ['nickname', 'avatar', 'vip_level'],
      leftJoin: true,
    },
  ],
};

/**
 * 示例13：码值映射
 */
export const example13_CodeMapping: QueryConfig = {
  lookup: [
    {
      type: 'map',
      joinKey: 'status_code',
      lookupKey: 'status_name',
      codeMapping: {
        '0': '待处理',
        '1': '处理中',
        '2': '已完成',
        '9': '已取消',
      },
    },
  ],
};

/**
 * 示例14：词库匹配 - 敏感词过滤 (已废弃，现在使用 filter 配置)
 * 新的用法请参考 filter 中的 contains_multi/excludes_multi + inputMode: 'dictionary'
 */
// export const example14_DictionaryMatch: QueryConfig = {
//   dictionary: [
//     {
//       field: 'content',
//       dictionaryWords: ['违禁词1', '违禁词2', '违禁词3'],
//       matchType: 'contains',
//       outputColumn: 'contains_sensitive_word'
//     }
//   ]
// };

/**
 * 示例15：完整数据清洗流程
 */
export const example15_CompleteCleaning: QueryConfig = {
  // 0. 软删除设置：只显示活跃用户
  softDelete: {
    field: 'deleted_at',
    show: 'active',
  },

  // 1. 筛选：最近30天的活跃用户
  filter: {
    conditions: [
      {
        type: 'relative_time',
        field: 'last_login_at',
        options: {
          relativeTimeUnit: 'day',
          relativeTimeValue: 30,
          relativeTimeDirection: 'past',
        },
      },
    ],
    combinator: 'AND',
  },

  // 2. 清洗：邮箱和手机号
  clean: [
    {
      field: 'email',
      operations: [{ type: 'trim' }, { type: 'lower' }],
    },
    {
      field: 'phone',
      operations: [
        { type: 'trim' },
        {
          type: 'regex_replace',
          params: { pattern: '[^0-9]', replacement: '' },
        },
      ],
    },
  ],

  // 3. 计算：用户年龄段
  compute: [
    {
      name: 'age_group',
      type: 'bucket',
      params: {
        field: 'age',
        boundaries: [18, 30, 50],
        labels: ['青年', '中年', '中老年', '老年'],
      },
    },
  ],

  // 4. 去重：每个邮箱只保留一条
  dedupe: {
    type: 'row_number',
    partitionBy: ['email'],
    orderBy: [{ field: 'last_login_at', direction: 'DESC' }],
    keepStrategy: 'last',
  },

  // 5. 验证：过滤无效数据
  validation: [
    {
      field: 'email',
      rules: [{ type: 'is_email', action: 'filter' }],
    },
    {
      field: 'phone',
      rules: [
        {
          type: 'length',
          params: { minLength: 11, maxLength: 11 },
          action: 'filter',
        },
      ],
    },
  ],

  // 6. 选列
  columns: {
    select: ['id', 'email', 'phone', 'age', 'age_group', 'last_login_at'],
    hide: ['internal_notes', 'password_hash'],
  },

  // 7. 排序和分页
  sort: {
    columns: [{ field: 'last_login_at', direction: 'DESC' }],
    pagination: {
      page: 1,
      pageSize: 100,
    },
  },
};

/**
 * 示例16：销售数据分析
 */
export const example16_SalesAnalysis: QueryConfig = {
  // 1. 筛选：本月订单
  filter: {
    conditions: [
      {
        type: 'relative_time',
        field: 'order_date',
        options: {
          relativeTimeUnit: 'month',
          relativeTimeValue: 1,
          relativeTimeDirection: 'past',
        },
      },
      {
        type: 'in',
        field: 'order_status',
        values: ['completed', 'shipped'],
      },
    ],
    combinator: 'AND',
  },

  // 2. 计算：总金额、折扣率、客户等级
  compute: [
    {
      name: 'total_amount',
      type: 'amount',
      params: {
        priceField: 'unit_price',
        quantityField: 'quantity',
      },
    },
    {
      name: 'discount_rate',
      type: 'discount',
      params: {
        originalPriceField: 'original_price',
        discountedPriceField: 'sale_price',
        discountType: 'percentage',
      },
    },
    {
      name: 'customer_tier',
      type: 'bucket',
      params: {
        field: 'total_amount',
        boundaries: [1000, 5000, 10000],
        labels: ['普通', '银牌', '金牌', '钻石'],
      },
    },
  ],

  // 3. 关联客户信息
  lookup: [
    {
      type: 'join',
      lookupDatasetId: 'customers',
      joinKey: 'customer_id',
      lookupKey: 'id',
      selectColumns: ['customer_name', 'region'],
      leftJoin: false,
    },
  ],

  // 4. 排序：按金额降序
  sort: {
    columns: [{ field: 'total_amount', direction: 'DESC' }],
    topK: 100,
  },
};

/**
 * 示例17：用户行为分析
 */
export const example17_UserBehavior: QueryConfig = {
  filter: {
    conditions: [
      {
        type: 'relative_time',
        field: 'event_time',
        options: {
          relativeTimeUnit: 'week',
          relativeTimeValue: 1,
          relativeTimeDirection: 'past',
        },
      },
    ],
  },

  compute: [
    {
      name: 'user_activity',
      type: 'custom',
      expression: `
        CASE
          WHEN event_count > 100 THEN '高活跃'
          WHEN event_count > 50 THEN '中活跃'
          WHEN event_count > 10 THEN '低活跃'
          ELSE '不活跃'
        END
      `,
    },
  ],

  dedupe: {
    type: 'row_number',
    partitionBy: ['user_id', 'event_type'],
    keepStrategy: 'first',
  },
};

/**
 * 示例18：数据质量检查
 */
export const example18_DataQualityCheck: QueryConfig = {
  validation: [
    {
      field: 'email',
      rules: [{ type: 'is_email', action: 'mark', markColumn: 'email_valid' }],
    },
    {
      field: 'phone',
      rules: [
        {
          type: 'regex',
          params: { pattern: '^1[3-9]\\d{9}$' },
          action: 'mark',
          markColumn: 'phone_valid',
        },
      ],
    },
    {
      field: 'age',
      rules: [
        {
          type: 'range',
          params: { min: 0, max: 120 },
          action: 'mark',
          markColumn: 'age_valid',
        },
      ],
    },
    {
      field: 'id_card',
      rules: [
        {
          type: 'length',
          params: { minLength: 18, maxLength: 18 },
          action: 'mark',
          markColumn: 'id_card_valid',
        },
      ],
    },
  ],

  // 过滤掉所有字段都无效的记录
  filter: {
    conditions: [
      {
        type: 'custom',
        field: '(email_valid OR phone_valid)',
        value: true,
      },
    ],
  } as any,
};
