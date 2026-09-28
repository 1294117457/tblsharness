import type { LogicalType } from '../shared/model';

export interface ParsedType {
  logicalType: LogicalType;
  length?: number;
  precision?: number;
  scale?: number;
  enumValues?: string[];
}

const RULES: Array<[RegExp, LogicalType]> = [
  [/^(bool|boolean|bit(\(1\))?|tinyint\(1\))$/, 'boolean'],
  [/^(tiny|small|medium|big)?int(eger)?\d*(\s|\(|$)|^int[248]$|^(small|big)?serial\d*$|^long$/, 'integer'],
  [/^(numeric|decimal|dec|number|money|smallmoney)(\s|\(|$)/, 'decimal'],
  [/^(real|float\d*|double( precision)?)(\s|\(|$)/, 'float'],
  [/^(uuid|uniqueidentifier)$/, 'uuid'],
  [/^jsonb?$/, 'json'],
  [/^(n?varchar2?|character varying|varying|n?char|character|bpchar|string|citext)(\s|\(|$)/, 'string'],
  [/^((tiny|medium|long)?text|n?clob|ntext)$/, 'text'],
  [/^date$/, 'date'],
  [/^time(\(\d+\))?( with(out)? time zone)?$|^timetz$/, 'time'],
  [/^(timestamp|timestamptz|datetime|datetime2|datetimeoffset|smalldatetime)(\s|\(|$)/, 'datetime'],
  [/^(bytea|(tiny|medium|long)?blob|binary|varbinary|image|raw)(\s|\(|$)/, 'binary'],
  [/^vector(\s|\(|$)/, 'vector'],
];

export function parseColumnType(rawType: string, enumValues?: string[]): ParsedType {
  if (enumValues) {
    return { logicalType: 'enum', enumValues };
  }
  const type = rawType.trim().toLowerCase();

  const mysqlEnum = /^(enum|set)\((.*)\)$/.exec(type);
  if (mysqlEnum) {
    return { logicalType: 'enum', enumValues: parseQuotedList(rawType.trim().slice(mysqlEnum[1].length + 1, -1)) };
  }
  if (type.endsWith('[]') || type.startsWith('array')) {
    return { logicalType: 'array' };
  }

  const logicalType = RULES.find(([pattern]) => pattern.test(type))?.[1] ?? 'other';
  const args = /\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(type);
  const parsed: ParsedType = { logicalType };
  if (args) {
    const first = Number(args[1]);
    const second = args[2] === undefined ? undefined : Number(args[2]);
    if (logicalType === 'decimal') {
      parsed.precision = first;
      parsed.scale = second;
    } else if (logicalType === 'string' || logicalType === 'binary' || logicalType === 'vector') {
      parsed.length = first;
    }
  }
  return parsed;
}

function parseQuotedList(body: string): string[] {
  const values: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    values.push(m[1].replace(/''/g, "'"));
  }
  return values;
}
