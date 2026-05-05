import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

import Database from 'better-sqlite3'
import type { SQLiteTransaction } from 'drizzle-orm/sqlite-core'

export const aCompany = sqliteTable('ashbyhq_company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
})

export const aJob = sqliteTable('ashbyhq_job', {
    id: text('id').primaryKey(),
    companyName: text('company_name').notNull(),
    shortInfo: text('short_info').notNull(),
    longInfo: text('long_info'),
    fetchedEpochMs: integer('fetched_epoch_ms'),
})

export const aToReview = sqliteTable('ashbyhq_to_review', {
    id: text('id').primaryKey(),
})

export const aFetchJobDetails = sqliteTable('ashby_fetch_job_details', {
    id: text('id').primaryKey(),
    addedAt: integer('added_at').notNull(),
    jobPostedAfter: integer('job_posted_after').notNull(),
    companyTier: text('company_tier').notNull(),
})

export const lCompany = sqliteTable('lever_company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
})

export const lJob = sqliteTable('lever_job', {
    id: text('id').primaryKey(),
    companyName: text('company_name').notNull(),
    fetchedEpochMs: integer('fetched_epoch_ms').notNull(),
    info: text('info').notNull(),
})

export const gCompany = sqliteTable('greenhouse_company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
})

export const gJob = sqliteTable('greenhouse_job', {
    id: text('id').primaryKey(),
    companyName: text('company_name').notNull(),
    fetchedEpochMs: integer('fetched_epoch_ms').notNull(),
    info: text('info').notNull(),
})

export const bamboohrCompany = sqliteTable('bamboohr_company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
    failCount: integer('fail_count').notNull().default(0),
})

export const bamboohrJob = sqliteTable(
    'bamboohr_job',
    {
        companyName: text('company_name').notNull(),
        id: text('id').notNull(),
        fetchedEpochMs: integer('fetched_epoch_ms').notNull(),
        info: text('info').notNull(),
    },
    table => [
        primaryKey({ columns: [table.companyName, table.id] }),
    ]
)

export const pendingNotification = sqliteTable('pending_notification', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    message: text('message').notNull(),
    originalEpochMs: integer('original_epoch_ms').notNull(),
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
            tx.run(sql`ALTER TABLE job ADD COLUMN short_info TEXT NOT NULL`)
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

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 4) {
            tx.run(sql`ALTER TABLE job ADD COLUMN fetched_epoch_ms INTEGER`)
            tx.run(sql`PRAGMA user_version = 5`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 5) {
            tx.run(sql`ALTER TABLE company RENAME TO ashbyhq_company`)
            tx.run(sql`ALTER TABLE job RENAME TO ashbyhq_job`)
            tx.run(sql`ALTER TABLE to_review RENAME TO ashbyhq_to_review`)
            tx.run(sql`PRAGMA user_version = 6`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 6) {
            tx.run(sql`CREATE TABLE lever_company (
                name TEXT PRIMARY KEY,
                checked_epoch_ms INTEGER,
                "exists" INTEGER
            )`)
            tx.run(sql`CREATE TABLE lever_job (
                id TEXT PRIMARY KEY,
                company_name TEXT NOT NULL,
                fetched_epoch_ms INTEGER NOT NULL,
                info TEXT NOT NULL
            )`)
            tx.run(sql`PRAGMA user_version = 7`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 7) {
            tx.run(sql`CREATE TABLE greenhouse_company (
                name TEXT PRIMARY KEY,
                checked_epoch_ms INTEGER,
                "exists" INTEGER
            )`)
            tx.run(sql`CREATE TABLE greenhouse_job (
                id TEXT PRIMARY KEY,
                company_name TEXT NOT NULL,
                fetched_epoch_ms INTEGER NOT NULL,
                info TEXT NOT NULL
            )`)
            tx.run(sql`PRAGMA user_version = 8`)
        }
    })

    /*
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
    */
    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 8) {
            tx.run(sql`CREATE INDEX ashbyhq_job_company_name_idx ON ashbyhq_job(company_name)`)
            tx.run(sql`CREATE INDEX lever_job_company_name_idx ON lever_job(company_name)`)
            tx.run(sql`CREATE INDEX greenhouse_job_company_name_idx ON greenhouse_job(company_name)`)
            tx.run(sql`CREATE INDEX ashbyhq_company_exists_checked_idx ON ashbyhq_company("exists", checked_epoch_ms)`)
            tx.run(sql`CREATE INDEX lever_company_exists_checked_idx ON lever_company("exists", checked_epoch_ms)`)
            tx.run(sql`CREATE INDEX greenhouse_company_exists_checked_idx ON greenhouse_company("exists", checked_epoch_ms)`)
            tx.run(sql`PRAGMA user_version = 9`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 9) {
            tx.run(sql`CREATE TABLE bamboohr_company (
                name TEXT PRIMARY KEY,
                checked_epoch_ms INTEGER,
                "exists" INTEGER
            )`)
            tx.run(sql`CREATE TABLE bamboohr_job (
                company_name TEXT NOT NULL,
                id TEXT NOT NULL,
                fetched_epoch_ms INTEGER NOT NULL,
                info TEXT NOT NULL,
                PRIMARY KEY(company_name, id)
            )`)
            tx.run(sql`CREATE INDEX bamboohr_company_exists_checked_idx ON bamboohr_company("exists", checked_epoch_ms)`)
            tx.run(sql`PRAGMA user_version = 10`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 10) {
            tx.run(sql`ALTER TABLE bamboohr_company ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0`)
            tx.run(sql`PRAGMA user_version = 11`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 11) {
            tx.run(sql`CREATE TABLE pending_notification (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message TEXT NOT NULL,
                original_epoch_ms INTEGER NOT NULL
            )`)
            tx.run(sql`PRAGMA user_version = 12`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 12) {
            tx.run(sql`ALTER TABLE ashbyhq_job DROP COLUMN to_fetch`)
            tx.run(sql`CREATE TABLE ashby_fetch_job_details (
                id TEXT PRIMARY KEY,
                added_at INTEGER NOT NULL,
                job_posted_after INTEGER NOT NULL,
                company_tier TEXT NOT NULL
            )`)
            tx.run(sql`PRAGMA user_version = 13`)
        }
    })
}


function dbVersion(db: BetterSQLite3Database | SQLiteTransaction<"sync", Database.RunResult, Record<string, never>, never>) {
    return (db.get(sql`PRAGMA user_version`) as { user_version: number }).user_version
}
