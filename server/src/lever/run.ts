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

const { lCompany: Company, lJob: Job } = Db

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

    U.evaluateTiers(db, Company, Job, calculateTier)

    const connection = N.createConnection('https://jobs.lever.co', { connections: 30 })

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false
        while(companiesInProcess.size > 20) {
            mainLog.I('Stalling because ', [companiesInProcess.size], ' is pending')
            await U.delay(T.Now.instant().add({ seconds: 5 }))
        }

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
                        D.eq(Company.tier, 1),
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
                D.eq(Company.tier, 2),
                D.not(D.inArray(Company.name, companiesToSkip)),
            ))
            .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
            .limit(quota)
            .all()
        const otherCompaniesToCheck = db.select().from(Company)
            .where(D.and(
                D.eq(Company.exists, 1),
                D.eq(Company.tier, 3),
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
    const promises: Promise<void>[] = []
    for(const job of result.data) {
        if(existingJobs.has(job.id)) continue

        toInsert.push({
            id: job.id,
            companyName: company.name,
            fetchedEpochMs: currentTime,
            info: JSON.stringify({
                applyUrl: job.applyUrl,
                categories: job.categories,
                country: job.country,
                createdAt: job.createdAt,
                hostedUrl: job.hostedUrl,
                text: job.text,
                workplaceType: job.workplaceType,
                descriptionPlain: job.descriptionPlain,
            } satisfies JobInfo),
        })

        if(!initial) {
            log.I('New job ', [job.id])
            if(AshbyTiers.isJobDesired(job.text, job.descriptionPlain) && isLocationDesired(job)) {
                log.I('Job ', job.id, ' is relevant!')

                const ago = U.millisecToDurationString(Date.now() - (job.createdAt || 0))

                promises.push(U.sendMessage(
                    log.addedCtx('job ', [job.id]),
                    db,
                    job.text + ' @ ' + company.name + '\n'
                        + job.workplaceType + ': ' + job.categories.allLocations.join(' | ') + '\n'
                        + `Lever ${tier} ${ago} ago: ` + (job.hostedUrl || job.applyUrl),
                ))
            }
        }
    }

    await Promise.allSettled(promises)

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
        // https://github.com/plibither8/jobber/blob/4e079f745526a002463972d99fbbc9825ff0ce13/src/boards/lever.ts#L12
        const response = await N.fetch(connection, {
            method: 'GET',
            path: '/v0/postings/' + encodeURIComponent(companyName),
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

        const json = await response.body.json() as FetchJob[]
        return U.result('ok', json)
    }
    catch(err) {
        log.E('While requesting: ', [err])
        return U.status('error')
    }
}

type FetchJob = {
    additionalPlain: string
    additional: string
    categories: {
        commitment: string
        department: string
        location: string
        team: string
        allLocations: string[]
    },
    createdAt: number
    descriptionPlain: string
    description: string
    id: string
    lists: {
        text: string
        content: string
    }[]
    text: string
    country: string
    workplaceType: string
    opening: string
    openingPlain: string
    descriptionBody: string
    descriptionBodyPlain: string
    hostedUrl: string
    applyUrl: string
}

function calculateTier(
    _company: D.InferSelectModel<typeof Company>,
    jobs: D.InferSelectModel<typeof Job>[],
): number {
    let hasRelevantLocation = false
    for(const job of jobs) {
        const info: JobInfo | null = JSON.parse(job.info ?? 'null')
        if(!info) continue
        if(!isLocationRelevant(info)) continue
        hasRelevantLocation = true
        if(AshbyTiers.isJobRelevant(info.text)) return 1
    }
    return hasRelevantLocation ? 2 : 3
}

function isLocationRelevant(info: JobInfo) {
    return getLocations(info).some(location => {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location)
            || info.country === 'US' || info.country === null
        const mentionsUsConcrete = AshbyTiers.citiesStatesRegex1.test(location) || AshbyTiers.citiesStatesRegex2.test(location)
        const isRemote = /(remote|nationwide|continental)/i.test(location) || info.workplaceType === 'remote'
        const isRemoteInUs = isRemote && (mentionsUs || mentionsUsConcrete)
        const isRemoteWorldwide = location.toLowerCase() === 'remote'

        return mentionsUs || mentionsUsConcrete || isRemoteInUs || isRemoteWorldwide
    })
}
// NOTE: assumes info.descriptionPlain exists
function isLocationDesired(info: JobInfo) {
    return getLocations(info).some(location => {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location)
            || info.country === 'US' || info.country === null
        const mentionsUsConcrete = AshbyTiers.citiesStatesRegex1.test(location) || AshbyTiers.citiesStatesRegex2.test(location)
        const isRemote = /(remote|nationwide|continental)/i.test(location) || info.workplaceType === 'remote'
            || (info.descriptionPlain && /remote/i.test(info.descriptionPlain))
        const isRemoteInUs = isRemote && (mentionsUs || mentionsUsConcrete)
        const isRemoteWorldwide = location.toLowerCase() === 'remote'
        const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)

        return isRemoteInUs || isRemoteWorldwide || isMyLocal
    })
}

function getLocations(info: JobInfo) {
    return [
        ...(info.categories.location ? [info.categories.location] : []),
        ...(info.categories.allLocations ?? []),
    ]
}

type JobInfo = {
    applyUrl: string
    categories: {
        allLocations: string[]
        commitment: string
        department: string
        location: string
        team: string
    }
    descriptionPlain?: string
    country: string | null // 2 letter country code, or multiple
    createdAt: number // epoch ms
    hostedUrl: string
    text: string // title
    workplaceType: string
}
