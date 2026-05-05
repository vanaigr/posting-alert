import fs from 'node:fs'
import path from 'node:path'

import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as N from '../lib/network.ts'
import * as Db from '../lib/db.ts'
import * as AshbyTiers from '../ashbyhq/tier.ts'

const { bamboohrCompany: Company, bamboohrJob: Job } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log) {
    ;(() => {
        const companyNames: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'companyNames.json')).toString())

        for(let i = 0; i < companyNames.length; i += 5000) {
            const toInsert = companyNames
                .slice(i, i + 5000)
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

    let tiers: Tiers = calculateTiers(db)
    mainLog.I('Tiers: ', [tiers.desiredCompanies.length], ', ', [tiers.relevantCompanies.length])
    setInterval(() => {
        mainLog.I('Updating company tiers')
        tiers = calculateTiers(db)
        mainLog.I('Tiers: ', [tiers.desiredCompanies.length], ', ', [tiers.relevantCompanies.length])
    }, 30 * 60 * 1000)

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
            [1, 0, 0],
            //[0.5, 0.25, 0.25],
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
                const result = await checkCompany(db, log, currentTime, company, tier)
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
    company: D.InferSelectModel<typeof Company>,
    tier: string,
) {
    const result = await requestCompany(log, company.name)
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
    for(const job of result.data.result) {
        if(existingJobs.has(job.id)) continue

        toInsert.push({
            companyName: company.name,
            id: job.id,
            fetchedEpochMs: currentTime,
            info: JSON.stringify(job satisfies FetchJob),
        })

        if(!initial) {
            log.I('New job ', [job.id])
            if(AshbyTiers.isJobDesired(job.jobOpeningName, undefined) && isLocationDesired(job)) {
                log.I('Job ', job.id, ' is relevant!')

                const workplaceType = (() => {
                    if(job.isRemote) return 'Remote'
                    if(job.locationType === '0') return 'On-site'
                    if(job.locationType === '1') return 'Remote'
                    if(job.locationType === '2') return 'Hybrid'
                    return 'error ' + job.locationType
                })()

                const location = [
                    job.atsLocation.city || job.location.city,
                    job.atsLocation.state || job.location.state,
                    job.atsLocation.province,
                    job.atsLocation.country,
                ].filter(it => it !== undefined).join(', ')

                U.sendMessage(
                    log.addedCtx('job ', [job.id]),
                    job.jobOpeningName + ' @ ' + company.name + '\n'
                        + workplaceType + ': ' + location + '\n'
                        + `Bamboo ${tier}: ` + `https://${company.name}.bamboohr.com/careers/${encodeURIComponent(job.id)}`,
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

async function requestCompany(log: L.Log, companyName: string) {
    try {
        // TODO: go.bamboohr.com fails every time. Delete it
        const response = await N.fetch2({
            url: `https://${companyName}.bamboohr.com/careers/list`,
            allowRedirect: (url) => {
                if(url.hostname === 'www.bamboohr.com') return false
                if(url.pathname === '/login.php') return false
                return true
            },
        })
        if(response.status === 429) {
            log.E('Rate limited')
            await response.text().catch(() => {})
            return U.status('rate-limit')
        }

        if(response.status === 404) {
            log.E('Not found')
            return U.status('not-found')
        }
        if(response.status !== 200) {
            log.E('Request failed: ', [response.status], ': ', [await response.text().catch(err => err)])
            return U.status('error')
        }
        if(response.headers.get('content-type') !== 'application/json') {
            await response.text().catch(err => err)
            log.E('Returned non-json ', [response.headers.get('content-type')])
            return U.status('not-found')
        }

        const json = await response.json() as { result: FetchJob[] }
        return U.result('ok', json)
    }
    catch(err) {
        if(err instanceof N.BlockedHostError) {
            return U.status('not-found')
        }

        log.E('While requesting: ', [err])
        return U.status('error')
    }
}

type FetchJob = {
    id: string
    jobOpeningName: string
    departmentId: string
    departmentLabel: string
    employmentStatusLabel: string
    location: {
        city: string | null
        state: string | null
    }
    atsLocation: {
        country: string | null
        state: string | null
        province: string | null
        city: string | null
    },
    isRemote: null
    locationType: string | null // 0 - on-site, 1 - remote, 2 - hybrid, null have not seen
}

type Tiers = {
    desiredCompanies: string[]
    relevantCompanies: string[]
}
function calculateTiers(db: BetterSQLite3Database) {
    const relevantJobsByCompany = new Map<string, FetchJob[]>()

    for(const job of db.select().from(Job).all()) {
        const info: FetchJob | null = JSON.parse(job.info ?? 'null')
        if(!info) continue
        if(!isLocationRelevant(info)) continue

        const jobs = (relevantJobsByCompany.get(job.companyName) ?? [])
        jobs.push(info)
        relevantJobsByCompany.set(job.companyName, jobs)
    }

    const desiredCompanies: string[] = []
    const relevantCompanies: string[] = []

    for(const [companyName, relevantJobs] of relevantJobsByCompany) {
        const desired = relevantJobs.find(it => AshbyTiers.isJobRelevant(it.jobOpeningName))
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

function isLocationRelevant(info: FetchJob) {
    const cityState = (info.atsLocation.city || info.location.city || '')
        + ', ' + (info.atsLocation.state || info.location.state || '')

    const isInUs = info.atsLocation.country !== null
        && (
            info.atsLocation.country === 'US'
                || info.atsLocation.country === 'us'
                || /(united states|america)/i.test(info.atsLocation.country)
        )
    const mentionsUsConcrete = AshbyTiers.citiesStatesRegex1.test(cityState) || AshbyTiers.citiesStatesRegex2.test(cityState)
    const isRemote = /(remote|nationwide)/i.test(info.jobOpeningName) || info.isRemote || info.locationType === '1'
    const isRemoteInUs = isRemote && (isInUs || mentionsUsConcrete)

    return isInUs || mentionsUsConcrete || isRemoteInUs
}
function isLocationDesired(info: FetchJob) {
    const cityState = (info.atsLocation.city || info.location.city || '')
        + ', ' + (info.atsLocation.state || info.location.state || '')

    const isInUs = info.atsLocation.country !== null
        && (
            info.atsLocation.country === 'US'
                || info.atsLocation.country === 'us'
                || /(united states|america)/i.test(info.atsLocation.country)
        )
    const mentionsUsConcrete = AshbyTiers.citiesStatesRegex1.test(cityState) || AshbyTiers.citiesStatesRegex2.test(cityState)
    const isRemote = /(remote|nationwide)/i.test(info.jobOpeningName) || info.isRemote || info.locationType === '1'
    const isRemoteInUs = isRemote && (isInUs || mentionsUsConcrete)
    const isMyLocal = cityState.includes('IL') || /(illinois|chicago)/i.test(cityState)

    return isRemoteInUs || isMyLocal
}
