import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as AshbyTiers from '../ashbyhq/tier.ts'
import * as N from '../lib/network.ts'
import * as C from '../common.ts'

const { ripplingCompany: Company, ripplingJob: Job, ripplingFetchJobDetails: FetchJobDetails } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log) {
    await import('../sources/rippling/companyNames.json', { with: { type: 'json' } }).then(it => {
        C.populateCompanies(mainLog, db, Company, it.default, { checkedEpochMs: null, exists: null, tier: 0 })
    })
    C.evaluateTiers(mainLog, db, Company, Job, calculateTier)

    const companiesInProcess = new Set<string>()
    const jobsInProgress = new Set<string>()
    let rateLimit = false

    const connection = N.createConnection('https://api.rippling.com')

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

        for(const it of toCheck.missing) handleCompanny(it, '?')
        for(const it of toCheck.desired) handleCompanny(it, 'I')
        for(const it of toCheck.relevant) handleCompanny(it, 'II')
        for(const it of toCheck.other) handleCompanny(it, 'III')

        for(const { rippling_fetch_job_details, rippling_job } of jobsToCheckDetails) {
            const log = mainLog.addedCtx([rippling_fetch_job_details.companyName], ' job ', [rippling_fetch_job_details.id])
            ;(async() => {
                try {
                    jobsInProgress.add(rippling_fetch_job_details.uniqueId)
                    await processJobDetail(db, log, connection, rippling_fetch_job_details, rippling_job)
                }
                catch(err) {
                    log.E([err])
                }
                finally {
                    jobsInProgress.delete(rippling_fetch_job_details.uniqueId)
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
    tier: string,
) {
    // https://github.com/adgramigna/job-board-scraper/blob/c40daade3b9dc842d4d9e886eeeb7ffc5b4ebe37/job_board_scraper/utils/rippling/parsing_helper.py#L15
    const result = await request<FetchJob[]>(log, connection, `/platform/api/ats/v1/board/${encodeURIComponent(company.name)}/jobs`)
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
    const toEnqueueDetails: D.InferSelectModel<typeof FetchJobDetails>[] = []

    const jobInfosById = new Map<string, JobInfo>()
    for(const rawJob of result.data) {
        const existing = jobInfosById.get(rawJob.uuid)
        if(existing === undefined) {
            jobInfosById.set(rawJob.uuid, {
                title: rawJob.name,
                url: rawJob.url,
                locations: [rawJob.workLocation.label, rawJob.workLocation.id],
            })
        }
        else {
            existing.title = rawJob.name
            existing.url = rawJob.url
            existing.locations.push(rawJob.workLocation.label, rawJob.workLocation.id)
        }
    }

    for(const [id, jobInfo] of jobInfosById) {
        // NOTE: ideally we would merge them and check if something changed,
        // but it's too complicated + may double send messages.
        if(existingJobs.has(id)) continue

        jobInfo.locations = [...new Set(jobInfo.locations)]

        toInsert.push({
            companyName: company.name,
            id: id,
            fetchedEpochMs: currentTime,
            info: JSON.stringify(jobInfo),
            longInfo: null,
        })

        if(!initial) {
            log.I('New job ', [id])
            if(AshbyTiers.isJobDesired(jobInfo.title, undefined) && isLocationDesired(jobInfo)) {
                log.I('Job ', id, ' is initially relevant, queuing for detail fetch')
                toEnqueueDetails.push({
                    uniqueId: U.getHash(company.name, id),
                    id,
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
    connection: N.Connection,
    fetchDetails: D.InferSelectModel<typeof FetchJobDetails>,
    dbJob: D.InferSelectModel<typeof Job>,
) {
    const jobInfo = JSON.parse(dbJob.info) as JobInfo

    if(dbJob.longInfo === null) {
        log.I('Fetching job info')

        const responseResult = await request<FetchJobDetail>(
            log,
            connection,
            `/platform/api/ats/v1/board/${encodeURIComponent(dbJob.companyName)}/jobs/${encodeURIComponent(dbJob.id)}`,
        )
        if(responseResult.status === 'ok') {
            const longInfo = JSON.stringify({
                descriptionHtml: responseResult.data.description.role,
                createdOn: responseResult.data.createdOn,
            } satisfies LongInfo)

            db.update(Job).set({ longInfo }).where(D.and(D.eq(Job.companyName, dbJob.companyName), D.eq(Job.id, dbJob.id))).run()
            dbJob.longInfo = longInfo
        }
        else {
            // TODO: report rate-limit up
        }
    }

    let shouldSend = false
    const longInfo =  dbJob.longInfo ? JSON.parse(dbJob.longInfo) as LongInfo : undefined
    if(!longInfo) {
        log.W('Could not get job info. Considering relevant')
        shouldSend = true
    }
    else {
        if(AshbyTiers.isJobDesired(jobInfo.title, longInfo.descriptionHtml) && isLocationDesired(jobInfo)) {
            log.I('Job is still relevant after detail check')
            shouldSend = true
        }
        else {
            log.I('Job is not relevant after detail check')
        }
    }

    if(shouldSend) {
        const exactTime = longInfo ? new Date(longInfo.createdOn).getTime() : 0

        const ago = C.millisecToDurationString(Date.now() - (exactTime || fetchDetails.jobPostedAfter || 0))

        await C.sendMessage(
            log.addedCtx('job ', [dbJob.id]),
            db,
            jobInfo.title + ' @ ' + dbJob.companyName + '\n'
                + jobInfo.locations.join(' | ') + '\n'
                + `Rippling ${fetchDetails.companyTier} ${exactTime ? '' : '< '}${ago} ago: ` + jobInfo.url,
        )
    }

    db.delete(FetchJobDetails).where(D.eq(FetchJobDetails.uniqueId, fetchDetails.uniqueId)).run()
}

async function request<T>(log: L.Log, connection: N.Connection, path: string) {
    try {
        const response = await N.fetch(connection, { method: 'GET', path })
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

        const json = await response.body.json() as T
        return U.result('ok', json)
    }
    catch(err) {
        log.E('While requesting: ', [err])
        return U.status('error')
    }
}

type FetchJob = {
    uuid: string
    name: string
    url: string
    workLocation: { label: string, id: string }
}

type FetchJobDetail = {
    description: { role: string },
    createdOn: string
}

export type JobInfo = {
    title: string
    url: string
    locations: string[]
}

export type LongInfo = {
    createdOn: string
    descriptionHtml: string
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
        if(AshbyTiers.isJobRelevant(info.title)) return 1
    }
    return hasRelevantLocation ? 2 : 3
}

// NOTE: if this is changed, add a migration that resets tiers for the companies.
export function isLocationRelevant(jobInfo: JobInfo) {
    return jobInfo.locations.some(location => {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location)
        const mentionsUsConcrete = AshbyTiers.citiesStatesRegex1.test(location) || AshbyTiers.citiesStatesRegex2.test(location)
        const isRemote = /(remote|nationwide|continental)/i.test(location) || /(remote|nationwide|continental)/i.test(jobInfo.title)
        const isRemoteInUs = isRemote && (mentionsUs || mentionsUsConcrete)
        const isRemoteWorldwide = location.toLowerCase() === 'remote'

        return mentionsUs || mentionsUsConcrete || isRemoteInUs || isRemoteWorldwide
    })
}
export function isLocationDesired(jobInfo: JobInfo) {
    return jobInfo.locations.some(location => {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location)
        const mentionsUsConcrete = AshbyTiers.citiesStatesRegex1.test(location) || AshbyTiers.citiesStatesRegex2.test(location)
        const isRemote = /(remote|nationwide|continental)/i.test(location) || /(remote|nationwide|continental)/i.test(jobInfo.title)
        const isRemoteInUs = isRemote && (mentionsUs || mentionsUsConcrete)
        const isRemoteWorldwide = location.toLowerCase() === 'remote'
        const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)
        const onSite = !isRemote

        return isRemoteInUs || isRemoteWorldwide || isMyLocal || ((mentionsUs || mentionsUsConcrete) && !(mentionsUsConcrete && onSite))
    })
}
