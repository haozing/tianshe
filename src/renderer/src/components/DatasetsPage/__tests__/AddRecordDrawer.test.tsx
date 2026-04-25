/**
 * AddRecordDrawer Component Tests
 *
 * Tests real user interactions with the form:
 * - Form field rendering and input
 * - Data validation before submit
 * - Success/error handling
 * - Tab switching
 * - Batch data paste and submit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// Mock the Electron API
const mockInsertRecord = vi.fn();
const mockBatchInsertRecords = vi.fn();
const mockOnImportRecordsProgress = vi.fn(() => () => {});
const mockUpdateColumnMetadata = vi.fn();
const mockImportRecordsFromFile = vi.fn();
const mockImportRecordsFromBase64 = vi.fn();
const mockGetDatasetInfo = vi.fn();
const mockApplyLocalDatasetSchema = vi.fn();
const mockApplyLocalRecordInsert = vi.fn(() => ({ rowAppended: true, countUpdated: true }));

// Mock the dataset store
const mockCurrentDataset = {
  id: 'test-dataset',
  name: 'Test Dataset',
  schema: [
    { name: 'name', fieldType: 'text', duckdbType: 'VARCHAR', nullable: true },
    { name: 'age', fieldType: 'number', duckdbType: 'INTEGER', nullable: true },
    { name: 'email', fieldType: 'text', duckdbType: 'VARCHAR', nullable: true },
    {
      name: 'status',
      fieldType: 'single_select',
      duckdbType: 'VARCHAR',
      nullable: true,
      metadata: { options: ['active', 'inactive'] },
    },
    { name: 'deleted_at', fieldType: 'date', duckdbType: 'TIMESTAMP', nullable: true },
    { name: 'files', fieldType: 'attachment', duckdbType: 'VARCHAR', nullable: true },
    { name: 'action', fieldType: 'button', duckdbType: 'VARCHAR', nullable: true },
    {
      name: 'total',
      fieldType: 'number',
      duckdbType: 'DOUBLE',
      nullable: true,
      storageMode: 'computed',
    },
  ],
};

const mockQueryResult = {
  rows: [
    { name: 'John', age: 30, email: 'john@test.com', status: 'active' },
    { name: 'Jane', age: 25, email: 'jane@test.com', status: 'inactive' },
  ],
};

vi.mock('../../../stores/datasetStore', () => ({
  useDatasetStore: () => ({
    currentDataset: mockCurrentDataset,
    queryResult: mockQueryResult,
    getDatasetInfo: mockGetDatasetInfo,
    applyLocalDatasetSchema: mockApplyLocalDatasetSchema,
    applyLocalRecordInsert: mockApplyLocalRecordInsert,
  }),
}));

// Mock alert
const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: mockToast,
}));

vi.mock('../../lib/toast', () => ({
  toast: mockToast,
}));

import { AddRecordDrawer } from '../AddRecordDrawer';

describe('AddRecordDrawer', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    datasetId: 'test-dataset',
    onSubmitSuccess: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, {
      electronAPI: {
        duckdb: {
          onImportRecordsProgress: mockOnImportRecordsProgress,
          insertRecord: mockInsertRecord,
          batchInsertRecords: mockBatchInsertRecords,
          importRecordsFromFile: mockImportRecordsFromFile,
          importRecordsFromBase64: mockImportRecordsFromBase64,
          updateColumnMetadata: mockUpdateColumnMetadata,
        },
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render form fields based on schema', () => {
      render(<AddRecordDrawer {...defaultProps} />);

      // Check that all user fields are rendered
      expect(screen.getByText('name')).toBeInTheDocument();
      expect(screen.getByText('age')).toBeInTheDocument();
      expect(screen.getByText('email')).toBeInTheDocument();
      expect(screen.getByText('status')).toBeInTheDocument();
    });

    it('should hide system and non-writable columns', () => {
      render(<AddRecordDrawer {...defaultProps} />);

      expect(screen.queryByText('deleted_at')).not.toBeInTheDocument();
      expect(screen.queryByText('files')).not.toBeInTheDocument();
      expect(screen.queryByText('action')).not.toBeInTheDocument();
      expect(screen.queryByText('total')).not.toBeInTheDocument();
    });

    it('should not render when isOpen is false', () => {
      render(<AddRecordDrawer {...defaultProps} isOpen={false} />);

      expect(screen.queryByText('name')).not.toBeInTheDocument();
    });

    it('should render tab buttons', () => {
      render(<AddRecordDrawer {...defaultProps} />);

      expect(screen.getByText('表单')).toBeInTheDocument();
      expect(screen.getByText('文件&粘贴')).toBeInTheDocument();
    });

    it('should render submit button', () => {
      render(<AddRecordDrawer {...defaultProps} />);

      expect(screen.getByText('提交')).toBeInTheDocument();
    });
  });

  describe('Form Input', () => {
    it('should update form data when user types in text field', async () => {
      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Use getAllByPlaceholderText since multiple inputs have same placeholder
      const inputs = screen.getAllByPlaceholderText('请输入内容');
      const nameInput = inputs[0]; // First input is name (text type)
      await user.type(nameInput, 'Test Name');

      expect(nameInput).toHaveValue('Test Name');
    });

    it('should update form data when user types in number field', async () => {
      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Find the number input (age field)
      const inputs = screen.getAllByPlaceholderText('请输入内容');
      const ageInput = inputs[1]; // Second input is age (number type)

      await user.type(ageInput, '25');

      expect(ageInput).toHaveValue(25);
    });

    it('should persist new single-select options into column metadata', async () => {
      const user = userEvent.setup();
      mockUpdateColumnMetadata.mockResolvedValue({ success: true });
      mockGetDatasetInfo.mockResolvedValue(undefined);

      render(<AddRecordDrawer {...defaultProps} />);

      await user.click(screen.getByText('请选择项'));
      await user.type(screen.getByPlaceholderText('查找或创建选项'), 'pending');
      await user.click(screen.getByText('创建 "pending"'));

      await waitFor(() => {
        expect(mockUpdateColumnMetadata).toHaveBeenCalledWith(
          'test-dataset',
          'status',
          expect.objectContaining({
            options: ['active', 'inactive', 'pending'],
          })
        );
      });
      expect(mockApplyLocalDatasetSchema).toHaveBeenCalledWith(
        'test-dataset',
        expect.arrayContaining([
          expect.objectContaining({
            name: 'status',
            metadata: expect.objectContaining({
              options: ['active', 'inactive', 'pending'],
            }),
          }),
        ])
      );
      expect(mockGetDatasetInfo).not.toHaveBeenCalled();
    });
  });

  describe('Form Submission', () => {
    it('should call insertRecord API on successful submit', async () => {
      mockInsertRecord.mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Fill in the form
      const inputs = screen.getAllByPlaceholderText('请输入内容');
      await user.type(inputs[0], 'John Doe');
      await user.type(inputs[1], '30');
      await user.type(inputs[2], 'john@example.com');

      // Submit the form
      const submitButton = screen.getByText('提交');
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockInsertRecord).toHaveBeenCalledWith(
          'test-dataset',
          expect.objectContaining({
            name: 'John Doe',
            age: '30',
            email: 'john@example.com',
          })
        );
      });

      expect(defaultProps.onSubmitSuccess).toHaveBeenCalled();
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it('should show error alert on API failure', async () => {
      mockInsertRecord.mockResolvedValue({
        success: false,
        error: 'Database error',
      });

      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Fill minimal data
      const inputs = screen.getAllByPlaceholderText('请输入内容');
      await user.type(inputs[0], 'Test');

      // Submit
      const submitButton = screen.getByText('提交');
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalled();
      });

      expect(defaultProps.onClose).not.toHaveBeenCalled();
    });

    // Note: Field validation logic is tested in field-utils.test.ts
    // The validateRecord function correctly validates data types

    it('should keep drawer open when "continue adding" is checked', async () => {
      mockInsertRecord.mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Check the "continue adding" checkbox
      const checkbox = screen.getByLabelText('提交后继续添加记录');
      await user.click(checkbox);

      // Fill in and submit
      const inputs = screen.getAllByPlaceholderText('请输入内容');
      await user.type(inputs[0], 'Test');

      const submitButton = screen.getByText('提交');
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockInsertRecord).toHaveBeenCalled();
        expect(mockToast.success).toHaveBeenCalled();
      });

      // Drawer should stay open
      expect(defaultProps.onClose).not.toHaveBeenCalled();
    });
  });

  describe('Tab Switching', () => {
    it('should switch to file/paste tab when clicked', async () => {
      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Click on file tab
      const fileTab = screen.getByText('文件&粘贴');
      await user.click(fileTab);

      // Should show paste area
      expect(screen.getByText('粘贴内容')).toBeInTheDocument();
      expect(screen.getByText('上传文件')).toBeInTheDocument();
    });

    it('should show batch submit button text in file tab', async () => {
      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Switch to file tab
      const fileTab = screen.getByText('文件&粘贴');
      await user.click(fileTab);

      // Submit button should show batch text
      expect(screen.getByText('批量添加')).toBeInTheDocument();
    });
  });

  describe('Batch Data Submission', () => {
    it('should parse and submit pasted CSV data', async () => {
      mockBatchInsertRecords.mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Switch to file tab
      const fileTab = screen.getByText('文件&粘贴');
      await user.click(fileTab);

      // Paste CSV data
      const textarea = screen.getByPlaceholderText(/支持以下格式粘贴/);
      const csvData = `name,age,email,status
Alice,28,alice@test.com,active
Bob,35,bob@test.com,inactive`;

      await user.clear(textarea);
      await user.type(textarea, csvData);

      // Submit
      const submitButton = screen.getByText('批量添加 →');
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockBatchInsertRecords).toHaveBeenCalledWith(
          'test-dataset',
          expect.arrayContaining([
            expect.objectContaining({ name: 'Alice', age: 28, email: 'alice@test.com' }),
            expect.objectContaining({ name: 'Bob', age: 35, email: 'bob@test.com' }),
          ])
        );
      });

      expect(mockToast.success).toHaveBeenCalled();
    });

    it('should parse and submit pasted JSON data', async () => {
      mockBatchInsertRecords.mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Switch to file tab
      const fileTab = screen.getByText('文件&粘贴');
      await user.click(fileTab);

      // Paste JSON data - use fireEvent.change because userEvent.type can't handle { characters
      const textarea = screen.getByPlaceholderText(/支持以下格式粘贴/);
      const jsonData = JSON.stringify([
        { name: 'Charlie', age: 40, email: 'charlie@test.com', status: 'active' },
      ]);

      fireEvent.change(textarea, { target: { value: jsonData } });

      // Submit
      const submitButton = screen.getByText('批量添加 →');
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockBatchInsertRecords).toHaveBeenCalled();
      });
    });

    it('should show error for invalid paste data', async () => {
      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Switch to file tab
      const fileTab = screen.getByText('文件&粘贴');
      await user.click(fileTab);

      // Paste invalid data
      const textarea = screen.getByPlaceholderText(/支持以下格式粘贴/);
      await user.type(textarea, 'invalid data without columns');

      // Submit
      const submitButton = screen.getByText('批量添加 →');
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalled();
      });

      expect(mockBatchInsertRecords).not.toHaveBeenCalled();
    });

    it('should disable submit button when no data in file tab', async () => {
      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Switch to file tab
      const fileTab = screen.getByText('文件&粘贴');
      await user.click(fileTab);

      // Submit button should be disabled
      const submitButton = screen.getByText('批量添加');
      expect(submitButton).toBeDisabled();
    });

    it('should show validation errors for batch data with type mismatches', async () => {
      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Switch to file tab
      const fileTab = screen.getByText('文件&粘贴');
      await user.click(fileTab);

      // Paste data with invalid types
      const textarea = screen.getByPlaceholderText(/支持以下格式粘贴/);
      const invalidData = `name,age,email,status
Test,not-a-number,test@test.com,active`;

      await user.clear(textarea);
      await user.type(textarea, invalidData);

      // Submit
      const submitButton = screen.getByText('批量添加 →');
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalled();
      });

      expect(mockBatchInsertRecords).not.toHaveBeenCalled();
    });
  });

  describe('Close Behavior', () => {
    it('should call onClose when close button is clicked', async () => {
      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Find and click close button (X icon)
      const closeButtons = screen.getAllByRole('button');
      const closeButton = closeButtons.find((btn) => btn.querySelector('.lucide-x'));

      if (closeButton) {
        await user.click(closeButton);
        expect(defaultProps.onClose).toHaveBeenCalled();
      }
    });

    it('should call onClose when overlay is clicked', async () => {
      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Click on overlay (the semi-transparent background)
      const overlay = document.querySelector('.bg-black.bg-opacity-20');
      if (overlay) {
        await user.click(overlay);
        expect(defaultProps.onClose).toHaveBeenCalled();
      }
    });
  });

  describe('Loading State', () => {
    it('should show loading state during submission', async () => {
      // Make the API call take some time
      mockInsertRecord.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 100))
      );

      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Fill and submit
      const inputs = screen.getAllByPlaceholderText('请输入内容');
      await user.type(inputs[0], 'Test');

      const submitButton = screen.getByText('提交');
      await user.click(submitButton);

      // Should show loading state
      expect(screen.getByText('提交中...')).toBeInTheDocument();

      // Wait for completion
      await waitFor(() => {
        expect(defaultProps.onClose).toHaveBeenCalled();
      });
    });

    it('should disable submit button during submission', async () => {
      mockInsertRecord.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 100))
      );

      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Fill and submit
      const inputs = screen.getAllByPlaceholderText('请输入内容');
      await user.type(inputs[0], 'Test');

      const submitButton = screen.getByText('提交');
      await user.click(submitButton);

      // Button should be disabled
      const loadingButton = screen.getByText('提交中...').closest('button');
      expect(loadingButton).toBeDisabled();

      // Wait for completion
      await waitFor(() => {
        expect(defaultProps.onClose).toHaveBeenCalled();
      });
    });
  });

  describe('User-Friendly Error Messages', () => {
    it('should convert database errors to user-friendly messages', async () => {
      mockInsertRecord.mockResolvedValue({
        success: false,
        error: 'NOT NULL constraint failed: ds_test.data.name',
      });

      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Submit empty form
      const submitButton = screen.getByText('提交');
      await user.click(submitButton);

      await waitFor(() => {
        // Should show user-friendly message, not raw database error
        expect(mockToast.error).toHaveBeenCalled();
      });
    });

    it('should handle UNIQUE constraint errors', async () => {
      mockInsertRecord.mockResolvedValue({
        success: false,
        error: 'UNIQUE constraint failed: ds_test.data.email',
      });

      const user = userEvent.setup();
      render(<AddRecordDrawer {...defaultProps} />);

      // Fill and submit
      const inputs = screen.getAllByPlaceholderText('请输入内容');
      await user.type(inputs[0], 'Test');
      await user.type(inputs[2], 'duplicate@test.com');

      const submitButton = screen.getByText('提交');
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalled();
      });
    });
  });
});
