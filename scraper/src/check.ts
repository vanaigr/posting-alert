import 'dotenv/config'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as D from 'drizzle-orm'

import * as Db from './lib/db.ts'
import * as T from './lib/temporal.ts'
import * as C from './common.ts'
import * as AshbyTiers from './ashbyhq/tier.ts'
import * as Lever from './lever/run.ts'
import * as Greenhouse from './greenhouse/run.ts'
import * as Bamboohr from './bamboohr/run.ts'
import * as Zohorecruit from './boards/zohorecruit.ts'
import * as Gem from './boards/gem.ts'
import * as Rippling from './boards/rippling.ts'

type CompanyParams = {
    exists: number | null
    tier: number
    checkEpochMs: number | null
    failCount: number | undefined
}

type JobParams = {
    fetchedEpochMs: number | null
    publishedEpochMs: number | null
    locationRelevant: boolean
    locationDesired: boolean
    jobRelevant: boolean
    jobDesired: boolean
}

export type PostingParams = { company: CompanyParams | undefined, job: JobParams | undefined }

function calculateCompanyParams(company: C.AnyComany | undefined): CompanyParams | undefined {
    if(!company) return

    return {
        exists: company.exists,
        tier: company.tier,
        checkEpochMs: company.checkedEpochMs,
        failCount: 'failCount' in company ? company.failCount : undefined,
    }
}
function lookupCompany(db: BetterSQLite3Database, table: C.AnyCompanyTable, companyName: string) {
    return db.select().from(table).where(D.eq(table.name, companyName)).get()
}
function lookupJob<T extends C.AnyJobTable>(db: BetterSQLite3Database, table: T, companyName: string, jobId: string) {
    return db.select().from(table)
        .where(D.and(D.eq(table.companyName, companyName), D.eq(table.id, jobId)))
        .get()
}

export function ashbyhqGetPostingParams(db: BetterSQLite3Database, companyName: string, jobId: string): PostingParams | undefined {
    return {
        company: calculateCompanyParams(lookupCompany(db, Db.aCompany, companyName)),
        job: ((): JobParams | undefined => {
            const job = lookupJob(db, Db.aJob, companyName, jobId)
            if(!job) return

            const shortInfo = JSON.parse(job.shortInfo)
            const ashbyJob = shortInfo.job
            const longInfo = job.longInfo ? JSON.parse(job.longInfo) : null
            const description: string | undefined = longInfo?.descriptionHtml ?? undefined

            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: longInfo?.publishedDate ? new Date(longInfo.publishedDate).getTime() : null,
                locationRelevant: AshbyTiers.isLocationRelevant(ashbyJob),
                locationDesired: AshbyTiers.isLocationDesired(ashbyJob),
                jobRelevant: AshbyTiers.isJobRelevant(ashbyJob.title),
                jobDesired: AshbyTiers.isJobDesired(ashbyJob.title, description),
            }
        })(),
    }
}

export function leverGetPostingParams(db: BetterSQLite3Database, companyName: string, jobId: string): PostingParams | undefined {
    return {
        company: calculateCompanyParams(lookupCompany(db, Db.lCompany, companyName)),
        job: ((): JobParams | undefined => {
            const job = lookupJob(db, Db.lJob, companyName, jobId)
            if(!job) return

            const info = JSON.parse(job.info)

            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: typeof info.createdAt === 'number' ? info.createdAt : null,
                locationRelevant: Lever.isLocationRelevant(info),
                locationDesired: Lever.isLocationDesired(info),
                jobRelevant: AshbyTiers.isJobRelevant(info.text),
                jobDesired: AshbyTiers.isJobDesired(info.text, info.descriptionPlain),
            }
        })(),
    }
}

export function greenhouseGetPostingParams(db: BetterSQLite3Database, companyName: string, jobId: string): PostingParams | undefined {
    return {
        company: calculateCompanyParams(lookupCompany(db, Db.gCompany, companyName)),
        job: ((): JobParams | undefined => {
            const job = lookupJob(db, Db.gJob, companyName, jobId)
            if(!job) return

            const info = JSON.parse(job.info)
            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: new Date(info.updated_at).getTime(),
                locationRelevant: Greenhouse.isLocationRelevant(info),
                locationDesired: Greenhouse.isLocationDesired(info),
                jobRelevant: AshbyTiers.isJobRelevant(info.title),
                jobDesired: AshbyTiers.isJobDesired(info.title, info.content),
            }
        })(),
    }
}

export function bamboohrGetPostingParams(db: BetterSQLite3Database, companyName: string, jobId: string): PostingParams | undefined {
    return {
        company: calculateCompanyParams(lookupCompany(db, Db.bamboohrCompany, companyName)),
        job: ((): JobParams | undefined => {
            const job = lookupJob(db, Db.bamboohrJob, companyName, jobId)
            if(!job) return

            const info = JSON.parse(job.info)
            const longInfo = job.longInfo ? JSON.parse(job.longInfo) : null
            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: null,
                locationRelevant: Bamboohr.isLocationRelevant(info),
                locationDesired: Bamboohr.isLocationDesired(info),
                jobRelevant: AshbyTiers.isJobRelevant(info.jobOpeningName),
                jobDesired: AshbyTiers.isJobDesired(info.jobOpeningName, longInfo?.description),
            }
        })(),
    }
}

export function zohorecruitGetPostingParams(db: BetterSQLite3Database, companyName: string, jobId: string): PostingParams | undefined {
    return {
        company: calculateCompanyParams(lookupCompany(db, Db.zohorecruitCompany, companyName)),
        job: ((): JobParams | undefined => {
            const job = lookupJob(db, Db.zohorecruitJob, companyName, jobId)
            if(!job) return

            const info = JSON.parse(job.info)
            const longInfo = job.longInfo ? JSON.parse(job.longInfo) : null
            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: null,
                locationRelevant: Zohorecruit.isLocationRelevant(info),
                locationDesired: Zohorecruit.isLocationDesired(info),
                jobRelevant: AshbyTiers.isJobRelevant(info.title),
                jobDesired: AshbyTiers.isJobDesired(info.title, longInfo?.description),
            }
        })(),
    }
}

export function gemGetPostingParams(db: BetterSQLite3Database, companyName: string, jobId: string): PostingParams | undefined {
    return {
        company: calculateCompanyParams(lookupCompany(db, Db.gemCompany, companyName)),
        job: ((): JobParams | undefined => {
            const job = lookupJob(db, Db.gemJob, companyName, jobId)
            if(!job) return

            const info: Gem.JobInfo = JSON.parse(job.info)
            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: null,
                locationRelevant: Gem.isLocationRelevant(info),
                locationDesired: Gem.isLocationDesired(info),
                jobRelevant: AshbyTiers.isJobRelevant(info.title),
                jobDesired: AshbyTiers.isJobDesired(info.title, info.descriptionHtml),
            }
        })(),
    }
}

export function ripplingGetPostingParams(db: BetterSQLite3Database, companyName: string, jobId: string): PostingParams | undefined {
    return {
        company: calculateCompanyParams(lookupCompany(db, Db.ripplingCompany, companyName)),
        job: ((): JobParams | undefined => {
            const job = lookupJob(db, Db.ripplingJob, companyName, jobId)
            if(!job) return

            const info: Rippling.JobInfo = JSON.parse(job.info)
            const longInfo: Rippling.LongInfo | null = job.longInfo ? JSON.parse(job.longInfo) : null
            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: longInfo?.createdOn ? new Date(longInfo.createdOn).getTime() : null,
                locationRelevant: Rippling.isLocationRelevant(info),
                locationDesired: Rippling.isLocationDesired(info),
                jobRelevant: AshbyTiers.isJobRelevant(info.title),
                jobDesired: AshbyTiers.isJobDesired(info.title, longInfo?.descriptionHtml),
            }
        })(),
    }
}

if(import.meta.main) {
    const [sourceArg, companyName, jobId] = process.argv.slice(2)

    if(!sourceArg || !companyName || !jobId) {
        console.error('Usage: check <ashby|lever|greenhouse|bamboo|zoho> <companyName> <jobId>')
        process.exit(1)
    }

    const db = drizzle(new Database(process.env.DB_PATH!))

    const params = (() => {
        if(sourceArg === 'ashby') {
            return ashbyhqGetPostingParams(db, companyName, jobId)
        }
        else if(sourceArg === 'lever') {
            return leverGetPostingParams(db, companyName, jobId)
        }
        else if(sourceArg === 'greenhouse') {
            return greenhouseGetPostingParams(db, companyName, jobId)
        }
        else if(sourceArg === 'bamboo') {
            return bamboohrGetPostingParams(db, companyName, jobId)
        }
        else if(sourceArg === 'zoho') {
            return zohorecruitGetPostingParams(db, companyName, jobId)
        }
        else if(sourceArg === 'gem') {
            return gemGetPostingParams(db, companyName, jobId)
        }
        else if(sourceArg === 'rippling') {
            return ripplingGetPostingParams(db, companyName, jobId)
        }
    })()
    if(params === undefined) {
        console.error('Invalid source: ', sourceArg)
        process.exit(1)
    }

    const { company, job } = params

    if(!company) {
        console.log('Company exists: NO (not in DB)')
    }
    else {
        const existsLabel = (['NO', 'YES'])[company.exists as any] ?? `UNKNOWN ${company.exists}`
        console.log('Company exists: ' + existsLabel)
        console.log('  Tier: ' + company.tier)
        console.log('  Checked at: ' + (company.checkEpochMs === null ? null : formatTime(company.checkEpochMs)))
        if(company.failCount !== undefined) console.log('  Fail count: ' + company.failCount)
    }

    if(!job) {
        console.log('Job exists: NO (not in DB)')
    }
    else {
        console.log('Job exists: YES')

        console.log('  Fetched at: ' + (job.fetchedEpochMs === null ? null : formatTime(job.fetchedEpochMs)))
        if(job.publishedEpochMs !== undefined) {
            console.log('  Published at: ' + (job.publishedEpochMs === null ? null : formatTime(job.publishedEpochMs)))
        }
        console.log('  Location relevant: ' + job.locationRelevant)
        console.log('  Location desired: ' + job.locationDesired)
        console.log('  Job relevant: ' + job.jobRelevant)
        console.log('  Job desired: ' + job.jobDesired)
    }

    function formatTime(ms: number) {
        return T.Instant.fromEpochMilliseconds(ms)
            .toZonedDateTimeISO(process.env.SEARCH_TIMEZONE!)
            .toPlainDateTime()
            .toLocaleString()
    }
}
