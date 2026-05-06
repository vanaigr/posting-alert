import fs from 'node:fs'
import path from 'node:path'

import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as N from '../lib/network.ts'
import * as AshbyTiers from '../ashbyhq/tier.ts'

const { gCompany: Company, gJob: Job } = Db

const quota = 5

export async function run(db: BetterSQLite3Database, mainLog: L.Log) {
    ;(() => {
        const companyNames: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'companyNames.json')).toString())

        for(let i = 0; i < companyNames.length; i += 3000) {
            const toInsert = companyNames
                .slice(i, i + 3000)
                .map(it => ({ name: it, checkedEpochMs: null, exists: null }))

            db.insert(Company)
                .values(toInsert)
                .onConflictDoNothing()
                .execute()
        }
        mainLog.I('Populated companies')
    })()

    const companiesInProcess = new Set<string>()
    let rateLimit = false

    U.evaluateTiers(mainLog, db, Company, Job, calculateTier)

    const connection = N.createConnection('https://boards-api.greenhouse.io', { connections: 30 })

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false
        while(companiesInProcess.size > 20) {
            mainLog.I('Stalling because ', [companiesInProcess.size], ' is pending')
            await U.delay(T.Now.instant().add({ seconds: 5 }))
        }

        mainLog.I('Tick (', [companiesInProcess.size], ' pending)')
        const nextTick = T.Now.instant().add({ seconds: 1 })

        const toCheck = (() => {
            const companiesToSkip = [...companiesInProcess, ...U.bannedCompanies]

            const overnightInfo = U.getOvernightInfo()
            if(overnightInfo.isOvernight) {
                const other = db.select().from(Company)
                    .where(D.and(
                        D.eq(Company.exists, 1),
                        D.eq(Company.tier, 3),
                        D.not(D.inArray(Company.name, companiesToSkip)),
                    ))
                    .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
                    .limit(quota)
                    .all()

                if(other.length !== 0 && (other[0].checkedEpochMs === null || other[0].checkedEpochMs < overnightInfo.overnightBegin)) {
                    return { desired: [], relevant: [], other }
                }
            }

            const desired = db.select().from(Company)
                .where(D.and(
                    D.or(
                        D.isNull(Company.exists),
                        D.and(
                            D.eq(Company.exists, 1),
                            D.eq(Company.tier, 1),
                        ),
                    ),
                    D.not(D.inArray(Company.name, companiesToSkip)),
                ))
                .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
                .limit(quota)
                .all()
            const relevant = db.select().from(Company)
                .where(D.and(
                    D.eq(Company.exists, 1),
                    D.eq(Company.tier, 2),
                    D.not(D.inArray(Company.name, companiesToSkip)),
                ))
                .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
                .limit(quota)
                .all()

            const tiersCounts = U.selectCompanies([desired, relevant], [0.5, 0.25], quota)
            desired.length = tiersCounts[0]
            relevant.length = tiersCounts[1]

            return { desired, relevant, other: [] as D.InferSelectModel<typeof Company>[] }
        })()

        mainLog.I(
            'Checking: ',
            [toCheck.desired.length], ', ',
            [toCheck.relevant.length], ', ',
            [toCheck.other.length], ', ',
        )

        const currentTime = Date.now()
        const handleCompanny = async(company: D.InferSelectModel<typeof Company>, tier: string) => {
            const log = mainLog.addedCtx(company.name)

            try {
                companiesInProcess.add(company.name)
                const result = await checkCompany(db, log, currentTime, connection, company, tier)
                if(result.status === 'rate-limit') rateLimit = true
            }
            catch(err) {
                log.E('While checking: ', [err])
            }
            finally {
                companiesInProcess.delete(company.name)
            }
        }

        for(const it of toCheck.desired) handleCompanny(it, 'I')
        for(const it of toCheck.relevant) handleCompanny(it, 'II')
        for(const it of toCheck.other) handleCompanny(it, 'III')

        await U.delay(nextTick)
    }
}

async function checkCompany(
    db: BetterSQLite3Database,
    log: L.Log,
    currentTime: number,
    connection: N.Connection,
    company: D.InferSelectModel<typeof Company>,
    tier: string,
) {
    const result = await requestCompany(log, connection, company.name)
    if(result.status === 'rate-limit') return result

    db.update(Company)
        .set({ checkedEpochMs: currentTime })
        .where(D.eq(Company.name, company.name))
        .run()

    if(result.status === 'not-found') {
        log.I('Company does not exist')

        db.update(Company)
            .set({ exists: 0 })
            .where(D.eq(Company.name, company.name))
            .run()
        return U.status('ok')
    }

    if(result.status !== 'ok') return U.status('ok')

    const initial = company.exists === null

    const existingJobsRows = db.select()
        .from(Job)
        .where(D.eq(Job.companyName, company.name))
        .all()
    const existingJobs = new Set(existingJobsRows.map(it => it.id))

    const toInsert: D.InferSelectModel<typeof Job>[] = []
    const promises: Promise<void>[] = []
    for(const job of result.data) {
        const id = String(job.id)
        if(existingJobs.has(id)) continue

        toInsert.push({
            id,
            companyName: company.name,
            fetchedEpochMs: currentTime,
            info: JSON.stringify(job),
        })

        if(!initial) {
            log.I('New job ', [id])
            if(AshbyTiers.isJobDesired(job.title, job.content) && isLocationDesired(job)) {
                log.I('Job ', id, ' is relevant!')

                const ago = U.millisecToDurationString(Date.now() - (new Date(job.updated_at).getTime() || 0))

                promises.push(U.sendMessage(
                    log.addedCtx('job ', [id]),
                    db,
                    job.title + ' @ ' + company.name + '\n'
                        + (job.location?.name ?? '') + '\n'
                        + `GH ${tier} ${ago} ago: ` + job.absolute_url,
                ))
            }
        }
    }

    await Promise.allSettled(promises)

    const newTier = toInsert.length > 0
        ? calculateTier(company, [...existingJobsRows, ...toInsert])
        : null

    db.transaction(db => {
        db.update(Company)
            .set({ exists: 1, ...(newTier !== null ? { tier: newTier } : {}) })
            .where(D.eq(Company.name, company.name))
            .run()
        if(toInsert.length > 0) {
            db.insert(Job).values(toInsert).run()
        }
    })

    if(initial) {
        log.I('Found ', [toInsert.length], ' jobs')
    }
    else {
        log.I('Found ', [toInsert.length], ' new jobs')
    }

    return U.status('ok')
}

async function requestCompany(log: L.Log, connection: N.Connection, companyName: string) {
    try {
        // https://github.com/grnhse/greenhouse-api-docs/blob/2e9f2d8a573a6843c838cd5f4050f57f23f0494d/source/includes/job-board/_jobs.md?plain=1#L1
        const response = await N.fetch(connection, {
            method: 'GET',
            path: '/v1/boards/' + encodeURIComponent(companyName) + '/jobs?content=true',
        })
        if(response.statusCode === 429) {
            log.E('Rate limited')
            await response.body.text().catch(() => {})
            return U.status('rate-limit')
        }
        if(response.statusCode === 404) {
            await response.body.text().catch(() => {})
            return U.status('not-found')
        }

        if(response.statusCode !== 200) {
            log.E('Request failed: ', [response.statusCode], ': ', [await response.body.text().catch(err => err)])
            return U.status('error')
        }

        const json = await response.body.json() as { jobs: Job[] }
        return U.result('ok', json.jobs)
    }
    catch(err) {
        log.E('While requesting: ', [err])
        return U.status('error')
    }
}

type Job = {
    id: number
    internal_job_id: number | null
    title: string
    updated_at: string
    requisition_id?: string
    location: { name: string }
    absolute_url: string
    language?: string
    metadata: unknown
    content?: string // html
    departments?: { id: number; name: string; parent_id: number | null; child_ids: number[] }[]
    offices?: { id: number; name: string; location: string; parent_id: number | null; child_ids: number[] }[]
}

// NOTE: if this is changed, add a migration that resets tiers for the companies.
function isLocationRelevant(job: { location: { name: string }, content?: string }) {
    const location = job.location.name
    const content = job.content
    if(!location) {
        return true
    }

    const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location)
    const mentionsUsConcrete = AshbyTiers.citiesStatesRegex1.test(location) || AshbyTiers.citiesStatesRegex2.test(location)
    const isRemote = /(remote|nationwide|continental)/i.test(location) || (content && /remote/i.test(content))
    const isRemoteInUs = isRemote && (mentionsUs || mentionsUsConcrete)
    const isRemoteWorldwide = location.toLowerCase() === 'remote'

    return mentionsUs || mentionsUsConcrete || isRemoteInUs || isRemoteWorldwide
}

function isLocationDesired(job: { location: { name: string }, content?: string }) {
    const location = job.location.name
    const content = job.content
    if(!location) {
        console.log('missing location for', job)
        return true
    }
    if(!content) {
        // This is not supposed to happen because this is only used for new jobs,
        // and all new jobs are fetched with content.
        console.log('Missing content for', job)
    }

    const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location)
    const mentionsUsConcrete = AshbyTiers.citiesStatesRegex1.test(location) || AshbyTiers.citiesStatesRegex2.test(location)
    const isRemote = /(remote|nationwide|continental)/i.test(location) || (content && /remote/i.test(content))
    const isRemoteInUs = isRemote && (mentionsUs || mentionsUsConcrete)
    const isRemoteWorldwide = location.toLowerCase() === 'remote'
    const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)

    return isRemoteInUs || isRemoteWorldwide || isMyLocal
}

function calculateTier(
    _company: D.InferSelectModel<typeof Company>,
    jobs: D.InferSelectModel<typeof Job>[],
): number {
    let hasRelevantLocation = false
    for(const job of jobs) {
        const info: Job | null = JSON.parse(job.info ?? 'null')
        if(!info) continue
        if(!isLocationRelevant(info)) continue
        hasRelevantLocation = true
        if(AshbyTiers.isJobRelevant(info.title)) return 1
    }
    return hasRelevantLocation ? 2 : 3
}
