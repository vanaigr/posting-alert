import 'dotenv/config'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as D from 'drizzle-orm'

import * as Db from './lib/db.ts'
import * as T from './lib/temporal.ts'
import * as AshbyTiers from './ashbyhq/tier.ts'
import * as Lever from './lever/run.ts'
import * as Greenhouse from './greenhouse/run.ts'
import * as Bamboohr from './bamboohr/run.ts'
import * as Zohorecruit from './zohorecruit.ts'

type Source = 'ashby' | 'lever' | 'greenhouse' | 'bamboo' | 'zoho'

const [sourceArg, companyName, id] = process.argv.slice(2)

if(!sourceArg || !companyName || !id) {
    console.error('Usage: check <ashby|lever|greenhouse|bamboo|zoho> <companyName> <id>')
    process.exit(1)
}

const validSources: Source[] = ['ashby', 'lever', 'greenhouse', 'bamboo', 'zoho']
if(!(validSources as string[]).includes(sourceArg)) {
    console.error('Invalid source: ', sourceArg)
    process.exit(1)
}
const source = sourceArg as Source

const db = drizzle(new Database(process.env.DB_PATH!))

function formatTime(ms: number) {
    return T.Instant.fromEpochMilliseconds(ms)
        .toZonedDateTimeISO(process.env.SEARCH_TIMEZONE!)
        .toPlainDateTime()
        .toLocaleString()
}

function lookupCompany(table: any) {
    return db.select().from(table).where(D.eq(table.name, companyName)).get() as any
}

function reportCompany(company: any) {
    if(!company) {
        console.log('Company exists: NO (not in DB)')
        return false
    }
    const existsLabel = company.exists === 1 ? 'YES'
        : company.exists === 0 ? 'NO'
        : 'UNKNOWN'
    console.log('Company exists: ' + existsLabel)
    for(const [k, v] of Object.entries(company)) {
        if(k === 'name' || k === 'exists') continue
        if(k === 'checkedEpochMs' && typeof v === 'number') {
            console.log('  ' + k + ': ' + v + ' (' + formatTime(v) + ')')
        } else {
            console.log('  ' + k + ': ' + v)
        }
    }
    return true
}

function reportJob(job: any) {
    if(!job) {
        console.log('Job exists: NO (not in DB)')
        return false
    }
    console.log('Job exists: YES')
    if(job.fetchedEpochMs != null) {
        console.log('Fetched at: ' + formatTime(job.fetchedEpochMs))
    } else {
        console.log('Fetched at: <missing>')
    }
    return true
}

function reportRelevance(opts: {
    title: string,
    description: string | undefined,
    isLocationRelevant: boolean,
    isLocationDesired: boolean,
}) {
    console.log('Location relevant: ' + opts.isLocationRelevant)
    console.log('Location desired: ' + opts.isLocationDesired)
    console.log('Job relevant: ' + AshbyTiers.isJobRelevant(opts.title))
    console.log('Job desired: ' + AshbyTiers.isJobDesired(opts.title, opts.description))
}


if(source === 'ashby') {
    const company = lookupCompany(Db.aCompany)
    if(!reportCompany(company)) process.exit(0)

    const job = db.select().from(Db.aJob)
        .where(D.and(D.eq(Db.aJob.id, id), D.eq(Db.aJob.companyName, companyName)))
        .get()
    if(!reportJob(job)) process.exit(0)

    const shortInfo = JSON.parse(job!.shortInfo)
    const ashbyJob = shortInfo.job
    const longInfo = job!.longInfo ? JSON.parse(job!.longInfo) : null
    const description: string | undefined = longInfo?.descriptionHtml ?? undefined
    reportRelevance({
        title: ashbyJob.title,
        description,
        isLocationRelevant: AshbyTiers.isLocationRelevant(ashbyJob),
        isLocationDesired: AshbyTiers.isLocationDesired(ashbyJob),
    })
}
else if(source === 'lever') {
    const company = lookupCompany(Db.lCompany)
    if(!reportCompany(company)) process.exit(0)

    const job = db.select().from(Db.lJob)
        .where(D.and(D.eq(Db.lJob.id, id), D.eq(Db.lJob.companyName, companyName)))
        .get()
    if(!reportJob(job)) process.exit(0)

    const info = JSON.parse(job!.info)
    reportRelevance({
        title: info.text,
        description: info.descriptionPlain,
        isLocationRelevant: Lever.isLocationRelevant(info),
        isLocationDesired: Lever.isLocationDesired(info),
    })
}
else if(source === 'greenhouse') {
    const company = lookupCompany(Db.gCompany)
    if(!reportCompany(company)) process.exit(0)

    const job = db.select().from(Db.gJob)
        .where(D.and(D.eq(Db.gJob.id, id), D.eq(Db.gJob.companyName, companyName)))
        .get()
    if(!reportJob(job)) process.exit(0)

    const info = JSON.parse(job!.info)
    reportRelevance({
        title: info.title,
        description: info.content,
        isLocationRelevant: Greenhouse.isLocationRelevant(info),
        isLocationDesired: Greenhouse.isLocationDesired(info),
    })
}
else if(source === 'bamboo') {
    const company = lookupCompany(Db.bamboohrCompany)
    if(!reportCompany(company)) process.exit(0)

    const job = db.select().from(Db.bamboohrJob)
        .where(D.and(D.eq(Db.bamboohrJob.id, id), D.eq(Db.bamboohrJob.companyName, companyName)))
        .get()
    if(!reportJob(job)) process.exit(0)

    const info = JSON.parse(job!.info)
    const longInfo = job!.longInfo ? JSON.parse(job!.longInfo) : null
    reportRelevance({
        title: info.jobOpeningName,
        description: longInfo?.description,
        isLocationRelevant: Bamboohr.isLocationRelevant(info),
        isLocationDesired: Bamboohr.isLocationDesired(info),
    })
}
else if(source === 'zoho') {
    const company = lookupCompany(Db.zohorecruitCompany)
    if(!reportCompany(company)) process.exit(0)

    const job = db.select().from(Db.zohorecruitJob)
        .where(D.and(D.eq(Db.zohorecruitJob.id, id), D.eq(Db.zohorecruitJob.companyName, companyName)))
        .get()
    if(!reportJob(job)) process.exit(0)

    const info = JSON.parse(job!.info)
    const longInfo = job!.longInfo ? JSON.parse(job!.longInfo) : null
    reportRelevance({
        title: info.title,
        description: longInfo?.description,
        isLocationRelevant: Zohorecruit.isLocationRelevant(info),
        isLocationDesired: Zohorecruit.isLocationDesired(info),
    })
}

process.exit(0)
