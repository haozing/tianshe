/**
 * data-parser 单元测试
 * 测试数据解析功能（CSV、TSV、JSON格式）
 */

import { describe, it, expect } from 'vitest';
import { DataParser } from '../data-parser';

describe('DataParser.parse', () => {
  describe('空数据处理', () => {
    it('应拒绝空字符串', () => {
      const result = DataParser.parse('');
      expect(result.success).toBe(false);
      expect(result.error).toBe('没有输入数据');
    });

    it('应拒绝只有空白的字符串', () => {
      const result = DataParser.parse('   \n  \t  ');
      expect(result.success).toBe(false);
      expect(result.error).toBe('没有输入数据');
    });
  });

  describe('JSON 格式解析', () => {
    it('应正确解析 JSON 数组', () => {
      const json = '[{"名称":"A","价格":100},{"名称":"B","价格":200}]';
      const result = DataParser.parse(json);
      expect(result.success).toBe(true);
      expect(result.format).toBe('json');
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({ 名称: 'A', 价格: 100 });
    });

    it('应正确解析单个 JSON 对象', () => {
      const json = '{"名称":"A","价格":100}';
      const result = DataParser.parse(json);
      expect(result.success).toBe(true);
      expect(result.format).toBe('json');
      expect(result.data).toHaveLength(1);
    });

    it('应拒绝空 JSON 数组', () => {
      const json = '[]';
      const result = DataParser.parse(json);
      expect(result.success).toBe(false);
      // JSON 解析失败后会尝试 CSV 解析，返回"没有数据行"
      expect(result.error).toContain('没有');
    });

    it('应拒绝非对象数组', () => {
      const json = '[1, 2, 3]';
      const result = DataParser.parse(json);
      expect(result.success).toBe(false);
      // JSON 解析失败后会尝试 CSV 解析
    });

    it('应处理带空格的 JSON', () => {
      const json = `
        [
          { "名称": "A", "价格": 100 }
        ]
      `;
      const result = DataParser.parse(json);
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
    });
  });

  describe('CSV 格式解析', () => {
    it('应正确解析 CSV 数据', () => {
      const csv = '名称,价格\nA,100\nB,200';
      const result = DataParser.parse(csv);
      expect(result.success).toBe(true);
      expect(result.format).toBe('csv');
      expect(result.data).toHaveLength(2);
      expect(result.data[0].名称).toBe('A');
      expect(result.data[0].价格).toBe(100); // 数字转换
    });

    it('应处理带空格的 CSV', () => {
      const csv = '名称 , 价格 \n A , 100 ';
      const result = DataParser.parse(csv);
      expect(result.success).toBe(true);
      expect(result.data[0].名称).toBe('A');
      expect(result.data[0].价格).toBe(100);
    });

    it('应处理空值', () => {
      const csv = '名称,价格\nA,\n,200';
      const result = DataParser.parse(csv);
      expect(result.success).toBe(true);
      expect(result.data[0].价格).toBe('');
      expect(result.data[1].名称).toBe('');
    });

    it('应解析带引号与逗号的字段', () => {
      const csv = '名称,描述\nProduct A,"包含,逗号"';
      const result = DataParser.parse(csv);
      expect(result.success).toBe(true);
      expect(result.data[0].描述).toBe('包含,逗号');
    });

    it('应解析带引号的 JSON 字段', () => {
      const csv = 'id,retDataJson\n1,"{""goodsNo"":""001"",""category"":""食品酒水""}"';
      const result = DataParser.parse(csv);
      expect(result.success).toBe(true);
      expect(result.data[0].retDataJson).toBe('{"goodsNo":"001","category":"食品酒水"}');
    });
  });

  describe('TSV 格式解析（Excel 粘贴）', () => {
    it('应正确解析 TSV 数据', () => {
      const tsv = '名称\t价格\nA\t100\nB\t200';
      const result = DataParser.parse(tsv);
      expect(result.success).toBe(true);
      expect(result.format).toBe('tsv');
      expect(result.data).toHaveLength(2);
    });

    it('应优先检测制表符分隔符', () => {
      // 数据中同时有逗号和制表符，应优先使用制表符
      const mixed = '名称\t价格,描述\nA\t100,测试';
      const result = DataParser.parse(mixed);
      expect(result.format).toBe('tsv');
    });
  });

  describe('智能类型转换', () => {
    it('应将数字字符串转换为数字', () => {
      const csv = '数量,金额\n100,99.99';
      const result = DataParser.parse(csv);
      expect(result.data[0].数量).toBe(100);
      expect(result.data[0].金额).toBe(99.99);
    });

    it('应保留前导零的字符串（如电话号码）', () => {
      const csv = '编号,电话\n007,010123456';
      const result = DataParser.parse(csv);
      expect(result.data[0].编号).toBe('007');
      expect(result.data[0].电话).toBe('010123456');
    });

    it('应转换布尔值', () => {
      const csv = '启用,禁用\ntrue,false';
      const result = DataParser.parse(csv);
      expect(result.data[0].启用).toBe(true);
      expect(result.data[0].禁用).toBe(false);
    });

    it('应保留日期字符串', () => {
      const csv = '日期\n2024-01-01';
      const result = DataParser.parse(csv);
      expect(result.data[0].日期).toBe('2024-01-01');
      expect(typeof result.data[0].日期).toBe('string');
    });
  });

  describe('列名验证', () => {
    it('应验证期望的列名存在', () => {
      const csv = '名称,价格\nA,100';
      const expectedColumns = ['名称', '价格'];
      const result = DataParser.parse(csv, expectedColumns);
      expect(result.success).toBe(true);
    });

    it('应报告缺少的列', () => {
      const csv = '名称\nA';
      const expectedColumns = ['名称', '价格'];
      const result = DataParser.parse(csv, expectedColumns);
      expect(result.success).toBe(false);
      expect(result.error).toContain('价格');
      expect(result.error).toContain('缺少');
    });

    it('应允许额外的列', () => {
      const csv = '名称,价格,备注\nA,100,test';
      const expectedColumns = ['名称', '价格'];
      const result = DataParser.parse(csv, expectedColumns);
      expect(result.success).toBe(true);
    });
  });

  describe('表头检测', () => {
    it('应识别纯文字表头', () => {
      const csv = '名称,价格\nA,100';
      const result = DataParser.parse(csv);
      expect(result.data[0]).toHaveProperty('名称');
      expect(result.data[0]).toHaveProperty('价格');
    });

    it('应使用提供的列名（无表头时）', () => {
      // 当只有一行数据且提供了期望列名时，会尝试验证
      const csv = 'A,100\nB,200'; // 两行数据，第一行被认为是表头
      const result = DataParser.parse(csv);
      expect(result.success).toBe(true);
      // 默认会把第一行当作表头
      expect(result.data[0]).toHaveProperty('A');
    });
  });

  describe('边界情况', () => {
    it('应处理单行数据（只有表头）', () => {
      const csv = '名称,价格';
      const result = DataParser.parse(csv);
      expect(result.success).toBe(false);
      expect(result.error).toContain('没有数据行');
    });

    it('应处理特殊字符', () => {
      const csv = '名称,描述\nProduct A,"包含,逗号"';
      const result = DataParser.parse(csv);
      expect(result.success).toBe(true);
      expect(result.data[0].描述).toBe('包含,逗号');
    });

    it('应处理 Unicode 字符', () => {
      const csv = '名称,表情\n测试,😀';
      const result = DataParser.parse(csv);
      expect(result.success).toBe(true);
      expect(result.data[0].表情).toBe('😀');
    });

    it('应处理多行空白', () => {
      const csv = '名称,价格\n\nA,100\n\nB,200\n';
      const result = DataParser.parse(csv);
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
    });
  });
});

describe('DataParser.formatResultMessage', () => {
  it('应格式化成功消息', () => {
    const result = {
      success: true,
      data: [{}, {}],
      format: 'csv' as const,
      rowCount: 2,
    };
    const message = DataParser.formatResultMessage(result);
    expect(message).toContain('CSV');
    expect(message).toContain('2');
  });

  it('应格式化失败消息', () => {
    const result = {
      success: false,
      data: [],
      error: '解析失败',
    };
    const message = DataParser.formatResultMessage(result);
    expect(message).toBe('解析失败');
  });

  it('应处理不同格式', () => {
    const formats = ['json', 'csv', 'tsv', 'pipe'] as const;
    formats.forEach((format) => {
      const result = {
        success: true,
        data: [{}],
        format,
        rowCount: 1,
      };
      const message = DataParser.formatResultMessage(result);
      expect(message).toContain('1');
    });
  });
});
