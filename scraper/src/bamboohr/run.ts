import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Agent, interceptors, fetch as undiciFetch, Dispatcher } from 'undici'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as AshbyTiers from '../ashbyhq/tier.ts'
import * as C from '../common.ts'

const { bamboohrCompany: Company, bamboohrJob: Job, bamboohrFetchJobDetails: FetchJobDetails } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log) {
    await import('./sources/companyNames.json', { with: { type: 'json' } }).then(it => {
        C.populateCompanies(mainLog, db, Company, it.default, { checkedEpochMs: null, exists: null, tier: 0 })
    })
    C.evaluateTiers(mainLog, db, Company, Job, calculateTier)

    const companiesInProcess = new Set<string>()
    const jobsInProgress = new Set<string>()
    let rateLimit = false

    const connection = new Agent({}).compose(interceptors.dns())

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false
        while(companiesInProcess.size > 20) {
            mainLog.I('Stalling because ', [companiesInProcess.size], ' is pending')
            await U.delay(T.Now.instant().add({ seconds: 5 }))
        }

        mainLog.I('Tick (', [companiesInProcess.size], ' pending)')
        const nextTick = T.Now.instant().add({ seconds: 1 })

        const toCheck = C.getCompaniesToCheck(db, Company, [...companiesInProcess, ...C.bannedCompanies])

        const jobsToCheckDetails = db.select()
            .from(FetchJobDetails)
            .innerJoin(Job, D.and(D.eq(FetchJobDetails.companyName, Job.companyName), D.eq(FetchJobDetails.id, Job.id)))
            .where(D.not(D.inArray(FetchJobDetails.uniqueId, [...jobsInProgress])))
            .orderBy(D.asc(FetchJobDetails.addedAt))
            .limit(5)
            .all()

        mainLog.I(
            'Checking: ',
            [toCheck.desired.length], ', ',
            [toCheck.relevant.length], ', ',
            [toCheck.other.length], ', ',
            [toCheck.missing.length], ', ',
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
        for(const it of toCheck.missing) handleCompanny(it, '?')

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

    const existingJobsRows = db.select()
        .from(Job)
        .where(D.eq(Job.companyName, company.name))
        .all()
    const existingJobs = new Set(existingJobsRows.map(it => it.id))

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
        const url = `https://${dbJob.companyName}.bamboohr.com/careers/${encodeURIComponent(dbJob.id)}/detail`
        log.I('Fetching job info: ', url/*sic*/)
        const responseResult = await request<FetchLongInfo>(log, undefined, url)
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
        else {
            log.I('Job is not relevant after detail check')
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
        ].filter(it => it !== null).join(', ') || 'none'

        const ago = C.millisecToDurationString(Date.now() - (fetchDetails.jobPostedAfter ?? 0))

        await C.sendMessage(
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

async function request<R>(log: L.Log, connection: Dispatcher | undefined, url: string) {
    try {
        const response = await undiciFetch(url, { dispatcher: connection })
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

function calculateTier(
    _company: D.InferSelectModel<typeof Company>,
    jobs: D.InferSelectModel<typeof Job>[],
): number {
    let hasRelevantLocation = false
    for(const job of jobs) {
        const info: FetchJob | null = JSON.parse(job.info ?? 'null')
        if(!info) continue
        if(!isLocationRelevant(info)) continue
        hasRelevantLocation = true
        if(AshbyTiers.isJobRelevant(info.jobOpeningName)) return 1
    }
    return hasRelevantLocation ? 2 : 3
}

// NOTE: if this is changed, add a migration that resets tiers for the companies.
export function isLocationRelevant(info: FetchJob) {
    const isInUs = info.atsLocation.country !== null
        && (
            info.atsLocation.country === 'US'
                || info.atsLocation.country === 'us'
                || /(united states|america)/i.test(info.atsLocation.country)
        )
    const isRemote = /(remote|nationwide)/i.test(info.jobOpeningName) || info.isRemote || info.locationType === '1'
    const isRemoteInUs = isRemote && isInUs
    const isRemoteWorldwide = info.atsLocation.country === null && info.atsLocation.state === null && info.atsLocation.province === null && info.atsLocation.city === null
        && info.location.state === null && info.location.city === null

    return isInUs || isRemoteInUs || isRemoteWorldwide
}

export function isLocationDesired(info: FetchJob) {
    const cityState = (info.atsLocation.city || info.location.city || '')
        + ', ' + (info.atsLocation.state || info.location.state || '')

    const isInUs = info.atsLocation.country !== null
        && (
            info.atsLocation.country === 'US'
                || info.atsLocation.country === 'us'
                || /(united states|america)/i.test(info.atsLocation.country)
        )
    const isRemote = /(remote|nationwide)/i.test(info.jobOpeningName) || info.isRemote || info.locationType === '1'
    const isRemoteInUs = isRemote && isInUs
    const isRemoteWorldwide = info.atsLocation.country === null && info.atsLocation.state === null && info.atsLocation.province === null && info.atsLocation.city === null
        && info.location.state === null && info.location.city === null
    const isMyLocal = cityState.includes('IL') || /(illinois|chicago)/i.test(cityState)

    return isRemoteInUs || isRemoteWorldwide || isMyLocal
}
