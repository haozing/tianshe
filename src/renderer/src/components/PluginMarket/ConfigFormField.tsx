/**
 * 插件配置表单字段组件
 *
 * 根据配置类型自动渲染对应的输入控件
 */

import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { Select, SelectItem } from '../ui/select';

interface ConfigProperty {
  type: 'boolean' | 'number' | 'string';
  title: string;
  description?: string;
  default?: any;
  minimum?: number;
  maximum?: number;
  enum?: string[];
}

interface ConfigFormFieldProps {
  configKey: string;
  property: ConfigProperty;
  value: any;
  onChange: (key: string, value: any) => void;
  error?: string;
}

export function ConfigFormField({
  configKey,
  property,
  value,
  onChange,
  error,
}: ConfigFormFieldProps) {
  const fieldId = `config-${configKey}`;

  // Boolean 类型 - Checkbox
  if (property.type === 'boolean') {
    return (
      <div className="space-y-2">
        <div className="flex items-start space-x-3">
          <Checkbox
            id={fieldId}
            checked={value ?? property.default ?? false}
            onCheckedChange={(checked) => onChange(configKey, checked)}
          />
          <div className="space-y-1 leading-none">
            <Label htmlFor={fieldId} className="text-sm font-medium cursor-pointer">
              {property.title}
            </Label>
            {property.description && (
              <p className="text-xs text-gray-500">{property.description}</p>
            )}
          </div>
        </div>
        {error && <p className="text-xs text-red-500 ml-6">{error}</p>}
      </div>
    );
  }

  // Number 类型 - Number Input
  if (property.type === 'number') {
    return (
      <div className="space-y-2">
        <Label htmlFor={fieldId} className="text-sm font-medium">
          {property.title}
        </Label>
        <Input
          id={fieldId}
          type="number"
          value={value ?? property.default ?? 0}
          onChange={(e) => {
            const numValue = parseFloat(e.target.value);
            if (!isNaN(numValue)) {
              onChange(configKey, numValue);
            }
          }}
          min={property.minimum}
          max={property.maximum}
          className={error ? 'border-red-500' : ''}
        />
        {property.description && <p className="text-xs text-gray-500">{property.description}</p>}
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    );
  }

  // String 类型 - 如果有 enum 则用 Select，否则用 Input
  if (property.type === 'string') {
    if (property.enum && property.enum.length > 0) {
      // Select Dropdown
      return (
        <div className="space-y-2">
          <Label htmlFor={fieldId} className="text-sm font-medium">
            {property.title}
          </Label>
          <Select
            id={fieldId}
            value={value ?? property.default ?? property.enum[0]}
            onValueChange={(val) => onChange(configKey, val)}
            className={error ? 'border-red-500' : ''}
          >
            {property.enum.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </Select>
          {property.description && <p className="text-xs text-gray-500">{property.description}</p>}
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      );
    } else {
      // Text Input
      return (
        <div className="space-y-2">
          <Label htmlFor={fieldId} className="text-sm font-medium">
            {property.title}
          </Label>
          <Input
            id={fieldId}
            type="text"
            value={value ?? property.default ?? ''}
            onChange={(e) => onChange(configKey, e.target.value)}
            className={error ? 'border-red-500' : ''}
          />
          {property.description && <p className="text-xs text-gray-500">{property.description}</p>}
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      );
    }
  }

  // 不支持的类型
  return <div className="text-sm text-gray-500">不支持的配置类型: {property.type}</div>;
}
