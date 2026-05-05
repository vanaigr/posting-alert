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

export async function run(db: BetterSQLite3Database, mainLog: L.Log) {
    ;(() => {
        const companyNames: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'companyNames.json')).toString())

        db.insert(Company)
            .values(companyNames.map(it => ({ name: it, checkedEpochMs: null, exists: null })))
            .onConflictDoNothing()
            .execute()
        mainLog.I('Populated companies')
    })()

    const companiesInProcess = new Set<string>()
    let rateLimit = false

    let tiers: Tiers = calculateTiers(db)
    mainLog.I('Tiers: ', [tiers.desiredCompanies.length], ', ', [tiers.relevantCompanies.length])
    setInterval(() => {
        mainLog.I('Updating company tiers')
        tiers = calculateTiers(db)
        mainLog.I('Tiers: ', [tiers.desiredCompanies.length], ', ', [tiers.relevantCompanies.length])
    }, 30 * 60 * 1000)

    const connection = N.createConnection('https://boards-api.greenhouse.io', { connections: 10, pipelining: 5 })

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false

        mainLog.I('Tick (', [companiesInProcess.size], ' pending)')
        const nextTick = T.Now.instant().add({ seconds: 1 })

        const companiesToSkip = [...companiesInProcess, ...U.bannedCompanies]
        const quota = 5
        const desiredCompaniesToCheck = db.select().from(Company)
            .where(D.and(
                D.or(
                    D.isNull(Company.exists),
                    D.and(
                        D.eq(Company.exists, 1),
                        D.inArray(Company.name, tiers.desiredCompanies),
                    ),
                ),
                D.not(D.inArray(Company.name, companiesToSkip)),
            ))
            .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
            .limit(quota)
            .all()
        const relevantCompaniesToCheck = db.select().from(Company)
            .where(D.and(
                D.eq(Company.exists, 1),
                D.inArray(Company.name, tiers.relevantCompanies),
                D.not(D.inArray(Company.name, companiesToSkip)),
            ))
            .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
            .limit(quota)
            .all()
        const otherCompaniesToCheck = db.select().from(Company)
            .where(D.and(
                D.eq(Company.exists, 1),
                D.not(D.inArray(Company.name, tiers.desiredCompanies)),
                D.not(D.inArray(Company.name, tiers.relevantCompanies)),
                D.not(D.inArray(Company.name, companiesToSkip)),
            ))
            .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
            .limit(quota)
            .all()

        const tiersCounts = U.selectCompanies(
            [desiredCompaniesToCheck, relevantCompaniesToCheck, otherCompaniesToCheck],
            [0.5, 0.25, 0.25],
            quota,
        )
        desiredCompaniesToCheck.length = tiersCounts[0]
        relevantCompaniesToCheck.length = tiersCounts[1]
        otherCompaniesToCheck.length = tiersCounts[2]

        mainLog.I(
            'Checking: ',
            [desiredCompaniesToCheck.length], ', ',
            [relevantCompaniesToCheck.length], ', ',
            [otherCompaniesToCheck.length], ', ',
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

        for(const it of desiredCompaniesToCheck) handleCompanny(it, 'I')
        for(const it of relevantCompaniesToCheck) handleCompanny(it, 'II')
        for(const it of otherCompaniesToCheck) handleCompanny(it, 'III')

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

    const existingJobs = new Set(
        db.select()
            .from(Job)
            .where(D.eq(Job.companyName, company.name))
            .all()
            .map(it => it.id)
    )

    const toInsert: D.InferSelectModel<typeof Job>[] = []
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

                U.sendMessage(
                    log.addedCtx('job ', [id]),
                    job.title + ' @ ' + company.name + '\n'
                        + (job.location?.name ?? '') + '\n'
                        + `GH ${tier} ${ago} ago: ` + job.absolute_url,
                )
            }
        }
    }

    db.transaction(db => {
        db.update(Company)
            .set({ exists: 1 })
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

function isLocationRelevant(job: { location: { name: string }, content?: string }) {
    const location = job.location.name
    const content = job.content
    if(!location) {
        console.log('missing location for', job)
        return true
    }

    const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location)
    const mentionsUsConcrete = AshbyTiers.citiesStatesRegex1.test(location) || AshbyTiers.citiesStatesRegex2.test(location)
    const isRemote = /(remote|nationwide|continental)/i.test(location) || (content && /remote/i.test(content))
    const isRemoteInUs = isRemote && (mentionsUs || mentionsUsConcrete)

    return mentionsUs || mentionsUsConcrete || isRemoteInUs
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
    const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)

    return isRemoteInUs || isMyLocal
}

type Tiers = {
    desiredCompanies: string[]
    relevantCompanies: string[]
}
function calculateTiers(db: BetterSQLite3Database): Tiers {
    const relevantJobsByCompany = new Map<string, Job[]>()

    for(const job of db.select().from(Job).all()) {
        const info: Job | null = JSON.parse(job.info ?? 'null')
        if(!info) continue
        if(!isLocationRelevant(info)) continue

        const jobs = (relevantJobsByCompany.get(job.companyName) ?? [])
        jobs.push(info)
        relevantJobsByCompany.set(job.companyName, jobs)
    }

    const desiredCompanies: string[] = []
    const relevantCompanies: string[] = []

    for(const [companyName, relevantJobs] of relevantJobsByCompany) {
        const desired = relevantJobs.find(it => AshbyTiers.isJobRelevant(it.title))
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
