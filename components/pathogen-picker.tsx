'use client';
import { useMemo } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { normalizePathogens } from '@/lib/dashboard-query';

export function PathogenPicker({
  value,
  onChange,
  options,
  disabled = false,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  options: { code: string; name: string }[];
  disabled?: boolean;
}) {
  const normalized = normalizePathogens(value);
  const displayOptions = useMemo(() => {
    const byCode = new Map(options.map((option) => [option.code, option]));
    for (const code of normalized)
      if (!byCode.has(code)) byCode.set(code, { code, name: code });
    return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [normalized, options]);
  const selected = new Set(normalized);
  const toggle = (code: string) =>
    onChange(
      normalizePathogens(
        selected.has(code)
          ? normalized.filter((value) => value !== code)
          : [...normalized, code],
      ),
    );
  return (
    <Popover>
      <PopoverTrigger
        className="pathogen-trigger"
        aria-label="筛选病原体"
        disabled={disabled}
      >
        <span>
          {normalized.length
            ? `已选 ${normalized.length} 种病原体`
            : '全部病原体'}
        </span>
        <ChevronDown />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="cyber-popup pathogen-popover"
        aria-label="病原体多选列表"
      >
        <div className="pathogen-picker-heading">
          <strong>选择病原体</strong>
          {normalized.length > 0 && (
            <Button variant="ghost" size="xs" onClick={() => onChange([])}>
              <X />
              清空
            </Button>
          )}
        </div>
        <div className="pathogen-options">
          {displayOptions.length ? (
            displayOptions.map((option) => (
              <label key={option.code} className="pathogen-option">
                <Checkbox
                  checked={selected.has(option.code)}
                  onCheckedChange={() => toggle(option.code)}
                />
                <span>{option.name}</span>
                <small>{option.code}</small>
              </label>
            ))
          ) : (
            <p>当前范围暂无检测病原体</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
