import Database from 'better-sqlite3'

import * as T from './temporal.ts'
import * as U from './util.ts'

type SampleRow = {
    name: string
    recorded_at: number
}

type CountKey = {
    name: string
    hourStart: number
}

export class Sampler {
    private savedCount = 0
    readonly name: string
    private readonly recordSamples: (name: string, count: number) => void

    constructor(
        name: string,
        recordSamples: (name: string, count: number) => void,
    ) {
        this.name = name
        this.recordSamples = recordSamples
    }

    get count() {
        return this.savedCount
    }

    set count(value: number) {
        if(!Number.isFinite(value)) return

        const delta = Math.trunc(value) - this.savedCount
        if(delta > 0) this.recordSamples(this.name, delta)
        this.savedCount = Math.trunc(value)
    }
}

export class SampleSaver {
    private db: Database.Database
    private insertSample: Database.Statement<[string, number]>

    constructor() {
        const dbPath = process.env.ANALYTICS_DB_PATH
        if(!dbPath) throw new Error('ANALYTICS_DB_PATH is required for analytics sampling')

        this.db = new Database(dbPath)
        this.migrate()
        this.insertSample = this.db.prepare('INSERT INTO sample (name, recorded_at, aggregated) VALUES (?, ?, 0)')
        void this.runAggregationService()
    }

    createSampler(name: string): Sampler {
        return new Sampler(name, (name, count) => this.recordSamples(name, count))
    }

    aggregateNow(now = T.Now.instant()) {
        const nowMs = Number(now.epochMilliseconds)
        const deleteBefore = Number(now.subtract({ minutes: 1 }).epochMilliseconds)
        const timezone = process.env.SEARCH_TIMEZONE
        if(!timezone) throw new Error('SEARCH_TIMEZONE is required for analytics aggregation')

        this.db.transaction(() => {
            const samples = this.db.prepare(`
                SELECT name, recorded_at
                FROM sample
                WHERE aggregated = 0 AND recorded_at <= ?
            `).all(nowMs) as SampleRow[]

            const counts = new Map<string, { key: CountKey, samples: number }>()
            for(const sample of samples) {
                const hourStart = hourStartEpochMs(sample.recorded_at, timezone)
                const rawKey = `${sample.name}\0${hourStart}`
                const existing = counts.get(rawKey)
                if(existing) {
                    existing.samples++
                }
                else {
                    counts.set(rawKey, {
                        key: { name: sample.name, hourStart },
                        samples: 1,
                    })
                }
            }

            const upsertStats = this.db.prepare(`
                INSERT INTO statistics (name, hour_start, samples)
                VALUES (?, ?, ?)
                ON CONFLICT(name, hour_start) DO UPDATE SET samples = samples + excluded.samples
            `)
            for(const { key, samples } of counts.values()) {
                upsertStats.run(key.name, key.hourStart, samples)
            }

            this.db.prepare(`
                UPDATE sample
                SET aggregated = 1
                WHERE aggregated = 0 AND recorded_at <= ?
            `).run(nowMs)

            this.db.prepare('DELETE FROM sample WHERE recorded_at < ?').run(deleteBefore)
        })()
    }

    private recordSamples(name: string, count: number) {
        const recordedAt = Number(T.Now.instant().epochMilliseconds)
        const transaction = this.db.transaction(() => {
            for(let i = 0; i < count; i++) {
                this.insertSample.run(name, recordedAt)
            }
        })
        transaction()
    }

    private migrate() {
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS sample (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                recorded_at INTEGER NOT NULL,
                aggregated INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS sample_aggregated_recorded_at_idx
                ON sample(aggregated, recorded_at);

            CREATE INDEX IF NOT EXISTS sample_recorded_at_idx
                ON sample(recorded_at);

            CREATE TABLE IF NOT EXISTS statistics (
                name TEXT NOT NULL,
                hour_start INTEGER NOT NULL,
                samples INTEGER NOT NULL,
                PRIMARY KEY(name, hour_start)
            );
        `)
    }

    private async runAggregationService() {
        while(true) {
            await U.delay(T.Now.instant().add({ minutes: 1 }))
            try {
                this.aggregateNow()
            }
            catch(err) {
                console.error('Analytics aggregation failed', err)
            }
        }
    }
}

function hourStartEpochMs(epochMs: number, timezone: string) {
    const instant = T.Instant.fromEpochMilliseconds(epochMs)
    return Number(T.startOfHour(instant.toZonedDateTimeISO(timezone)).toInstant().epochMilliseconds)
}
