import fs from 'node:fs'
import path from 'node:path'

import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as N from '../lib/network.ts'
import { isTitleRelevant, isTitleDesired } from '../ashbyhq/tier.ts'

const { lCompany: Company, lJob: Job } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log) {
    ;(() => {
        const companyNames: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'companyNames.json')).toString())

        db.insert(Company)
            .values(companyNames.map(it => ({ name: it, checkedEpochMs: null, exists: null })))
            .onConflictDoNothing()
            .execute()
        mainLog.I('Populated companies')
    })

    let tiers: Tiers = calculateTiers(db)
    mainLog.I('Tiers: ', [tiers.desiredCompanies.length], ', ', [tiers.relevantCompanies.length])
    setInterval(() => {
        mainLog.I('Updating company tiers')
        tiers = calculateTiers(db)
        mainLog.I('Tiers: ', [tiers.desiredCompanies.length], ', ', [tiers.relevantCompanies.length])
    }, 30 * 60 * 1000)


}

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
    const mainLog = L.makeLogger(process.env.LOG_PATH || undefined, undefined)

    const db = drizzle(new Database(process.env.ASHBYHQ_DB_PATH!))
    Db.migrate(db)

await run(db, mainLog)

type Tiers = {
    desiredCompanies: string[]
    relevantCompanies: string[]
}
function calculateTiers(db: BetterSQLite3Database) {
    const relevantJobsByCompany = new Map<string, Job[]>()

    for(const job of db.select().from(Job).all()) {
        const info: JobInfo | null = JSON.parse(job.info ?? 'null')
        if(!info) continue
        if(!isTitleRelevant(info.text) || !isLocationRelevant(info)) continue

        const jobs = (relevantJobsByCompany.get(job.companyName) ?? [])
        jobs.push({ ...job, info })
        relevantJobsByCompany.set(job.companyName, jobs)
    }

    const desiredCompanies: string[] = []
    const relevantCompanies: string[] = []

    for(const [companyName, relevantJobs] of relevantJobsByCompany) {
        const desired = relevantJobs.find(it => {
            return isTitleDesired(it.info.text) && isLocationDesired(it.info)
        })
        if(desired !== undefined) {
            desiredCompanies.push(companyName)
        }
        else {
            relevantCompanies.push(companyName)
        }
    }

    return {
        desiredCompanies,
        relevantCompanies,
    }
}

function isLocationRelevant(info: JobInfo) {
    return info.country === 'US'
}
function isLocationDesired(info: JobInfo) {
    return info.categories.allLocations.some(location => {
        const isRemote = /(remote|nationwide)/i.test(location) || info.workplaceType === 'remote'
        const isRemoteInUs = (isRemote && info.country === 'US')
        const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)

        return isRemoteInUs || isMyLocal
    })
}

type Job = {
    id: string
    companyName: string
    fetchedEpochMs: number
    info: JobInfo
}

type JobInfo = {
    //applyUrl: string
    categories: {
        allLocations: string[]
        commitment: string
        department: string
        location: string
        team: string
    }
    country: string // 2 letter country code
    createdAt: number // epoch ms
    hostedUrl: string
    text: string // title
    workplaceType: string
}
