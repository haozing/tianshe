/**
 * Mock DuckDBService for testing
 * 提供可预测的测试数据和行为
 */

export interface MockDatasetSchema {
  name: string;
  type: string;
  duckdbType?: string;
}

export interface MockDataset {
  id: string;
  name: string;
  filePath: string;
  schema: MockDatasetSchema[];
  data: any[];
}

export class MockDuckDBService {
  private datasets: Map<string, MockDataset> = new Map();
  private queryLog: string[] = [];

  constructor() {
    // 初始化测试数据集
    this.initializeTestDatasets();
  }

  /**
   * 初始化测试数据集
   */
  private initializeTestDatasets() {
    // 数据集1: 用户数据
    this.addDataset({
      id: 'users',
      name: '用户数据',
      filePath: '/test/users.csv',
      schema: [
        { name: '_row_id', type: 'INTEGER', duckdbType: 'INTEGER' },
        { name: 'id', type: 'INTEGER', duckdbType: 'INTEGER' },
        { name: 'name', type: 'VARCHAR', duckdbType: 'VARCHAR' },
        { name: 'age', type: 'INTEGER', duckdbType: 'INTEGER' },
        { name: 'email', type: 'VARCHAR', duckdbType: 'VARCHAR' },
        { name: 'city', type: 'VARCHAR', duckdbType: 'VARCHAR' },
        { name: 'score', type: 'DOUBLE', duckdbType: 'DOUBLE' },
      ],
      data: [
        {
          _row_id: 0,
          id: 1,
          name: '张三',
          age: 25,
          email: 'zhangsan@test.com',
          city: '北京',
          score: 85.5,
        },
        {
          _row_id: 1,
          id: 2,
          name: '李四',
          age: 30,
          email: 'lisi@test.com',
          city: '上海',
          score: 92.0,
        },
        {
          _row_id: 2,
          id: 3,
          name: '王五',
          age: 28,
          email: 'wangwu@test.com',
          city: '北京',
          score: 78.5,
        },
        {
          _row_id: 3,
          id: 4,
          name: '赵六',
          age: 35,
          email: 'zhaoliu@test.com',
          city: '深圳',
          score: 88.0,
        },
        {
          _row_id: 4,
          id: 5,
          name: '孙七',
          age: 25,
          email: 'sunqi@test.com',
          city: '上海',
          score: 95.5,
        },
      ],
    });

    // 数据集2: 产品数据
    this.addDataset({
      id: 'products',
      name: '产品数据',
      filePath: '/test/products.csv',
      schema: [
        { name: '_row_id', type: 'INTEGER', duckdbType: 'INTEGER' },
        { name: 'product_id', type: 'INTEGER', duckdbType: 'INTEGER' },
        { name: 'product_name', type: 'VARCHAR', duckdbType: 'VARCHAR' },
        { name: 'price', type: 'DOUBLE', duckdbType: 'DOUBLE' },
        { name: 'category', type: 'VARCHAR', duckdbType: 'VARCHAR' },
      ],
      data: [
        {
          _row_id: 0,
          product_id: 101,
          product_name: '笔记本电脑',
          price: 5999.0,
          category: '电子产品',
        },
        { _row_id: 1, product_id: 102, product_name: '手机', price: 3999.0, category: '电子产品' },
        { _row_id: 2, product_id: 103, product_name: '键盘', price: 299.0, category: '配件' },
        { _row_id: 3, product_id: 104, product_name: '鼠标', price: 99.0, category: '配件' },
      ],
    });

    // 数据集3: 敏感词库
    this.addDataset({
      id: 'sensitive_words',
      name: '敏感词库',
      filePath: '/test/sensitive_words.csv',
      schema: [
        { name: '_row_id', type: 'INTEGER', duckdbType: 'INTEGER' },
        { name: 'word', type: 'VARCHAR', duckdbType: 'VARCHAR' },
      ],
      data: [
        { _row_id: 0, word: '违禁词1' },
        { _row_id: 1, word: '违禁词2' },
        { _row_id: 2, word: '敏感内容' },
      ],
    });
  }

  /**
   * 添加数据集
   */
  addDataset(dataset: MockDataset) {
    this.datasets.set(dataset.id, dataset);
  }

  /**
   * 获取数据集信息
   */
  async getDatasetInfo(datasetId: string): Promise<MockDataset | null> {
    return this.datasets.get(datasetId) || null;
  }

  /**
   * 模拟查询执行
   * 这里简化处理，实际应该解析 SQL
   */
  async query(sql: string): Promise<any[]> {
    this.queryLog.push(sql);

    // 简单的模拟：返回空数组或测试数据
    // 实际测试中应该根据 SQL 返回相应数据
    return [];
  }

  /**
   * 模拟带参数的 SQL 执行
   */
  async executeSQLWithParams(sql: string, _params: any[]): Promise<any[]> {
    this.queryLog.push(sql);
    return [];
  }

  /**
   * 查询数据集
   */
  async queryDataset(
    datasetId: string,
    sql: string
  ): Promise<{
    columns: any[];
    rows: any[];
    rowCount: number;
  }> {
    this.queryLog.push(sql);

    const dataset = this.datasets.get(datasetId);
    if (!dataset) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    // 简化：直接返回所有数据
    // 实际应该解析 SQL 并过滤数据
    const rows = this.executeSimpleQuery(sql, dataset);
    const columns = dataset.schema.map((col) => ({
      name: col.name,
      type: col.type,
    }));

    return {
      columns,
      rows,
      rowCount: rows.length,
    };
  }

  /**
   * 简单的 SQL 执行模拟
   */
  private executeSimpleQuery(sql: string, dataset: MockDataset): any[] {
    const lowerSql = sql.toLowerCase();

    // 处理 LIMIT
    let limit = dataset.data.length;
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
      limit = parseInt(limitMatch[1]);
    }

    // 处理 WHERE age > X
    if (lowerSql.includes('where') && lowerSql.includes('age')) {
      const ageMatch = sql.match(/age\s*>\s*(\d+)/i);
      if (ageMatch) {
        const minAge = parseInt(ageMatch[1]);
        return dataset.data.filter((row) => row.age > minAge).slice(0, limit);
      }
    }

    // 处理 WHERE city = X
    if (lowerSql.includes('where') && lowerSql.includes('city')) {
      const cityMatch = sql.match(/city\s*=\s*'([^']+)'/i);
      if (cityMatch) {
        const city = cityMatch[1];
        return dataset.data.filter((row) => row.city === city).slice(0, limit);
      }
    }

    // 处理 COUNT(*)
    if (lowerSql.includes('count(*)')) {
      return [{ total: dataset.data.length }];
    }

    // 默认返回所有数据（带 LIMIT）
    return dataset.data.slice(0, limit);
  }

  /**
   * 模拟 Aho-Corasick 词库筛选
   */
  async filterWithAhoCorasick(
    datasetId: string,
    targetField: string,
    dictDatasetId: string,
    dictField: string,
    isBlacklist: boolean
  ): Promise<number[]> {
    const dataset = this.datasets.get(datasetId);
    const dictDataset = this.datasets.get(dictDatasetId);

    if (!dataset || !dictDataset) {
      throw new Error('Dataset not found');
    }

    // 获取词库
    const words = dictDataset.data.map((row) => row[dictField]);

    // 筛选匹配的行
    const matchedIds: number[] = [];
    dataset.data.forEach((row) => {
      const fieldValue = String(row[targetField] || '');
      const hasMatch = words.some((word) => fieldValue.includes(word));

      if ((hasMatch && !isBlacklist) || (!hasMatch && isBlacklist)) {
        matchedIds.push(row._row_id);
      }
    });

    return matchedIds;
  }

  async createTempRowIdTable(
    _datasetId: string,
    _tableName: string,
    _rowIds: number[]
  ): Promise<void> {}

  async dropTempRowIdTable(_datasetId: string, _tableName: string): Promise<void> {}

  /**
   * 获取查询日志（用于测试验证）
   */
  getQueryLog(): string[] {
    return [...this.queryLog];
  }

  /**
   * 清除查询日志
   */
  clearQueryLog(): void {
    this.queryLog = [];
  }

  /**
   * 重置为初始状态
   */
  reset(): void {
    this.datasets.clear();
    this.queryLog = [];
    this.initializeTestDatasets();
  }
}
