import 'dotenv/config'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as D from 'drizzle-orm'

import * as Db from './lib/db.ts'
import * as T from './lib/temporal.ts'
import * as C from './common.ts'
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
    jobDesired: boolean | undefined
    locationRelevant: boolean | undefined
    jobRelevant: boolean | undefined
    locationDesired: boolean | undefined
    processedJobDesired: boolean | undefined
    processedLocationDesired: boolean | undefined
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
function lookupCompany(db: Db.Database, table: C.AnyCompanyTable, companyName: string) {
    return db.select().from(table).where(D.eq(table.name, companyName)).get()
}
function lookupJob<T extends C.AnyJobTable>(db: Db.Database, table: T, companyName: string, jobId: string) {
    return db.select().from(table)
        .where(D.and(D.eq(table.companyName, companyName), D.eq(table.id, jobId)))
        .get()
}

export async function ashbyhqGetPostingParams(db: Db.Database, companyName: string, jobId: string): Promise<PostingParams | undefined> {
    return {
        company: calculateCompanyParams(await lookupCompany(db, Db.aCompany, companyName)),
        job: await (async(): Promise<JobParams | undefined> => {
            const job = await lookupJob(db, Db.aJob, companyName, jobId)
            if(!job) return

            const longInfo = job.longInfo ? JSON.parse(job.longInfo) : null

            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: longInfo?.publishedDate ? new Date(longInfo.publishedDate).getTime() : null,
                ...unpackRelevancy(job.relevancy),
            }
        })(),
    }
}

export async function leverGetPostingParams(db: Db.Database, companyName: string, jobId: string): Promise<PostingParams | undefined> {
    return {
        company: calculateCompanyParams(await lookupCompany(db, Db.lCompany, companyName)),
        job: await (async(): Promise<JobParams | undefined> => {
            const job = await lookupJob(db, Db.lJob, companyName, jobId)
            if(!job) return

            const info = JSON.parse(job.info)

            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: typeof info.createdAt === 'number' ? info.createdAt : null,
                ...unpackRelevancy(job.relevancy),
            }
        })(),
    }
}

export async function greenhouseGetPostingParams(db: Db.Database, companyName: string, jobId: string): Promise<PostingParams | undefined> {
    return {
        company: calculateCompanyParams(await lookupCompany(db, Db.gCompany, companyName)),
        job: await (async(): Promise<JobParams | undefined> => {
            const job = await lookupJob(db, Db.gJob, companyName, jobId)
            if(!job) return

            const info = JSON.parse(job.info)
            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: new Date(info.updated_at).getTime(),
                ...unpackRelevancy(job.relevancy),
            }
        })(),
    }
}

export async function bamboohrGetPostingParams(db: Db.Database, companyName: string, jobId: string): Promise<PostingParams | undefined> {
    return {
        company: calculateCompanyParams(await lookupCompany(db, Db.bamboohrCompany, companyName)),
        job: await (async(): Promise<JobParams | undefined> => {
            const job = await lookupJob(db, Db.bamboohrJob, companyName, jobId)
            if(!job) return

            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: null,
                ...unpackRelevancy(job.relevancy),
            }
        })(),
    }
}

export async function zohorecruitGetPostingParams(db: Db.Database, companyName: string, jobId: string): Promise<PostingParams | undefined> {
    return {
        company: calculateCompanyParams(await lookupCompany(db, Db.zohorecruitCompany, companyName)),
        job: await (async(): Promise<JobParams | undefined> => {
            const job = await lookupJob(db, Db.zohorecruitJob, companyName, jobId)
            if(!job) return

            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: null,
                ...unpackRelevancy(job.relevancy),
            }
        })(),
    }
}

export async function gemGetPostingParams(db: Db.Database, companyName: string, jobId: string): Promise<PostingParams | undefined> {
    return {
        company: calculateCompanyParams(await lookupCompany(db, Db.gemCompany, companyName)),
        job: await (async(): Promise<JobParams | undefined> => {
            const job = await lookupJob(db, Db.gemJob, companyName, jobId)
            if(!job) return

            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: null,
                ...unpackRelevancy(job.relevancy),
            }
        })(),
    }
}

export async function applytojobGetPostingParams(db: Db.Database, companyName: string, jobId: string): Promise<PostingParams | undefined> {
    return {
        company: calculateCompanyParams(await lookupCompany(db, Db.applytojobCompany, companyName)),
        job: await (async(): Promise<JobParams | undefined> => {
            const job = await lookupJob(db, Db.applytojobJob, companyName, jobId)
            if(!job) return

            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: null,
                ...unpackRelevancy(job.relevancy),
            }
        })(),
    }
}

export async function ripplingGetPostingParams(db: Db.Database, companyName: string, jobId: string): Promise<PostingParams | undefined> {
    return {
        company: calculateCompanyParams(await lookupCompany(db, Db.ripplingCompany, companyName)),
        job: await (async(): Promise<JobParams | undefined> => {
            const job = await lookupJob(db, Db.ripplingJob, companyName, jobId)
            if(!job) return

            const longInfo: Rippling.LongInfo | null = job.longInfo ? JSON.parse(job.longInfo) : null
            return {
                fetchedEpochMs: job.fetchedEpochMs,
                publishedEpochMs: longInfo?.createdOn ? new Date(longInfo.createdOn).getTime() : null,
                ...unpackRelevancy(job.relevancy),
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

    const db = drizzle(Db.serializeClient(createClient({ url: 'file:' + process.env.DB_PATH! })))

    const params = await (() => {
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
        else if(sourceArg === 'applytojob') {
            return applytojobGetPostingParams(db, companyName, jobId)
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

function unpackRelevancy(relevancy: string) {
    const r = JSON.parse(relevancy)
    return {
    jobRelevant: r.jr,
    locationRelevant: r.lr,
    jobDesired: r.jd,
    locationDesired: r.ld,
    processedJobDesired: r.pjd,
    processedLocationDesired: r.pld,

    }
}
