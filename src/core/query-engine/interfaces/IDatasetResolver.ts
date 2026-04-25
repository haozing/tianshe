/**
 * IDatasetResolver 接口
 * 用于解决QueryEngine与DuckDBService之间的循环依赖
 *
 * 问题：LookupBuilder和DictBuilder需要获取数据集信息，但它们位于core层，
 *      不应该直接依赖main层的DuckDBService
 *
 * 解决方案：定义接口，让main层实现，core层依赖接口而非具体实现
 *
 * 注意：这里导入Dataset类型是类型级别的导入，不会产生运行时循环依赖
 */

import type { Dataset } from '../../../main/duckdb/types';

/**
 * 数据集解析器接口
 * 为QueryEngine的Builder提供获取数据集信息的能力
 */
export interface IDatasetResolver {
  /**
   * 获取数据集完整信息
   * @param datasetId - 数据集ID
   * @returns 数据集信息，不存在时返回null
   */
  getDatasetInfo(datasetId: string): Promise<Dataset | null>;

  /**
   * 获取数据集的表名
   * @param datasetId - 数据集ID
   * @returns DuckDB中的表名（通常是 ds_<datasetId>.data）
   */
  getDatasetTableName(datasetId: string): Promise<string>;

  /**
   * 检查数据集是否存在
   * @param datasetId - 数据集ID
   * @returns 是否存在
   */
  datasetExists(datasetId: string): Promise<boolean>;
}
