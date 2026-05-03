import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

import Database from 'better-sqlite3'
import type { SQLiteTransaction } from 'drizzle-orm/sqlite-core'

function dbVersion(db: BetterSQLite3Database | SQLiteTransaction<"sync", Database.RunResult, Record<string, never>, never>) {
    return (db.get(sql`PRAGMA user_version`) as { user_version: number }).user_version
}

export const company = sqliteTable('company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
})

export const job = sqliteTable('job', {
    id: text('id').primaryKey(),
    companyName: text('company_name').notNull(),
    toFetch: integer('to_fetch').notNull(),
    shortInfo: text('short_info'),
    longInfo: text('long_info'),
})

export const toReview = sqliteTable('to_review', {
    id: text('id').primaryKey(),
})

export function migrate(db: BetterSQLite3Database) {
    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 0) {
            tx.run(sql`CREATE TABLE company (
                name TEXT PRIMARY KEY,
                checked_epoch_ms INTEGER,
                "exists" INTEGER
            )`)
            tx.run(sql`CREATE TABLE job (
                id TEXT PRIMARY KEY,
                company_name TEXT NOT NULL
            )`)
            tx.run(sql`PRAGMA user_version = 1`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 1) {
            tx.run(sql`ALTER TABLE job ADD COLUMN to_fetch INTEGER NOT NULL DEFAULT 0`)
            tx.run(sql`PRAGMA user_version = 2`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 2) {
            tx.run(sql`ALTER TABLE job ADD COLUMN short_info TEXT`)
            tx.run(sql`ALTER TABLE job ADD COLUMN long_info TEXT`)
            tx.run(sql`PRAGMA user_version = 3`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 3) {
            tx.run(sql`CREATE TABLE to_review (
                id TEXT PRIMARY KEY
            )`)
            tx.run(sql`PRAGMA user_version = 4`)
        }
    })
}
