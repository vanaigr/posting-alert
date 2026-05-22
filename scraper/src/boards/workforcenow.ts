import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as htmlparser2 from 'htmlparser2'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as N from '../lib/network.ts'
import * as Db from '../lib/db.ts'
import * as Tier from '../tier/index.ts'
import * as C from '../lib/common.ts'

const { workforcenowCompany: Company, workforcenowJob: Job, workforcenowFetchJobDetails: FetchJobDetails } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log, sampler: C.Sampler) {
    await import('../sources/workforcenow/companies.json', { with: { type: 'json' } }).then(it => {
        C.populateCompanies(mainLog, db, Company, it.default, {
            humanName: null,
            checkedEpochMs: null,
            exists: null,
            tier: 0,
            failCount: 0,
        })
    })
    C.initTierEvaluation(mainLog, db, Company, Job, calculateTier)

    const companiesInProcess = new Set<string>()
    const jobsInProgress = new Set<string>()
    let rateLimit = false

    const connection = N.createConnection('https://workforcenow.adp.com')

    const oneTimeQuota = 4
    const maxQuota = 4

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false
        while(companiesInProcess.size > 20) {
            mainLog.I('Stalling because ', [companiesInProcess.size], ' is pending')
            await U.delay(T.Now.instant().add({ seconds: 5 }))
        }

        mainLog.I('Tick (', [companiesInProcess.size], ' pending)')
        sampler.count++
        const nextTick = T.Now.instant().add({ seconds: 1 })

        const toCheck = C.getCompaniesToCheck(db, Company, [...companiesInProcess], {
            quota: Math.min(Math.max(0, maxQuota - companiesInProcess.size), oneTimeQuota),
        })

        const jobsToCheckDetails = db.select()
            .from(FetchJobDetails)
            .innerJoin(Job, D.and(D.eq(FetchJobDetails.companyName, Job.companyName), D.eq(FetchJobDetails.id, Job.id)))
            .innerJoin(Company, D.eq(FetchJobDetails.companyName, Company.name))
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

        for(const { workforcenow_fetch_job_details, workforcenow_job, workforcenow_company } of jobsToCheckDetails) {
            const log = mainLog.addedCtx([workforcenow_fetch_job_details.companyName], ' job ', [workforcenow_fetch_job_details.id])
            ;(async() => {
                try {
                    jobsInProgress.add(workforcenow_fetch_job_details.uniqueId)
                    await processJobDetail(db, log, connection, workforcenow_fetch_job_details, workforcenow_job, workforcenow_company)
                }
                catch(err) {
                    log.E([err])
                }
                finally {
                    jobsInProgress.delete(workforcenow_fetch_job_details.uniqueId)
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
    const preliminaryResult = await request<CompanyResponse>(log, connection, (() => {
        const url = new URL('https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/client-features')
        url.searchParams.set('cid', company.name)
        return url.toString()
    })())

    if(preliminaryResult.status === 'rate-limit') return preliminaryResult

    const humanName = (() => {
        if(preliminaryResult.status !== 'ok') return

        return preliminaryResult.data.meta?.customFieldGroup?.stringFields
            ?.find(it => it.nameCode?.codeValue === 'ClientName')
            ?.stringValue
    })()

    if(humanName) company.humanName = humanName
    db.update(Company)
        .set({ checkedEpochMs: currentTime, ...(humanName !== undefined ? { humanName } : {}) })
        .where(D.eq(Company.name, company.name))
        .run()

    if(preliminaryResult.status === 'not-found') {
        log.I('Company does not exist')

        db.update(Company)
            .set({ exists: 0, tier: 3 })
            .where(D.eq(Company.name, company.name))
            .run()
        return U.status('ok')
    }

    if(preliminaryResult.status === 'error') {
        const newFailCount = company.failCount + 1
        if(newFailCount >= 10 && company.exists === null) {
            log.I('Marking company inactive after ', [newFailCount], ' fetch fails')
            db.update(Company)
                .set({ exists: 0, tier: 3, failCount: newFailCount })
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

    const rawJobs: RawJob[] = []
    for(let offset: number | undefined;;) {
        log.I('Fetching at ', [offset])

        const url = new URL('https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions')
        url.searchParams.set('cid', company.name)
        url.searchParams.set('$top', '20')
        if(offset !== undefined) url.searchParams.set('$skip', '' + offset)

        const result = await request<JobsResponse>(log.addedCtx('offset ', [offset]), connection, url.toString())
        if(result.status === 'rate-limit') return result
        if(result.status !== 'ok') break
        if(!result.data.jobRequisitions?.length) break

        rawJobs.push(...result.data.jobRequisitions)

        const start = result.data.meta?.startSequence
        if(start === undefined) break
        offset = start + result.data.jobRequisitions?.length

        const last = result.data.meta?.totalNumber // offset is 1-indexed, so count is last, not end
        if(last !== undefined && offset > last) break

        await U.delay(T.Now.instant().add({ seconds: 1 }))
    }

    const initial = company.exists === null

    const existingJobsRows = db.select()
        .from(Job)
        .where(D.eq(Job.companyName, company.name))
        .all()
    const existingJobs = new Set(existingJobsRows.map(it => it.id))

    const toInsert: D.InferSelectModel<typeof Job>[] = []
    const toEnqueueDetails: D.InferSelectModel<typeof FetchJobDetails>[] = []
    for(const rawJob of rawJobs) {
        const id = rawJob.customFieldGroup?.stringFields?.find(it => it.nameCode?.codeValue === 'ExternalJobID')?.stringValue
        if(!id || existingJobs.has(id)) continue
        existingJobs.add(id)

        const jobInfo: JobInfo = {
            title: rawJob.requisitionTitle ?? '',
            postedAt: rawJob.postDate ?? '',
            locations: rawJob.requisitionLocations ?? [],
        }

        const jobDesired = Tier.isJobDesired(jobInfo.title, undefined)
        const locationDesired = isLocationDesired(db, { info: jobInfo, longInfo: null })

        toInsert.push({
            companyName: company.name,
            id,
            fetchedEpochMs: currentTime,
            info: JSON.stringify(jobInfo),
            longInfo: null,
            relevancy: JSON.stringify({
                jr: Tier.isJobRelevant(jobInfo.title),
                lr: isLocationRelevant(db, { info: jobInfo, longInfo: null }),
                jd: jobDesired,
                ld: locationDesired,
            }),
        })

        if(!initial) {
            log.I('New job ', [id])
            if(jobDesired && locationDesired) {
                log.I('Job ', id, ' is initially relevant, queuing for detail fetch')
                toEnqueueDetails.push({
                    uniqueId: U.getHash(company.name, id),
                    id: id,
                    companyName: company.name,
                    addedAt: currentTime,
                    jobPostedAfter: company.checkedEpochMs ?? 0,
                    companyTier: tier,
                })
            }
        }
    }

    const newTier = toInsert.length > 0 || !company.exists
        ? C.evaluateCompanyTier(db, [...existingJobsRows, ...toInsert], calculateTier)
        : null

    db.transaction(db => {
        db.update(Company)
            .set({ exists: 1, failCount: 0, ...(newTier !== null ? { tier: newTier } : {}) })
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
    dbCompany: D.InferSelectModel<typeof Company>,
) {
    const info = JSON.parse(dbJob.info) as JobInfo

    if(dbJob.longInfo === null) {
        log.I('Fetching job info')

        const url = new URL(`https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions/${encodeURIComponent(fetchDetails.id)}`)
        url.searchParams.set('cid', fetchDetails.companyName)

        const responseResult = await request<JobDetailsResponse>(log, connection, url.toString(), 3)
        if(responseResult.status === 'ok') {
            const longInfo = JSON.stringify({
                description: responseResult.data.requisitionDescription ?? '',
            } satisfies LongInfo)
            db.update(Job).set({ longInfo }).where(D.and(D.eq(Job.companyName, dbJob.companyName), D.eq(Job.id, dbJob.id))).run()
            dbJob.longInfo = longInfo
        }
        else {
            // TODO: report rate-limit up
        }
    }

    let shouldSend = false
    const longInfo = dbJob.longInfo ? JSON.parse(dbJob.longInfo) as LongInfo : undefined
    if(!longInfo) {
        log.W('Could not get job info. Considering relevant')
        shouldSend = true
    }
    else {
        const jobDesired = Tier.isJobDesired(info.title, C.parseHtml(longInfo.description))
        const locationDesired = await isLocationDesiredFull(log, db, { info: info, longInfo })
        if(jobDesired && locationDesired) {
            log.I('Job is still relevant after detail check')
            shouldSend = true
        }
        else {
            log.I('Job is not relevant after detail check')
        }

        db.update(Job)
            .set({
                relevancy: JSON.stringify({
                    ...JSON.parse(dbJob.relevancy),
                    pjd: jobDesired,
                    pld: locationDesired,
                }),
            })
            .where(D.and(D.eq(Job.companyName, dbJob.companyName), D.eq(Job.id, dbJob.id)))
            .run()
    }

    if(shouldSend) {
        const urlUrl = new URL('https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html')
        urlUrl.searchParams.set('cid', fetchDetails.companyName)
        urlUrl.searchParams.set('jobId', fetchDetails.id)
        const url = urlUrl.toString()

        const ago = C.millisecToDurationString(Date.now() - new Date(info.postedAt).getTime())
        const maxAgo = C.millisecToDurationString(Date.now() - (fetchDetails.jobPostedAfter ?? 0))
        const location = infoToLocation(info)

        await C.sendMessage(
            log,
            db,
            {
                type: 'boardJob',
                board: 'workforcenow',
                extra: {
                    companyName: dbJob.companyName,
                    id: dbJob.id,
                },
                message: info.title + ' @ ' + (dbCompany.humanName || dbJob.companyName) + '\n'
                    + location + '\n'
                    + `WFN ${fetchDetails.companyTier} ${ago} (< ${maxAgo}) ago: ` + url
                    + (Tier.isRequiringClearance(info.title, longInfo ? C.parseHtml(longInfo.description) : undefined) ? '\n⚠️ clearance?' : '')
            },
        )
    }

    db.delete(FetchJobDetails).where(D.eq(FetchJobDetails.uniqueId, fetchDetails.uniqueId)).run()
}

async function request<R>(log0: L.Log, connection: N.Connection, url: string, tries: number = 1) {
    for(let t = 0; t < tries; t++) {
        const log = t === 0 ? log0 : log0.addedCtx('try ', [t])

        try {
            const response = await N.fetch(connection, {
                method: 'GET',
                path: url,
                headers: {
                    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
                }
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
                    continue
            }

            const json = await response.body.json() as R
            return U.result('ok', json)
        }
        catch(err) {
            log.E('While requesting: ', [err])
                continue
        }
    }

    if(tries !== 0) {
        log0.I('Returning error after ', [tries], ' tries')
    }
    return U.status('error')
}


export type JobInfo = {
    title: string
    postedAt: string
    locations: Location[]
}

export type LongInfo = {
    description: string // html
}

type CompanyResponse = {
    meta?: {
        customFieldGroup?: {
            stringFields?: {
                stringValue?: string
                nameCode?: { codeValue?: string }
            }[]
        }
    }
}

type JobsResponse = {
    jobRequisitions?: Array<RawJob>
    meta?: {
        startSequence?: number
        totalNumber?: number
    }
}

type JobDetailsResponse = {
    requisitionDescription?: string
}

type RawJob = {
    requisitionTitle?: string
    postDate?: string
    customFieldGroup?: {
        stringFields?: Array<{
            stringValue?: string
            nameCode?: { codeValue?: string }
        }>
    }
    requisitionLocations?: Array<Location>
}

type Location = {
    nameCode?: { shortName?: string }
}

function calculateTier(db: BetterSQLite3Database, job: D.InferSelectModel<typeof Job>) {
    const info: JobInfo = JSON.parse(job.info)
    const longInfo: LongInfo | null = JSON.parse(job.longInfo ?? 'null')
    if(isLocationRelevant(db, { info, longInfo })) {
        if(Tier.isJobRelevant(info.title)) return 1
        return 2
    }
    return 3
}

export function isLocationRelevant(db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    return Tier.isLocationRelevant(db, infoToLocation(job.info), {
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}
export function isLocationDesired(db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    return Tier.isLocationDesired(db, infoToLocation(job.info), {
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}
export async function isLocationDesiredFull(log: L.Log, db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    return await Tier.isLocationDesiredFull(log, db, infoToLocation(job.info), {
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}

function infoToLocation(info: JobInfo) {
    return info.locations.map(it => it.nameCode?.shortName).filter(it => it).join(' | ')
}
