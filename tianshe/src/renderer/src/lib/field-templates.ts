/**
 * 字段模板系统
 * 提供常用字段的预设配置
 */

import type { ValidationRule } from '../../../types/validation';

export interface FieldTemplate {
  id: string;
  name: string;
  icon: string;
  category: 'contact' | 'meta' | 'common' | 'business' | 'tech';
  description: string;
  config: {
    columnName: string;
    fieldType: string;
    nullable: boolean;
    metadata?: any;
    validationRules?: ValidationRule[];
  };
}

/**
 * 预定义的字段模板
 */
export const FIELD_TEMPLATES: FieldTemplate[] = [
  // 联系方式类
  {
    id: 'email',
    name: 'Email地址',
    icon: '📧',
    category: 'contact',
    description: '电子邮件地址，带格式验证',
    config: {
      columnName: 'email',
      fieldType: 'email',
      nullable: true,
      validationRules: [
        {
          type: 'email',
          message: '请输入有效的Email地址',
        },
      ],
    },
  },
  {
    id: 'phone',
    name: '手机号码',
    icon: '📱',
    category: 'contact',
    description: '11位中国大陆手机号',
    config: {
      columnName: 'phone',
      fieldType: 'phone',
      nullable: true,
      validationRules: [
        {
          type: 'pattern',
          value: '^1[3-9]\\d{9}$',
          message: '请输入有效的11位手机号',
        },
      ],
    },
  },
  {
    id: 'wechat',
    name: '微信号',
    icon: '💬',
    category: 'contact',
    description: '微信账号',
    config: {
      columnName: 'wechat',
      fieldType: 'text',
      nullable: true,
      metadata: {
        description: '微信账号',
      },
      validationRules: [
        {
          type: 'minLength',
          value: 1,
          message: '长度不能少于1个字符',
        },
        {
          type: 'maxLength',
          value: 20,
          message: '长度不能超过20个字符',
        },
      ],
    },
  },
  {
    id: 'website',
    name: '网站URL',
    icon: '🌐',
    category: 'contact',
    description: '网站地址',
    config: {
      columnName: 'website',
      fieldType: 'url',
      nullable: true,
      validationRules: [
        {
          type: 'url',
          message: '请输入有效的URL',
        },
      ],
    },
  },

  // 元数据类
  {
    id: 'created_at',
    name: '创建时间',
    icon: '🕐',
    category: 'meta',
    description: '记录创建的时间戳',
    config: {
      columnName: 'created_at',
      fieldType: 'date',
      nullable: false,
      metadata: {
        includeTime: true,
        defaultValue: { type: 'dynamic', expression: 'CURRENT_TIMESTAMP' },
      },
    },
  },
  {
    id: 'updated_at',
    name: '更新时间',
    icon: '🔄',
    category: 'meta',
    description: '记录最后更新的时间',
    config: {
      columnName: 'updated_at',
      fieldType: 'date',
      nullable: false,
      metadata: {
        includeTime: true,
        defaultValue: { type: 'dynamic', expression: 'CURRENT_TIMESTAMP' },
      },
    },
  },
  {
    id: 'id',
    name: '自增ID',
    icon: '🔢',
    category: 'meta',
    description: '自动递增的唯一标识符',
    config: {
      columnName: 'id',
      fieldType: 'auto_increment',
      nullable: false,
      validationRules: [
        {
          type: 'unique',
        },
      ],
    },
  },
  {
    id: 'uuid',
    name: 'UUID',
    icon: '🆔',
    category: 'meta',
    description: '全局唯一标识符',
    config: {
      columnName: 'uuid',
      fieldType: 'uuid',
      nullable: false,
      metadata: {
        defaultValue: { type: 'dynamic', expression: 'gen_random_uuid()' },
      },
      validationRules: [
        {
          type: 'unique',
        },
      ],
    },
  },

  // 常用字段类
  {
    id: 'status',
    name: '状态',
    icon: '🔘',
    category: 'common',
    description: '通用状态字段',
    config: {
      columnName: 'status',
      fieldType: 'single_select',
      nullable: false,
      metadata: {
        options: ['待处理', '进行中', '已完成', '已取消'],
        defaultValue: '待处理',
        colorMap: {
          待处理: 'gray',
          进行中: 'blue',
          已完成: 'green',
          已取消: 'red',
        },
      },
    },
  },
  {
    id: 'priority',
    name: '优先级',
    icon: '⭐',
    category: 'common',
    description: '任务优先级',
    config: {
      columnName: 'priority',
      fieldType: 'single_select',
      nullable: false,
      metadata: {
        options: ['低', '中', '高', '紧急'],
        defaultValue: '中',
        colorMap: {
          低: 'gray',
          中: 'blue',
          高: 'orange',
          紧急: 'red',
        },
      },
    },
  },
  {
    id: 'is_active',
    name: '是否启用',
    icon: '✓',
    category: 'common',
    description: '启用/禁用开关',
    config: {
      columnName: 'is_active',
      fieldType: 'boolean',
      nullable: false,
      metadata: {
        defaultValue: true,
      },
    },
  },
  {
    id: 'tags',
    name: '标签',
    icon: '🏷️',
    category: 'common',
    description: '多个标签',
    config: {
      columnName: 'tags',
      fieldType: 'multi_select',
      nullable: true,
      metadata: {
        options: [],
        separator: ',',
      },
    },
  },
  {
    id: 'remarks',
    name: '备注',
    icon: '📝',
    category: 'common',
    description: '备注说明',
    config: {
      columnName: 'remarks',
      fieldType: 'text',
      nullable: true,
      metadata: {
        description: '备注说明',
      },
    },
  },

  // 业务字段类
  {
    id: 'amount',
    name: '金额',
    icon: '💰',
    category: 'business',
    description: '货币金额',
    config: {
      columnName: 'amount',
      fieldType: 'number',
      nullable: true,
      metadata: {
        format: 'currency',
        precision: 2,
      },
      validationRules: [
        {
          type: 'min',
          value: 0,
          message: '金额不能为负数',
        },
      ],
    },
  },
  {
    id: 'quantity',
    name: '数量',
    icon: '📦',
    category: 'business',
    description: '商品数量',
    config: {
      columnName: 'quantity',
      fieldType: 'number',
      nullable: false,
      metadata: {
        format: 'integer',
        defaultValue: 1,
      },
      validationRules: [
        {
          type: 'min',
          value: 0,
          message: '数量必须大于等于0',
        },
      ],
    },
  },
  {
    id: 'percentage',
    name: '百分比',
    icon: '%',
    category: 'business',
    description: '百分比数值',
    config: {
      columnName: 'percentage',
      fieldType: 'number',
      nullable: true,
      metadata: {
        format: 'percentage',
        precision: 2,
      },
      validationRules: [
        {
          type: 'min',
          value: 0,
          message: '百分比不能小于0',
        },
        {
          type: 'max',
          value: 100,
          message: '百分比不能大于100',
        },
      ],
    },
  },
  {
    id: 'order_no',
    name: '订单号',
    icon: '🧾',
    category: 'business',
    description: '订单编号',
    config: {
      columnName: 'order_no',
      fieldType: 'text',
      nullable: false,
      validationRules: [
        {
          type: 'unique',
          message: '订单号必须唯一',
        },
        {
          type: 'minLength',
          value: 1,
          message: '长度不能少于1个字符',
        },
        {
          type: 'maxLength',
          value: 50,
          message: '长度不能超过50个字符',
        },
      ],
    },
  },

  // 技术字段类
  {
    id: 'ip_address',
    name: 'IP地址',
    icon: '🌐',
    category: 'tech',
    description: 'IPv4或IPv6地址',
    config: {
      columnName: 'ip_address',
      fieldType: 'ip_address',
      nullable: true,
    },
  },
  {
    id: 'json_data',
    name: 'JSON数据',
    icon: '{}',
    category: 'tech',
    description: 'JSON格式的数据',
    config: {
      columnName: 'json_data',
      fieldType: 'json',
      nullable: true,
      metadata: {
        defaultValue: '{}',
      },
    },
  },
  {
    id: 'version',
    name: '版本号',
    icon: '🔖',
    category: 'tech',
    description: '软件版本号',
    config: {
      columnName: 'version',
      fieldType: 'text',
      nullable: false,
      metadata: {
        defaultValue: '1.0.0',
      },
      validationRules: [
        {
          type: 'pattern',
          value: '^\\d+\\.\\d+\\.\\d+$',
          message: '版本号格式应为 x.y.z',
        },
      ],
    },
  },
];

/**
 * 按分类分组模板
 */
export function getTemplatesByCategory(): Record<string, FieldTemplate[]> {
  const grouped: Record<string, FieldTemplate[]> = {
    contact: [],
    meta: [],
    common: [],
    business: [],
    tech: [],
  };

  for (const template of FIELD_TEMPLATES) {
    grouped[template.category].push(template);
  }

  return grouped;
}

/**
 * 根据ID获取模板
 */
export function getTemplateById(id: string): FieldTemplate | undefined {
  return FIELD_TEMPLATES.find((t) => t.id === id);
}

/**
 * 搜索模板
 */
export function searchTemplates(query: string): FieldTemplate[] {
  const lowerQuery = query.toLowerCase();
  return FIELD_TEMPLATES.filter(
    (t) =>
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery) ||
      t.config.columnName.toLowerCase().includes(lowerQuery)
  );
}

/**
 * 根据列名推荐模板
 */
export function suggestTemplateByColumnName(columnName: string): FieldTemplate | null {
  const name = columnName.toLowerCase();

  // 精确匹配
  const exact = FIELD_TEMPLATES.find((t) => t.config.columnName === name);
  if (exact) return exact;

  // 模糊匹配
  if (/(email|邮箱|mail)/.test(name)) {
    return getTemplateById('email')!;
  }
  if (/(phone|mobile|tel|电话|手机)/.test(name)) {
    return getTemplateById('phone')!;
  }
  if (/(created|create_time|创建时间)/.test(name)) {
    return getTemplateById('created_at')!;
  }
  if (/(updated|update_time|更新时间)/.test(name)) {
    return getTemplateById('updated_at')!;
  }
  if (/(status|状态)/.test(name)) {
    return getTemplateById('status')!;
  }
  if (/(amount|price|金额|价格)/.test(name)) {
    return getTemplateById('amount')!;
  }
  if (/(quantity|num|count|数量)/.test(name)) {
    return getTemplateById('quantity')!;
  }
  if (/(url|website|网址|网站)/.test(name)) {
    return getTemplateById('website')!;
  }
  if (/(uuid|guid)/.test(name)) {
    return getTemplateById('uuid')!;
  }

  return null;
}
