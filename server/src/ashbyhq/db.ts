import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const company = sqliteTable('company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
})

export const job = sqliteTable('job', {
    id: text('id').primaryKey(),
    companyName: text('company_name').notNull(),
})

export function migrate(db: BetterSQLite3Database) {
    db.transaction((tx) => {
        const version = (tx.get(sql`PRAGMA user_version`) as { user_version: number }).user_version
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
}
