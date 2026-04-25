/**
 * XLS转CSV转换器
 * 使用xlsx库将XLS/XLSX文件转换为CSV
 */

import * as XLSX from 'xlsx';
import fs from 'fs-extra';
import { getTempFilePath } from './utils';

export class XLSConverter {
  /**
   * 将XLS/XLSX转换为CSV
   * @param xlsPath XLS/XLSX文件路径
   * @returns 临时CSV文件路径
   */
  async convertToCSV(xlsPath: string): Promise<string> {
    try {
      // 1. 读取XLS/XLSX文件
      const workbook = XLSX.readFile(xlsPath);

      // 2. 选择第一个sheet
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];

      if (!worksheet) {
        throw new Error('No worksheet found in workbook');
      }

      // 3. 转换为CSV字符串
      const csvData = XLSX.utils.sheet_to_csv(worksheet, {
        FS: ',', // 字段分隔符
        RS: '\n', // 行分隔符
        blankrows: false, // 跳过空行
      });

      // 4. 写入临时CSV文件
      const tempCsvPath = getTempFilePath(xlsPath, '.csv');
      await fs.writeFile(tempCsvPath, csvData, 'utf-8');

      return tempCsvPath;
    } catch (error: any) {
      throw new Error(`Failed to convert to CSV: ${error.message}`);
    }
  }

  /**
   * 获取XLS/XLSX文件的sheet列表
   */
  async getSheetNames(xlsPath: string): Promise<string[]> {
    try {
      const workbook = XLSX.readFile(xlsPath);
      return workbook.SheetNames;
    } catch (error: any) {
      throw new Error(`Failed to read XLS file: ${error.message}`);
    }
  }
}
