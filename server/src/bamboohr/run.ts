import fs from 'node:fs'
import path from 'node:path'

import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Agent, interceptors, fetch as undiciFetch, Dispatcher } from 'undici'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as AshbyTiers from '../ashbyhq/tier.ts'

const { bamboohrCompany: Company, bamboohrJob: Job, bamboohrFetchJobDetails: FetchJobDetails } = Db

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
    const jobsInProgress = new Set<string>()
    let rateLimit = false

    const connection = new Agent({}).compose(interceptors.dns())

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

        const jobsToCheckDetails = db.select()
            .from(FetchJobDetails)
            .innerJoin(Job, D.and(D.eq(FetchJobDetails.companyName, Job.companyName), D.eq(FetchJobDetails.id, Job.id)))
            .where(D.not(D.inArray(FetchJobDetails.uniqueId, [...jobsInProgress])))
            .orderBy(D.asc(FetchJobDetails.addedAt))
            .limit(5)
            .all()

        const tiersCounts = U.selectCompanies(
            [desiredCompaniesToCheck, relevantCompaniesToCheck, otherCompaniesToCheck],
            [0.85, 0.1, 0.05],
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
            'job details: ', [jobsToCheckDetails.length],
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

        for(const { bamboohr_fetch_job_details, bamboohr_job } of jobsToCheckDetails) {
            const log = mainLog.addedCtx([bamboohr_fetch_job_details.companyName], ' job ', [bamboohr_fetch_job_details.id])
            ;(async() => {
                try {
                    jobsInProgress.add(bamboohr_fetch_job_details.uniqueId)
                    await processJobDetail(db, log, connection, bamboohr_fetch_job_details, bamboohr_job)
                }
                catch(err) {
                    log.E([err])
                }
                finally {
                    jobsInProgress.delete(bamboohr_fetch_job_details.uniqueId)
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
    connection: Dispatcher,
    company: D.InferSelectModel<typeof Company>,
    tier: string,
) {
    const result = await request<{ result: FetchJob[] }>(log, connection, `https://${company.name}.bamboohr.com/careers/list`)
    if(result.status === 'rate-limit') return result

    db.update(Company)
        .set({ checkedEpochMs: currentTime })
        .where(D.eq(Company.name, company.name))
        .run()

    if(result.status === 'not-found') {
        log.I('Company does not exist')

        db.update(Company)
            .set({ exists: 0, failCount: 0 })
            .where(D.eq(Company.name, company.name))
            .run()
        return U.status('ok')
    }

    if(result.status !== 'ok') {
        const newFailCount = company.failCount + 1
        if(newFailCount >= 10 && company.exists === null) {
            log.I('Marking company inactive after ', [newFailCount], ' fetch fails')
            db.update(Company)
                .set({ exists: 0, failCount: newFailCount })
                .where(D.eq(Company.name, company.name))
                .run()
        }
        else {
            db.update(Company)
                .set({ failCount: newFailCount })
                .where(D.eq(Company.name, company.name))
                .run()
        }
        return U.status('ok')
    }

    const initial = company.exists === null

    const existingJobs = new Set(
        db.select()
            .from(Job)
            .where(D.eq(Job.companyName, company.name))
            .all()
            .map(it => it.id)
    )

    const toInsert: D.InferSelectModel<typeof Job>[] = []
    const toEnqueueDetails: D.InferSelectModel<typeof FetchJobDetails>[] = []
    for(const job of result.data.result) {
        if(existingJobs.has(job.id)) continue

        toInsert.push({
            companyName: company.name,
            id: job.id,
            fetchedEpochMs: currentTime,
            info: JSON.stringify(job satisfies FetchJob),
            longInfo: null,
        })

        if(!initial) {
            log.I('New job ', [job.id])
            if(AshbyTiers.isJobDesired(job.jobOpeningName, undefined) && isLocationDesired(job)) {
                log.I('Job ', job.id, ' is initially relevant, queuing for detail fetch')
                toEnqueueDetails.push({
                    uniqueId: U.getHash(company.name, job.id),
                    id: job.id,
                    companyName: company.name,
                    addedAt: currentTime,
                    jobPostedAfter: company.checkedEpochMs ?? 0,
                    companyTier: tier,
                })
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
        if(toEnqueueDetails.length > 0) {
            db.insert(FetchJobDetails).values(toEnqueueDetails).run()
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

async function processJobDetail(
    db: BetterSQLite3Database,
    log: L.Log,
    dispatcher: Dispatcher,
    fetchDetails: D.InferSelectModel<typeof FetchJobDetails>,
    dbJob: D.InferSelectModel<typeof Job>,
) {
    const job = JSON.parse(dbJob.info) as FetchJob

    if(dbJob.longInfo === null) {
        log.I('Fetching job info')
        const responseResult = await request<FetchLongInfo>(log, dispatcher, `https://${dbJob.companyName}.bamboohr.com/careers/${encodeURIComponent(dbJob.id)}/detail`)
        if(responseResult.status === 'ok') {
            const longInfo = JSON.stringify({
                description: responseResult.data.result.jobOpening.description,
            } satisfies LongInfo)
            db.update(Job).set({ longInfo }).where(D.and(D.eq(Job.companyName, dbJob.companyName), D.eq(Job.id, dbJob.id))).run()
            dbJob.longInfo = longInfo
        }
        else {
            // TODO: report rate-limit up
        }
    }

    let shouldSend = false
    if(!dbJob.longInfo) {
        log.W('Could not get job info. Considering relevant')
        shouldSend = true
    }
    else {
        const longInfo = JSON.parse(dbJob.longInfo) as LongInfo
        if(AshbyTiers.isJobDesired(job.jobOpeningName, longInfo.description) && isLocationDesired(job)) {
            log.I('Job is still relevant after detail check')
            shouldSend = true
        }
    }

    if(shouldSend) {
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
        ].filter(it => it !== null).join(', ')

        const ago = U.millisecToDurationString(Date.now() - (fetchDetails.jobPostedAfter ?? 0))

        await U.sendMessage(
            log.addedCtx('job ', [job.id]),
            db,
            job.jobOpeningName + ' @ ' + dbJob.companyName + '\n'
                + workplaceType + ': ' + location + '\n'
                + `Bamboo ${fetchDetails.companyTier} < ${ago} ago: ` + `https://${dbJob.companyName}.bamboohr.com/careers/${encodeURIComponent(job.id)}`,
        )
    }

    db.delete(FetchJobDetails).where(D.eq(FetchJobDetails.uniqueId, fetchDetails.uniqueId)).run()
}

type LongInfo = {
    description: string // html
}

type FetchLongInfo = {
    result: {
        jobOpening: {
            description: string
        },
    }
}

async function request<R>(log: L.Log, connection: Dispatcher, url: string) {
    try {
        const response = await undiciFetch(url, {
            dispatcher: connection,
        })
        if(response.status === 429) {
            log.E('Rate limited')
            await response.text().catch(() => {})
            return U.status('rate-limit')
        }

        if(response.status === 404) {
            await response.text().catch(err => err)
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

        const json = await response.json() as R
        return U.result('ok', json)
    }
    catch(err) {
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
    const isRemoteWorldwide = info.atsLocation.country === null && info.atsLocation.state === null && info.atsLocation.province === null && info.atsLocation.city === null
        && info.location.state === null && info.location.city === null

    return isInUs || mentionsUsConcrete || isRemoteInUs || isRemoteWorldwide
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
    const isRemoteWorldwide = info.atsLocation.country === null && info.atsLocation.state === null && info.atsLocation.province === null && info.atsLocation.city === null
        && info.location.state === null && info.location.city === null
    const isMyLocal = cityState.includes('IL') || /(illinois|chicago)/i.test(cityState)

    return isRemoteInUs || isRemoteWorldwide || isMyLocal
}
