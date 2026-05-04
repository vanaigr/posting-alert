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

    let tiers: Tiers = calculateTiers(db)
    mainLog.I('Tiers: ', [tiers.desiredCompanies.length], ', ', [tiers.relevantCompanies.length])
    setInterval(() => {
        mainLog.I('Updating company tiers')
        tiers = calculateTiers(db)
        mainLog.I('Tiers: ', [tiers.desiredCompanies.length], ', ', [tiers.relevantCompanies.length])
    }, 30 * 60 * 1000)

    const connection = N.createConnection('https://jobs.lever.co')

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false

        mainLog.I('Tick')
        const nextTick = T.Now.instant().add({ seconds: 1 })

        const companiesInProcessList = [...companiesInProcess]
        const quota = 5
        const desiredCompaniesToCheck = db.select().from(Company)
            .where(D.or(
                D.isNull(Company.exists),
                D.and(
                    D.eq(Company.exists, 1),
                    D.inArray(Company.name, tiers.desiredCompanies),
                    D.not(D.inArray(Company.name, companiesInProcessList)),
                ),
            ))
            .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
            .limit(quota)
            .all()
        const relevantCompaniesToCheck = db.select().from(Company)
            .where(D.and(
                D.eq(Company.exists, 1),
                D.inArray(Company.name, tiers.relevantCompanies),
                D.not(D.inArray(Company.name, companiesInProcessList)),
            ))
            .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
            .limit(quota)
            .all()
        const otherCompaniesToCheck = db.select().from(Company)
            .where(D.and(
                D.eq(Company.exists, 1),
                D.not(D.inArray(Company.name, tiers.desiredCompanies)),
                D.not(D.inArray(Company.name, tiers.relevantCompanies)),
                D.not(D.inArray(Company.name, companiesInProcessList)),
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

        const companiesToCheck = [...desiredCompaniesToCheck, ...relevantCompaniesToCheck, ...otherCompaniesToCheck]
        const currentTime = Date.now()

        for(const company of companiesToCheck) {
            const log = mainLog.addedCtx(company.name)

            ;(async() => {
                try {
                    companiesInProcess.add(company.name)
                    const result = await checkCompany(db, log, currentTime, connection, company)
                    if(result.status === 'rate-limit') rateLimit = true
                }
                catch(err) {
                    log.E('While checking: ', [err])
                }
                finally {
                    companiesInProcess.delete(company.name)
                }
            })()
        }

        await U.delay(nextTick)
    }
}

async function checkCompany(
    db: BetterSQLite3Database,
    log: L.Log,
    currentTime: number,
    connection: N.Connection,
    company: D.InferSelectModel<typeof Company>,
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
            } satisfies JobInfo),
        })

        if(!initial) {
            log.I('New job ', [job.id])
            if(AshbyTiers.isTitleRelevant(job.text) && isLocationRelevant(job)) {
                log.I('Job ', job.id, ' is relevant!')

                U.sendMessage(
                    log.addedCtx('job ', [job.id]),
                    job.text + ' @ ' + company.name + '\n'
                        + job.categories.allLocations.join(' | ') + '\n'
                        + (job.hostedUrl || job.applyUrl),
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

type Tiers = {
    desiredCompanies: string[]
    relevantCompanies: string[]
}
function calculateTiers(db: BetterSQLite3Database) {
    const relevantJobsByCompany = new Map<string, Job[]>()

    for(const job of db.select().from(Job).all()) {
        const info: JobInfo | null = JSON.parse(job.info ?? 'null')
        if(!info) continue
        if(!AshbyTiers.isTitleRelevant(info.text) || !isLocationRelevant(info)) continue

        const jobs = (relevantJobsByCompany.get(job.companyName) ?? [])
        jobs.push({ ...job, info })
        relevantJobsByCompany.set(job.companyName, jobs)
    }

    const desiredCompanies: string[] = []
    const relevantCompanies: string[] = []

    for(const [companyName, relevantJobs] of relevantJobsByCompany) {
        const desired = relevantJobs.find(it => {
            return AshbyTiers.isTitleDesired(it.info.text) && isLocationDesired(it.info)
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
    return getLocations(info).some(location => {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.)/i.test(location)
            || info.country === 'US' || info.country === null
        const mentionsUsConcrete = AshbyTiers.stateCodesRegex.test(location) || AshbyTiers.citiesStatesRegex.test(location)
        const isRemote = /(remote|nationwide)/i.test(location) || info.workplaceType === 'Remote'
        const isRemoteInUs = (isRemote && (mentionsUs || mentionsUsConcrete || !(AshbyTiers.otherCountriesRegex1.test(location) || AshbyTiers.otherCountriesRegex2.test(location))))

        return mentionsUs || mentionsUsConcrete || isRemoteInUs
    })
}
function isLocationDesired(info: JobInfo) {
    return getLocations(info).some(location => {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.)/i.test(location)
            || info.country === 'US' || info.country === null
        const mentionsUsConcrete = AshbyTiers.stateCodesRegex.test(location) || AshbyTiers.citiesStatesRegex.test(location)
        const isRemote = /(remote|nationwide)/i.test(location) || info.workplaceType === 'Remote'
        const isRemoteInUs = (isRemote && (mentionsUs || mentionsUsConcrete || !(AshbyTiers.otherCountriesRegex1.test(location) || AshbyTiers.otherCountriesRegex2.test(location))))
        const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)

        return isRemoteInUs || isMyLocal
    })
}
function getLocations(info: JobInfo) {
    return [
        ...(info.categories.location ? [info.categories.location] : []),
        ...(info.categories.allLocations ?? []),
    ]
}

type Job = {
    id: string
    companyName: string
    fetchedEpochMs: number
    info: JobInfo
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
    country: string | null // 2 letter country code, or multiple
    createdAt: number // epoch ms
    hostedUrl: string
    text: string // title
    workplaceType: string
}
