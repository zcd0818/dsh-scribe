/**
 * Provider-to-provider migration.
 *
 * Product rule encoded here, not in the UI: **nothing migrates without an
 * explicit human decision.** `planMigration` only reads; `runMigration` is
 * called only after the caller has obtained `allowed-once` from the approval
 * service; every run is logged with the exact ids it wrote so it can be undone.
 *
 * @module dsh-scribe/migration/migrate
 */

import { join } from 'node:path'
import { appendJsonLine } from '../store.js'
import { isPlainObject } from '../util.js'
import { isoDate } from '../util.js'

/** Progress batch size: small enough that a failure loses little work. */
const BATCH = 50

/** Absolute path of the migration journal for one data directory. */
export function migrationLogPath(config) {
  return join(config.dataDir, 'migrations.jsonl')
}

/**
 * Read one provider's inventory without changing anything.
 * @param provider - the provider to inspect.
 * @param id - configured name, used in messages.
 * @returns the inventory summary.
 */
export async function inspectProvider(provider, id) {
  const memories = await provider.bulkExport()
  const dates = memories.map((memory) => Number(memory.createdAt ?? 0)).filter((value) => value > 0)
  const bytes = memories.reduce((total, memory) => total + Buffer.byteLength(String(memory.content ?? ''), 'utf8'), 0)
  return {
    id,
    type: provider.kind,
    count: memories.length,
    bytes,
    oldest: dates.length > 0 ? isoDate(Math.min(...dates)) : undefined,
    newest: dates.length > 0 ? isoDate(Math.max(...dates)) : undefined,
    sample: memories.slice(0, 3).map((memory) => String(memory.content ?? '').slice(0, 80)),
  }
}

/**
 * Build a migration plan (a read-only preview).
 * @param options - `{ service, config, from, to }`.
 * @returns `{ from, to, source, target, newCount }`.
 */
export async function planMigration({ service, config, from, to }) {
  if (from === to) throw new Error('source and target providers are the same')
  const source = await inspectProvider(service.providerFor(from), from)
  const target = await inspectProvider(service.providerFor(to), to)
  return {
    id: `mig_${Date.now().toString(36)}`,
    from,
    to,
    source,
    target,
    newCount: source.count,
    createdAt: Date.now(),
  }
}

/**
 * Execute a migration. Callers must obtain explicit user approval first.
 *
 * @param options - `{ service, config, logger, from, to, ids, onProgress }`.
 * @returns the journal record for this run.
 */
export async function runMigration({ service, config, logger, from, to, ids, onProgress }) {
  if (from === to) throw new Error('source and target providers are the same')
  const source = service.providerFor(from)
  const target = service.providerFor(to)

  const all = await source.bulkExport()
  const wanted = Array.isArray(ids) && ids.length > 0 ? all.filter((memory) => ids.includes(memory.id)) : all
  if (wanted.length === 0) throw new Error('no memories selected for migration')

  const startedAt = Date.now()
  const written = []
  const failed = []
  let failedBatches = 0
  for (let offset = 0; offset < wanted.length; offset += BATCH) {
    const batch = wanted.slice(offset, offset + BATCH)
    try {
      const result = await target.bulkAdd(batch)
      // `ids` is the target's own identity for each written record (Bailian
      // mints node ids), which is what a rollback must delete. Without it, fall
      // back to the source id, which every other provider preserves.
      const hasIds = Array.isArray(result.ids) && result.ids.length > 0
      if (hasIds) written.push(...result.ids.map(String))
      else written.push(...batch.slice(0, Math.max(0, Number(result.success) || 0)).map((memory) => memory.id))
      // A backend reports failures by count, so the exact records are unknown
      // when it also mints its own ids; keep the count authoritative and the
      // id list best-effort.
      const failedCount = Math.max(0, Number(result.failed) || 0)
      failedBatches += failedCount
      if (failedCount > 0 && !hasIds) {
        failed.push(...batch.slice(batch.length - failedCount).map((memory) => memory.id))
      }
    } catch (error) {
      logger?.warn('migration batch failed: %s', error?.message ?? error)
      failedBatches += batch.length
      failed.push(...batch.map((memory) => memory.id))
    }
    onProgress?.({ done: Math.min(offset + BATCH, wanted.length), total: wanted.length })
  }

  const record = {
    id: `mig_${startedAt.toString(36)}`,
    timestamp: new Date(startedAt).toISOString(),
    from,
    to,
    totalCount: wanted.length,
    successCount: written.length,
    failedCount: failedBatches,
    durationMs: Date.now() - startedAt,
    status: failedBatches === 0 ? 'complete' : written.length === 0 ? 'failed' : 'partial',
    writtenIds: written,
    failedIds: failed,
  }
  await appendJsonLine(migrationLogPath(config), record)
  return record
}

/**
 * Read the migration journal, newest first.
 * @param config - resolved configuration.
 * @returns journal records.
 */
export async function readMigrations(config) {
  const { readFile } = await import('node:fs/promises')
  try {
    const text = await readFile(migrationLogPath(config), 'utf8')
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      })
      .filter((record) => isPlainObject(record))
      .reverse()
  } catch {
    return []
  }
}

/**
 * Undo the additions recorded by one migration.
 *
 * Only ids this run actually wrote are removed, so rollback never touches
 * memories that already existed in the target (or were written later).
 *
 * @param options - `{ service, config, logger, migrationId }`.
 * @returns `{ record, removed, declined }`.
 */
export async function rollbackMigration({ service, config, logger, migrationId }) {
  const journal = await readMigrations(config)
  const record = journal.find((entry) => entry.id === migrationId)
  if (record === undefined) throw new Error(`migration "${migrationId}" was not found in the journal`)
  const already = journal.find((entry) => entry.rollbackOf === migrationId)
  if (already !== undefined) throw new Error(`migration "${migrationId}" was already rolled back at ${already.timestamp}`)

  const target = service.providerFor(record.to)
  const ids = Array.isArray(record.writtenIds) ? record.writtenIds : []
  const removed = []
  const declined = []
  for (const id of ids) {
    try {
      const existed = await target.delete(id)
      if (existed) removed.push(id)
      else declined.push(id)
    } catch (error) {
      logger?.warn('rollback delete failed for %s: %s', id, error?.message ?? error)
      declined.push(id)
    }
  }

  const rollback = {
    id: `migrb_${Date.now().toString(36)}`,
    timestamp: new Date().toISOString(),
    rollbackOf: migrationId,
    from: record.to,
    to: record.from,
    totalCount: ids.length,
    successCount: removed.length,
    failedCount: declined.length,
    durationMs: 0,
    status: declined.length === 0 ? 'rolled-back' : 'partial-rollback',
    writtenIds: [],
    failedIds: declined,
  }
  await appendJsonLine(migrationLogPath(config), rollback)
  return { record, removed: removed.length, declined: declined.length }
}

/**
 * Render a plan as the confirmation text the user sees before approving.
 * @param plan - the plan from `planMigration`.
 * @returns multi-line text.
 */
export function formatPlan(plan) {
  const { source, target } = plan
  return [
    '检测到现有记忆数据',
    '',
    `  源：${source.id}（${source.type}）— ${source.count} 条${source.oldest ? `，${source.oldest} 至 ${source.newest}` : ''}`,
    `  目标：${target.id}（${target.type}）— 现有 ${target.count} 条`,
    '',
    '  迁移只会向目标新增记录，不会删除源数据。',
    '  迁移结束会写入日志；可用 scribe_memory_migrate_rollback 撤销本次新增。',
  ].join('\n')
}
