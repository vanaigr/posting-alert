import Database from 'better-sqlite3'
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as D from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

import * as T from './temporal.ts'
import * as U from './util.ts'
import * as L from './log.ts'

export class Analytics {
    private readonly db: BetterSQLite3Database
    private readonly log: L.Log
    private readonly timezone: string

    constructor(p: { log: L.Log, dbPath: string, timezone: string }) {
        this.log = p.log
        this.db = drizzle(new Database(p.dbPath))
        this.timezone = p.timezone
        migrate(this.db)
    }

    createSampler(name: string): Sampler {
        return new Sampler(name, (name) => this.recordSample(name))
    }

    private recordSample(name: string) {
        this.db.insert(samples)
            .values({
                recordedAt: T.Now.instant().epochMilliseconds,
                name,
                aggregated: 0,
            })
            .run()
    }

    async run() {
        while(true) {
            try {
                this.log.I('Running')
                aggregateSamples(this.log, this.db, this.timezone)
            }
            catch(err) {
                this.log.E('Analytics aggregation failed: ', [err])
            }
            await U.delay(T.Now.instant().add({ minutes: 1 }))
        }
    }
}

export class Sampler {
    readonly name: string
    private readonly recordSample: (name: string) => void

    constructor(name: string, recordSamples: (name: string) => void) {
        this.name = name
        this.recordSample = recordSamples
    }

    sample() {
        this.recordSample(this.name)
    }
}

function aggregateSamples(log: L.Log, db: BetterSQLite3Database, timezone: string) {
    db.transaction(db => {
        const now = Date.now()
        const deleteBefore = now - 65 * 1000

        const sampleList = db.select().from(samples).all()
        log.I('Found ', [sampleList.length], ' samples')

        const toDelete: number[] = []
        const toMarkAggregated: number[] = []
        const toAdd = new Map<string, { hourStart: number, name: string, count: number }>()
        for(const sample of sampleList) {
            if(sample.recordedAt <= deleteBefore) {
                toDelete.push(sample.id)
            }

            if(!sample.aggregated) {
                toMarkAggregated.push(sample.id)

                const hourStart = T.startOfHour(T.Instant.fromEpochMilliseconds(sample.recordedAt).toZonedDateTimeISO(timezone)).toInstant().epochMilliseconds
                const hash = U.getHash(hourStart, sample.name)
                let record = toAdd.get(hash)
                if(record === undefined) {
                    record = { hourStart, name: sample.name, count: 0 }
                    toAdd.set(hash, record)
                }
                record.count++
            }
        }

        log.I('Deleting ', [toDelete.length], ' samples, aggregating ', [toMarkAggregated.length], ' samples into ', [toAdd.size], ' buckets')

        db.delete(samples).where(D.inArray(samples.id, toDelete)).run()
        db.update(samples).set({ aggregated: 1 }).where(D.inArray(samples.id, toMarkAggregated)).run()

        for(const p of toAdd.values()) {
            db.insert(statistics)
                .values({ hourStart: p.hourStart, name: p.name, count: p.count })
                .onConflictDoUpdate({
                    target: [statistics.hourStart, statistics.name],
                    set: {
                        count: D.sql<number>`${statistics.count} + ${p.count}`,
                    },
                })
                .run()
        }
    })
}

export const samples = sqliteTable(
    'samples',
    {
        id: integer('id').primaryKey({ autoIncrement: true }),
        recordedAt: integer('recorded_at').notNull(),
        name: text('name').notNull(),
        aggregated: integer('aggregated').notNull(),
    },
)
export const statistics = sqliteTable(
    'statistics',
    {
        hourStart: integer('hour_start').notNull(),
        name: text('name').notNull(),
        count: integer('count').notNull(),
    },
    (t) => [primaryKey({ columns: [t.hourStart, t.name] })],
)

function migtation(
    db: BetterSQLite3Database,
    version: number | [from: number, to: number],
    migrate: () => void,
) {
    const fromVersion = typeof version === 'number' ? version : version[0]
    const toVersion = typeof version === 'number' ? version + 1 : version[1]

    const currentVersion = (db.get(D.sql`PRAGMA user_version`) as { user_version: number }).user_version
    if(currentVersion === fromVersion) {
        migrate()
        db.run(/*D.sql (sic)*/`PRAGMA user_version = ${toVersion}`)
    }

}
function migrate(db: BetterSQLite3Database) {
    db.transaction(db => {

        migtation(db, 0, () => {
            db.run(D.sql`
create table samples(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at INTEGER NOT NULL,
    name TEXT NOT NULL,
    aggregated INTEGER NOT NULL
)
`)
            db.run(D.sql`
create table statistics(
    hour_start INTEGER NOT NULL,
    name TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY(hour_start, name)
)
`)

            db.run(D.sql`create index samples_recorded_at on samples(recorded_at)`)
        })

    })
}
