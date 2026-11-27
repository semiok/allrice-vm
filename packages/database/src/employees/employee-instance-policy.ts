import type { EmployeeInstanceSnapshot } from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import type { getDatabase } from '../core/client.ts';

type ContentSql = ReturnType<typeof getDatabase> | TransactionSql;

/** Directory callers enforce owner visibility before projecting a personal name. */
export function personalInstanceNameSql(sql: ContentSql) {
  return sql`i.kind='custom'`;
}

/** The caller must establish current owner and assignment authority. */
export function canUsePersonalEmployeeScenes(
  instance: Pick<EmployeeInstanceSnapshot, 'kind'>,
) {
  return instance.kind === 'custom';
}
