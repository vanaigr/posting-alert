import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

import Database from 'better-sqlite3'
import type { SQLiteTransaction } from 'drizzle-orm/sqlite-core'

export const aCompany = sqliteTable('ashbyhq_company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
    failCount: integer('fail_count').notNull(),
    tier: integer('tier').notNull(),
})

export const aJob = sqliteTable('ashbyhq_job', {
    id: text('id').primaryKey(),
    companyName: text('company_name').notNull(),
    shortInfo: text('short_info').notNull(),
    longInfo: text('long_info'),
    fetchedEpochMs: integer('fetched_epoch_ms'),
    relevancy: text('relevancy').notNull(),
})

// TODO: delete
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
    failCount: integer('fail_count').notNull(),
    tier: integer('tier').notNull(),
})

export const lJob = sqliteTable('lever_job', {
    id: text('id').primaryKey(),
    companyName: text('company_name').notNull(),
    fetchedEpochMs: integer('fetched_epoch_ms').notNull(),
    info: text('info').notNull(),
    relevancy: text('relevancy').notNull(),
})


export const gCompany = sqliteTable('greenhouse_company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
    failCount: integer('fail_count').notNull(),
    tier: integer('tier').notNull(),
})

export const gJob = sqliteTable('greenhouse_job_2', {
    id: text('id').primaryKey(),
    companyName: text('company_name').notNull(),
    fetchedEpochMs: integer('fetched_epoch_ms').notNull(),
    info: text('info').notNull(),
    relevancy: text('relevancy').notNull(),
})


export const bamboohrCompany = sqliteTable('bamboohr_company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
    failCount: integer('fail_count').notNull(),
    tier: integer('tier').notNull(),
})

export const bamboohrJob = sqliteTable(
    'bamboohr_job',
    {
        companyName: text('company_name').notNull(),
        id: text('id').notNull(),
        fetchedEpochMs: integer('fetched_epoch_ms').notNull(),
        info: text('info').notNull(),
        longInfo: text('long_info'),
        relevancy: text('relevancy').notNull(),
    },
    table => [
        primaryKey({ columns: [table.companyName, table.id] }),
    ],
)

export const bamboohrFetchJobDetails = sqliteTable('bamboohr_fetch_job_details', {
    uniqueId: text('unique_id').primaryKey(),
    companyName: text('company_name').notNull(),
    id: text('id').notNull(),
    addedAt: integer('added_at').notNull(),
    jobPostedAfter: integer('job_posted_after').notNull(),
    companyTier: text('company_tier').notNull(),
})


export const zohorecruitCompany = sqliteTable('zohorecruit_company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
    failCount: integer('fail_count').notNull(),
    tier: integer('tier').notNull(),
})

export const zohorecruitJob = sqliteTable(
    'zohorecruit_job',
    {
        companyName: text('company_name').notNull(),
        id: text('id').notNull(),
        fetchedEpochMs: integer('fetched_epoch_ms').notNull(),
        info: text('info').notNull(),
        longInfo: text('long_info'),
        relevancy: text('relevancy').notNull(),
    },
    table => [
        primaryKey({ columns: [table.companyName, table.id] }),
    ],
)

export const zohorecruitFetchJobDetails = sqliteTable('zohorecruit_fetch_job_details', {
    uniqueId: text('unique_id').primaryKey(),
    companyName: text('company_name').notNull(),
    id: text('id').notNull(),
    addedAt: integer('added_at').notNull(),
    jobPostedAfter: integer('job_posted_after').notNull(),
    companyTier: text('company_tier').notNull(),
})


export const gemCompany = sqliteTable('gem_company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
    failCount: integer('fail_count').notNull(),
    tier: integer('tier').notNull(),
})

export const gemJob = sqliteTable(
    'gem_job',
    {
        companyName: text('company_name').notNull(),
        id: text('id').notNull(),
        fetchedEpochMs: integer('fetched_epoch_ms').notNull(),
        info: text('info').notNull(),
        relevancy: text('relevancy').notNull(),
    },
    table => [
        primaryKey({ columns: [table.companyName, table.id] }),
    ],
)


export const ripplingCompany = sqliteTable('rippling_company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
    failCount: integer('fail_count').notNull(),
    tier: integer('tier').notNull(),
})

export const ripplingJob = sqliteTable(
    'rippling_job',
    {
        companyName: text('company_name').notNull(),
        id: text('id').notNull(),
        fetchedEpochMs: integer('fetched_epoch_ms').notNull(),
        info: text('info').notNull(),
        longInfo: text('long_info'),
        relevancy: text('relevancy').notNull(),
    },
    table => [
        primaryKey({ columns: [table.companyName, table.id] }),
    ],
)

export const ripplingFetchJobDetails = sqliteTable('rippling_fetch_job_details', {
    uniqueId: text('unique_id').primaryKey(),
    companyName: text('company_name').notNull(),
    id: text('id').notNull(),
    addedAt: integer('added_at').notNull(),
    jobPostedAfter: integer('job_posted_after').notNull(),
    companyTier: text('company_tier').notNull(),
})


export const applytojobCompany = sqliteTable('applytojob_company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
    failCount: integer('fail_count').notNull(),
    tier: integer('tier').notNull(),
})

export const applytojobJob = sqliteTable(
    'applytojob_job',
    {
        companyName: text('company_name').notNull(),
        id: text('id').notNull(),
        fetchedEpochMs: integer('fetched_epoch_ms').notNull(),
        info: text('info').notNull(),
        longInfo: text('long_info'),
        relevancy: text('relevancy').notNull(),
    },
    table => [
        primaryKey({ columns: [table.companyName, table.id] }),
    ],
)

export const applytojobFetchJobDetails = sqliteTable('applytojob_fetch_job_details', {
    uniqueId: text('unique_id').primaryKey(),
    companyName: text('company_name').notNull(),
    id: text('id').notNull(),
    addedAt: integer('added_at').notNull(),
    jobPostedAfter: integer('job_posted_after').notNull(),
    companyTier: text('company_tier').notNull(),
})


export const icimsCompany = sqliteTable('icims_company', {
    name: text('name').primaryKey(),
    checkedEpochMs: integer('checked_epoch_ms'),
    exists: integer('exists'),
    failCount: integer('fail_count').notNull(),
    tier: integer('tier').notNull(),
})

export const icimsJob = sqliteTable(
    'icims_job',
    {
        companyName: text('company_name').notNull(),
        id: text('id').notNull(),
        fetchedEpochMs: integer('fetched_epoch_ms').notNull(),
        info: text('info').notNull(),
        longInfo: text('long_info'),
        relevancy: text('relevancy').notNull(),
    },
    table => [
        primaryKey({ columns: [table.companyName, table.id] }),
    ],
)

export const icimsFetchJobDetails = sqliteTable('icims_fetch_job_details', {
    uniqueId: text('unique_id').primaryKey(),
    companyName: text('company_name').notNull(),
    id: text('id').notNull(),
    addedAt: integer('added_at').notNull(),
    jobPostedAfter: integer('job_posted_after').notNull(),
    companyTier: text('company_tier').notNull(),
})


export const smartrecruitersJob = sqliteTable('smartrecruiters_job', {
    id: text('id').primaryKey(),
    fetchedEpochMs: integer('fetched_epoch_ms').notNull(),
    info: text('info').notNull(),
    longInfo: text('long_info'),
    relevancy: text('relevancy').notNull(),
})

export const smartrecruitersFetchJobDetails = sqliteTable('smartrecruiters_fetch_job_details', {
    id: text('id').notNull(),
    addedAt: integer('added_at').notNull(),
})


export const pendingNotification = sqliteTable('pending_notification', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    data: text('data').notNull(),
    originalEpochMs: integer('original_epoch_ms').notNull(),
})

export const locationClassification = sqliteTable('location_classification', {
    location: text('location').primaryKey(),
    isInUs: text('is_in_us').notNull(), // 0, 1, ?. Empty if not generated
})

export const generationResponse = sqliteTable('generation_response', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    input: text('input').notNull(),
    generation: text('generation').notNull(),
})

export const sentMessages = sqliteTable('sent_messages', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    data: text('data').notNull(),
    telegramMessage: text('telegram_message').notNull(),
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

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 13) {
            tx.run(sql`ALTER TABLE bamboohr_job ADD COLUMN long_info TEXT`)
            tx.run(sql`CREATE TABLE bamboohr_fetch_job_details (
                unique_id TEXT PRIMARY KEY,
                company_name TEXT NOT NULL,
                id TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                job_posted_after INTEGER NOT NULL,
                company_tier TEXT NOT NULL
            )`)
            tx.run(sql`PRAGMA user_version = 14`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 14) {
            tx.run(sql`ALTER TABLE ashbyhq_company ADD COLUMN tier INTEGER NOT NULL DEFAULT 0`)
            tx.run(sql`ALTER TABLE lever_company ADD COLUMN tier INTEGER NOT NULL DEFAULT 0`)
            tx.run(sql`ALTER TABLE greenhouse_company ADD COLUMN tier INTEGER NOT NULL DEFAULT 0`)
            tx.run(sql`ALTER TABLE bamboohr_company ADD COLUMN tier INTEGER NOT NULL DEFAULT 0`)
            tx.run(sql`CREATE INDEX ashbyhq_company_tier_idx ON ashbyhq_company(tier)`)
            tx.run(sql`CREATE INDEX lever_company_tier_idx ON lever_company(tier)`)
            tx.run(sql`CREATE INDEX greenhouse_company_tier_idx ON greenhouse_company(tier)`)
            tx.run(sql`CREATE INDEX bamboohr_company_tier_idx ON bamboohr_company(tier)`)
            tx.run(sql`PRAGMA user_version = 15`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 15) {
            tx.run(sql`CREATE TABLE greenhouse_job_2 (
                company_name TEXT NOT NULL,
                id TEXT NOT NULL,
                fetched_epoch_ms INTEGER NOT NULL,
                info TEXT NOT NULL,
                PRIMARY KEY(company_name, id)
            )`)
            tx.run(sql`
                INSERT INTO greenhouse_job_2(company_name, id, fetched_epoch_ms, info)
                SELECT company_name, id, fetched_epoch_ms, info FROM greenhouse_job
            `)
            tx.run(sql`DROP TABLE greenhouse_job`)

            tx.run(sql`PRAGMA user_version = 16`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 16) {
            // outdated (now it filters by tier as well)
            tx.run(sql`DROP INDEX ashbyhq_company_exists_checked_idx`)
            tx.run(sql`DROP INDEX lever_company_exists_checked_idx`)
            tx.run(sql`DROP INDEX greenhouse_company_exists_checked_idx`)
            tx.run(sql`DROP INDEX bamboohr_company_exists_checked_idx`)
            // only needed once at startup, and if it has stats on "exists" cardinality
            // it should be able to use the new index.
            tx.run(sql`DROP INDEX ashbyhq_company_tier_idx`)
            tx.run(sql`DROP INDEX lever_company_tier_idx`)
            tx.run(sql`DROP INDEX greenhouse_company_tier_idx`)
            tx.run(sql`DROP INDEX bamboohr_company_tier_idx`)

            tx.run(sql`CREATE INDEX ashbyhq_company_exists_tier_checked_idx ON ashbyhq_company("exists", tier, checked_epoch_ms)`)
            tx.run(sql`CREATE INDEX lever_company_exists_tier_checked_idx ON lever_company("exists", tier, checked_epoch_ms)`)
            tx.run(sql`CREATE INDEX greenhouse_company_exists_tier_checked_idx ON greenhouse_company("exists", tier, checked_epoch_ms)`)
            tx.run(sql`CREATE INDEX bamboohr_company_exists_tier_checked_idx ON bamboohr_company("exists", tier, checked_epoch_ms)`)

            tx.run(sql`PRAGMA user_version = 17`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 17) {
            tx.run(sql`CREATE TABLE zohorecruit_company (
                name TEXT PRIMARY KEY,
                checked_epoch_ms INTEGER,
                "exists" INTEGER,
                fail_count INTEGER NOT NULL,
                tier INTEGER NOT NULL
            )`)
            tx.run(sql`CREATE TABLE zohorecruit_job (
                company_name TEXT NOT NULL,
                id TEXT NOT NULL,
                fetched_epoch_ms INTEGER NOT NULL,
                info TEXT NOT NULL,
                long_info TEXT,
                PRIMARY KEY(company_name, id)
            )`)
            tx.run(sql`CREATE TABLE zohorecruit_fetch_job_details (
                unique_id TEXT PRIMARY KEY,
                company_name TEXT NOT NULL,
                id TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                job_posted_after INTEGER NOT NULL,
                company_tier TEXT NOT NULL
            )`)
            tx.run(sql`CREATE INDEX zohorecruit_company_exists_tier_checked_idx ON zohorecruit_company("exists", tier, checked_epoch_ms)`)
            tx.run(sql`PRAGMA user_version = 18`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 18) {
            tx.run(sql`update ashbyhq_company set tier = 0`)
            tx.run(sql`update lever_company set tier = 0`)
            tx.run(sql`update greenhouse_company set tier = 0`)
            tx.run(sql`update bamboohr_company set tier = 0`)
            tx.run(sql`update zohorecruit_company set tier = 0`)
            tx.run(sql`PRAGMA user_version = 19`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 19) {
            tx.run(sql`CREATE TABLE gem_company (
                name TEXT PRIMARY KEY,
                checked_epoch_ms INTEGER,
                "exists" INTEGER,
                tier INTEGER NOT NULL
            )`)
            tx.run(sql`CREATE TABLE gem_job (
                company_name TEXT NOT NULL,
                id TEXT NOT NULL,
                fetched_epoch_ms INTEGER NOT NULL,
                info TEXT NOT NULL,
                PRIMARY KEY(company_name, id)
            )`)
            tx.run(sql`CREATE INDEX gem_company_exists_tier_checked_idx ON gem_company("exists", tier, checked_epoch_ms)`)
            tx.run(sql`PRAGMA user_version = 20`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 20) {
            tx.run(sql`CREATE TABLE rippling_company (
                name TEXT PRIMARY KEY,
                checked_epoch_ms INTEGER,
                "exists" INTEGER,
                tier INTEGER NOT NULL
            )`)
            tx.run(sql`CREATE TABLE rippling_job (
                company_name TEXT NOT NULL,
                id TEXT NOT NULL,
                fetched_epoch_ms INTEGER NOT NULL,
                info TEXT NOT NULL,
                long_info TEXT,
                PRIMARY KEY(company_name, id)
            )`)
            tx.run(sql`CREATE TABLE rippling_fetch_job_details (
                unique_id TEXT PRIMARY KEY,
                company_name TEXT NOT NULL,
                id TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                job_posted_after INTEGER NOT NULL,
                company_tier TEXT NOT NULL
            )`)
            tx.run(sql`CREATE INDEX rippling_company_exists_tier_checked_idx ON rippling_company("exists", tier, checked_epoch_ms)`)
            tx.run(sql`PRAGMA user_version = 21`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 21) {
            tx.run(sql`update ashbyhq_company set tier = 0`)
            tx.run(sql`update lever_company set tier = 0`)
            tx.run(sql`update greenhouse_company set tier = 0`)
            tx.run(sql`update bamboohr_company set tier = 0`)
            tx.run(sql`update zohorecruit_company set tier = 0`)
            tx.run(sql`update gem_company set tier = 0`)
            tx.run(sql`update rippling_company set tier = 0`)
            tx.run(sql`PRAGMA user_version = 22`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 22) {
            tx.run(sql`update ashbyhq_company set tier = 0`)
            tx.run(sql`update lever_company set tier = 0`)
            tx.run(sql`update greenhouse_company set tier = 0`)
            tx.run(sql`update bamboohr_company set tier = 0`)
            tx.run(sql`update zohorecruit_company set tier = 0`)
            tx.run(sql`update gem_company set tier = 0`)
            tx.run(sql`update rippling_company set tier = 0`)
            tx.run(sql`PRAGMA user_version = 23`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 23) {
            tx.run(sql`update ashbyhq_company set tier = 0`)
            tx.run(sql`update lever_company set tier = 0`)
            tx.run(sql`update greenhouse_company set tier = 0`)
            tx.run(sql`update bamboohr_company set tier = 0`)
            tx.run(sql`update zohorecruit_company set tier = 0`)
            tx.run(sql`update gem_company set tier = 0`)
            tx.run(sql`update rippling_company set tier = 0`)
            tx.run(sql`PRAGMA user_version = 24`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 24) {
            tx.run(sql`CREATE TABLE location_classification (
                location TEXT PRIMARY KEY,
                is_in_us TEXT NOT NULL
            )`)
            tx.run(sql`CREATE TABLE generation_response (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                input TEXT NOT NULL,
                generation TEXT NOT NULL
            )`)
            tx.run(sql`PRAGMA user_version = 25`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 25) {
            tx.run(sql`ALTER TABLE ashbyhq_job ADD COLUMN relevancy TEXT NOT NULL DEFAULT '{}'`)
            tx.run(sql`ALTER TABLE lever_job ADD COLUMN relevancy TEXT NOT NULL DEFAULT '{}'`)
            tx.run(sql`ALTER TABLE greenhouse_job_2 ADD COLUMN relevancy TEXT NOT NULL DEFAULT '{}'`)
            tx.run(sql`ALTER TABLE bamboohr_job ADD COLUMN relevancy TEXT NOT NULL DEFAULT '{}'`)
            tx.run(sql`ALTER TABLE zohorecruit_job ADD COLUMN relevancy TEXT NOT NULL DEFAULT '{}'`)
            tx.run(sql`ALTER TABLE gem_job ADD COLUMN relevancy TEXT NOT NULL DEFAULT '{}'`)
            tx.run(sql`ALTER TABLE rippling_job ADD COLUMN relevancy TEXT NOT NULL DEFAULT '{}'`)
            tx.run(sql`PRAGMA user_version = 26`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 26) {
            tx.run(sql`CREATE INDEX location_classification_is_in_us_empty ON location_classification(is_in_us) where is_in_us = ''`)
            tx.run(sql`PRAGMA user_version = 27`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 27) {
            tx.run(sql`CREATE TABLE applytojob_company (
                name TEXT PRIMARY KEY,
                checked_epoch_ms INTEGER,
                "exists" INTEGER,
                fail_count INTEGER NOT NULL,
                tier INTEGER NOT NULL
            )`)
            tx.run(sql`CREATE TABLE applytojob_job (
                company_name TEXT NOT NULL,
                id TEXT NOT NULL,
                fetched_epoch_ms INTEGER NOT NULL,
                info TEXT NOT NULL,
                long_info TEXT,
                relevancy TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY(company_name, id)
            )`)
            tx.run(sql`CREATE TABLE applytojob_fetch_job_details (
                unique_id TEXT PRIMARY KEY,
                company_name TEXT NOT NULL,
                id TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                job_posted_after INTEGER NOT NULL,
                company_tier TEXT NOT NULL
            )`)
            tx.run(sql`CREATE INDEX applytojob_company_exists_tier_checked_idx ON applytojob_company("exists", tier, checked_epoch_ms)`)
            tx.run(sql`PRAGMA user_version = 28`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 28) {
            tx.run(sql`CREATE TABLE smartrecruiters_job (
                id TEXT PRIMARY KEY,
                fetched_epoch_ms INTEGER NOT NULL,
                info TEXT NOT NULL,
                long_info TEXT,
                relevancy TEXT NOT NULL DEFAULT '{}'
            )`)
            tx.run(sql`CREATE TABLE smartrecruiters_fetch_job_details (
                id TEXT PRIMARY KEY,
                added_at INTEGER NOT NULL
            )`)
            tx.run(sql`PRAGMA user_version = 29`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 29) {
            // We don't to index "exists" since for tier 1 and 2 companies always exist, and if they start
            // returning errors, they're demoted to tier 3, and tier 3 is queried regardless of "exists".
            tx.run(sql`DROP INDEX ashbyhq_company_exists_tier_checked_idx`)
            tx.run(sql`DROP INDEX lever_company_exists_tier_checked_idx`)
            tx.run(sql`DROP INDEX greenhouse_company_exists_tier_checked_idx`)
            tx.run(sql`DROP INDEX bamboohr_company_exists_tier_checked_idx`)
            tx.run(sql`DROP INDEX zohorecruit_company_exists_tier_checked_idx`)
            tx.run(sql`DROP INDEX gem_company_exists_tier_checked_idx`)
            tx.run(sql`DROP INDEX rippling_company_exists_tier_checked_idx`)
            tx.run(sql`DROP INDEX applytojob_company_exists_tier_checked_idx`)

            tx.run(sql`CREATE INDEX ashbyhq_company_tier_checked_idx ON ashbyhq_company(tier, checked_epoch_ms)`)
            tx.run(sql`CREATE INDEX lever_company_tier_checked_idx ON lever_company(tier, checked_epoch_ms)`)
            tx.run(sql`CREATE INDEX greenhouse_company_tier_checked_idx ON greenhouse_company(tier, checked_epoch_ms)`)
            tx.run(sql`CREATE INDEX bamboohr_company_tier_checked_idx ON bamboohr_company(tier, checked_epoch_ms)`)
            tx.run(sql`CREATE INDEX zohorecruit_company_tier_checked_idx ON zohorecruit_company(tier, checked_epoch_ms)`)
            tx.run(sql`CREATE INDEX gem_company_tier_checked_idx ON gem_company(tier, checked_epoch_ms)`)
            tx.run(sql`CREATE INDEX rippling_company_tier_checked_idx ON rippling_company(tier, checked_epoch_ms)`)
            tx.run(sql`CREATE INDEX applytojob_company_tier_checked_idx ON applytojob_company(tier, checked_epoch_ms)`)

            tx.run(sql`PRAGMA user_version = 30`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 30) {
            tx.run(sql`ALTER TABLE ashbyhq_company ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0`)
            tx.run(sql`ALTER TABLE lever_company ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0`)
            tx.run(sql`ALTER TABLE greenhouse_company ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0`)
            tx.run(sql`ALTER TABLE gem_company ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0`)
            tx.run(sql`ALTER TABLE rippling_company ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0`)
            tx.run(sql`PRAGMA user_version = 31`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 31) {
            tx.run(sql`CREATE TABLE icims_company (
                name TEXT PRIMARY KEY,
                checked_epoch_ms INTEGER,
                "exists" INTEGER,
                fail_count INTEGER NOT NULL,
                tier INTEGER NOT NULL
            )`)
            tx.run(sql`CREATE TABLE icims_job (
                company_name TEXT NOT NULL,
                id TEXT NOT NULL,
                fetched_epoch_ms INTEGER NOT NULL,
                info TEXT NOT NULL,
                long_info TEXT,
                relevancy TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY(company_name, id)
            )`)
            tx.run(sql`CREATE TABLE icims_fetch_job_details (
                unique_id TEXT PRIMARY KEY,
                company_name TEXT NOT NULL,
                id TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                job_posted_after INTEGER NOT NULL,
                company_tier TEXT NOT NULL
            )`)
            tx.run(sql`CREATE INDEX icims_company_tier_checked_idx ON icims_company(tier, checked_epoch_ms)`)
            tx.run(sql`PRAGMA user_version = 32`)
        }
    })

    db.transaction((tx) => {
        const version = dbVersion(tx)
        if (version === 32) {
            tx.run(sql`delete from pending_notification`)
            tx.run(sql`ALTER TABLE pending_notification DROP COLUMN message`)
            tx.run(sql`ALTER TABLE pending_notification ADD COLUMN data TEXT NOT NULL`)
            tx.run(sql`CREATE TABLE sent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data TEXT NOT NULL,
                telegram_message TEXT NOT NULL
            )`)
            tx.run(sql`PRAGMA user_version = 33`)
        }
    })
}


function dbVersion(db: BetterSQLite3Database | SQLiteTransaction<"sync", Database.RunResult, Record<string, never>, never>) {
    return (db.get(sql`PRAGMA user_version`) as { user_version: number }).user_version
}
