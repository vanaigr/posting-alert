import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Agent, interceptors, fetch as undiciFetch, Dispatcher } from 'undici'
import * as htmlparser2 from 'htmlparser2'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as Tier from '../tier/index.ts'
import * as C from '../lib/common.ts'

// Half taken from here: https://github.com/kalil0321/ats-scrapers

// NOTE: not all subdomains are going to be companies, and some unrelated pages will exist
// and fetch, but then contain no jobs. The current impl marks them as existing, but
// since they have no jobs they'll be classified as tier 3 and thus won't interfere with actual company pages.

const { icimsCompany: Company, icimsJob: Job, icimsFetchJobDetails: FetchJobDetails } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log, sampleSaver: C.SampleSaver) {
    const sampler = sampleSaver.createSampler('icims')
    await import('../sources/icims/companyNames.json', { with: { type: 'json' } }).then(it => {
        C.populateCompanies(mainLog, db, Company, it.default, {
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

    const connection = new Agent({}).compose(interceptors.dns())

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

        const toCheck = C.getCompaniesToCheck(db, Company, [...companiesInProcess, ...Tier.bannedCompanies], {
            quota: 1
        })

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

        for(const { icims_fetch_job_details, icims_job } of jobsToCheckDetails) {
            const log = mainLog.addedCtx([icims_fetch_job_details.companyName], ' job ', [icims_fetch_job_details.id])
            ;(async() => {
                try {
                    jobsInProgress.add(icims_fetch_job_details.uniqueId)
                    await processJobDetail(db, log, connection, icims_fetch_job_details, icims_job)
                }
                catch(err) {
                    log.E([err])
                }
                finally {
                    jobsInProgress.delete(icims_fetch_job_details.uniqueId)
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
    const rawJobs: RawJob[] = []
    let firstPageFailed = false
    let notFound = false

    for(let page = 0;; page++) {
        const url = `https://${company.name}.icims.com/jobs/search?ss=1&pr=${page}&in_iframe=1`
        const result = await request(log.addedCtx('page ', [page]), connection, url)
        if(result.status === 'rate-limit') return result

        if(result.status === 'not-found' || (result.status === 'ok' && result.data.redirected)) {
            notFound = true
            break
        }

        if(result.status !== 'ok') {
            if(page === 0) firstPageFailed = true
            break
        }

        const jobs = extractJobs(log.addedCtx('page ', [page]), result.data.html)
        if(!jobs) break
        rawJobs.push(...jobs)
    }

    db.update(Company)
        .set({ checkedEpochMs: currentTime })
        .where(D.eq(Company.name, company.name))
        .run()

    if(notFound) {
        log.I('Company does not exist')

        db.update(Company)
            .set({ exists: 0, tier: 3 })
            .where(D.eq(Company.name, company.name))
            .run()
        return U.status('ok')
    }

    if(firstPageFailed) {
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

    const initial = company.exists === null

    const existingJobsRows = db.select()
        .from(Job)
        .where(D.eq(Job.companyName, company.name))
        .all()
    const existingJobs = new Set(existingJobsRows.map(it => it.id))

    const toInsert: D.InferSelectModel<typeof Job>[] = []
    const toEnqueueDetails: D.InferSelectModel<typeof FetchJobDetails>[] = []
    for(const rawJob of rawJobs) {
        const id = rawJob.id
        if(!id) continue
        if(existingJobs.has(id)) continue
        existingJobs.add(id)

        const jobInfo: JobInfo = {
            title: rawJob.title,
            url: rawJob.url,
            location: rawJob.location,
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
                    id,
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
    dispatcher: Dispatcher,
    fetchDetails: D.InferSelectModel<typeof FetchJobDetails>,
    dbJob: D.InferSelectModel<typeof Job>,
) {
    const job = JSON.parse(dbJob.info) as JobInfo

    const jobUrl = `https://${dbJob.companyName}.icims.com/jobs/${dbJob.id}/job`

    if(dbJob.longInfo === null) {
        log.I('Fetching job info')
        const responseResult = await request(log, dispatcher, jobUrl + '?in_iframe=1', 3)
        if(responseResult.status === 'ok') {
            const posting = extractJobPosting(log, responseResult.data.html)
            if(posting) {
                const longInfo = JSON.stringify(posting)
                db.update(Job).set({ longInfo }).where(D.and(D.eq(Job.companyName, dbJob.companyName), D.eq(Job.id, dbJob.id))).run()
                dbJob.longInfo = longInfo
            }
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
        const jobDesired = Tier.isJobDesired(job.title, C.parseHtml(longInfo.description))
        const locationDesired = await isLocationDesiredFull(log, db, { info: job, longInfo })
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
        const longInfo = dbJob.longInfo ? JSON.parse(dbJob.longInfo) as LongInfo : null
        const url = longInfo?.url || jobUrl

        const maxAgo = C.millisecToDurationString(Date.now() - (fetchDetails.jobPostedAfter ?? 0))

        await C.sendMessage(
            log.addedCtx('job ', [dbJob.id]),
            db,
            job.title + ' @ ' + dbJob.companyName + '\n'
                + (job.location || 'none') + '\n'
                + `Icims ${fetchDetails.companyTier} < ${maxAgo} ago: ` + url,
        )
    }

    db.delete(FetchJobDetails).where(D.eq(FetchJobDetails.uniqueId, fetchDetails.uniqueId)).run()
}

export type JobInfo = {
    title: string
    location: string
    url: string
}

export type LongInfo = {
    description: string // html
    datePosted: string | null
    url: string | null
}

async function request(log0: L.Log, connection: Dispatcher | undefined, url: string, tries: number = 1) {
    for(let t = 0; t < tries; t++) {
        const log = t === 0 ? log0 : log0.addedCtx('try ', [t])

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
                continue
            }

            const requestedHost = new URL(url).host
            let finalHost: string
            try {
                finalHost = new URL(response.url).host
            }
            catch {
                finalHost = requestedHost
            }
            const redirected = response.redirected || finalHost !== requestedHost

            const html = await response.text()
            return U.result('ok', { html, redirected })
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

function calculateTier(db: BetterSQLite3Database, job: D.InferSelectModel<typeof Job>) {
    const info = JSON.parse(job.info) as JobInfo
    const longInfo: LongInfo | null = JSON.parse(job.longInfo ?? 'null')
    if(isLocationRelevant(db, { info, longInfo })) {
        if(Tier.isJobRelevant(info.title)) return 1
        return 2
    }
    return 3
}

export function isLocationRelevant(db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    return Tier.isLocationRelevant(db, job.info.location, {
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}
export function isLocationDesired(db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    return Tier.isLocationDesired(db, job.info.location, {
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}
export async function isLocationDesiredFull(log: L.Log, db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    return await Tier.isLocationDesiredFull(log, db, job.info.location, {
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}

type RawJob = {
    id: string
    title: string
    location: string
    url: string
}

function extractJobs(log: L.Log, html: string) {
    let jobFound = 0

    let inTableDepth = 0
    let inCardDepth = 0

    let inLocationDepth = 0
    let inLocationIgnoreDepth = 0
    let locationParts: string[] = []

    let inTitleDepth = 0
    let inTitleIgnoreDepth = 0
    let titleParts: string[] = []

    let inTitleBlockDepth = 0

    let url: string | undefined
    let location: string | undefined
    let title: string | undefined

    const jobs: RawJob[] = []

    const parser = new htmlparser2.Parser({
        onopentag(name, attribs) {
            if(inTableDepth > 0) inTableDepth++
            if(inCardDepth > 0) inCardDepth++
            if(inLocationDepth > 0) inLocationDepth++
            if(inLocationIgnoreDepth > 0) inLocationIgnoreDepth++
            if(inTitleDepth > 0) inTitleDepth++
            if(inTitleIgnoreDepth > 0) inTitleIgnoreDepth++
            if(inTitleBlockDepth > 0) inTitleBlockDepth++

            if(/\b(iCIMS_JobsTable)\b/.test(attribs.class)) {
                inTableDepth++
            }

            if(inTableDepth > 0) {
                if(/\b(iCIMS_JobCardItem)\b/.test(attribs.class)) {
                    inCardDepth++
                    jobFound++
                }
            }

            if(inCardDepth > 0) {
                if(inLocationDepth > 0) {
                    if(/\b(field-label)\b/.test(attribs.class)) {
                        inLocationIgnoreDepth++
                    }
                }
                if(inTitleDepth > 0) {
                    if(/\b(field-label)\b/.test(attribs.class)) {
                        inTitleIgnoreDepth++
                    }
                }

                if(/\b(header)\b/.test(attribs.class) && /\b(left)\b/.test(attribs.class)) {
                    inLocationDepth++
                }
                if(/\b(title)\b/.test(attribs.class)) {
                    inTitleBlockDepth++
                }
                if(name === 'a' && /\b(iCIMS_Anchor)\b/.test(attribs.class)) {
                    url = attribs.href
                    inTitleDepth++
                }
            }
        },
        ontext(text) {
            if(inLocationDepth > 0 && inLocationIgnoreDepth === 0) {
                locationParts.push(text)
            }
            if(inTitleDepth > 0 && inTitleIgnoreDepth === 0) {
                titleParts.push(text)
            }
        },
        onclosetag(name) {
            if(inTableDepth > 0) {
                inTableDepth--
            }
            if(inCardDepth > 0) {
                inCardDepth--
                if(inCardDepth === 0) {
                    if(title === undefined || location === undefined || url === undefined) {
                        log.W('Could not parse job ', [jobFound])
                    }
                    else {
                        const segments = new URL(url).pathname.split('/')
                        if(segments[1] !== 'jobs' || !segments[2]) {
                            log.W(
                                'Could not extract id from ',
                                [jobs.length],
                                [[' ', [url]], 'extra-details'],
                            )
                        }
                        else {
                            jobs.push({
                                title,
                                location,
                                url,
                                id: segments[2],
                            })
                            title = location = url = undefined
                        }
                    }
                }
            }
            if(inTitleBlockDepth > 0) inTitleBlockDepth--
            if(inLocationIgnoreDepth > 0) inLocationIgnoreDepth--
            if(inTitleIgnoreDepth > 0) inTitleIgnoreDepth--
            if(inLocationDepth > 0) {
                inLocationDepth--
                if(inLocationDepth === 0) {
                    location = locationParts.join('').trim()
                    locationParts.length = 0
                }
            }
            if(inTitleDepth > 0) {
                inTitleDepth--
                if(inTitleDepth === 0) {
                    title = titleParts.join('').trim()
                    titleParts.length = 0
                }
            }
        },
    })
    parser.write(html)
    parser.end()

    return jobs
}

function extractJobPosting(log: L.Log, html: string): LongInfo | undefined {
    const scripts: string[] = []
    let capturing = false
    let parts: string[] = []

    const parser = new htmlparser2.Parser({
        onopentag(name, attribs) {
            if(name === 'script' && attribs.type === 'application/ld+json') {
                capturing = true
                parts = []
            }
        },
        ontext(text) {
            if(capturing) parts.push(text)
        },
        onclosetag(name) {
            if(name === 'script' && capturing) {
                scripts.push(parts.join(''))
                capturing = false
            }
        },
    })
    parser.write(html)
    parser.end()

    for(const raw of scripts) {
        let parsed: any
        try {
            parsed = JSON.parse(raw)
        }
        catch(err) {
            log.I('Could not parse ld+json: ', [err])
            continue
        }

        const candidates: any[] = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.['@graph'])
                ? parsed['@graph']
                : [parsed]

        for(const candidate of candidates) {
            if(!candidate || candidate['@type'] !== 'JobPosting') continue

            return {
                description: typeof candidate.description === 'string' ? candidate.description : '',
                url: typeof candidate.url === 'string' ? candidate.url : null,
                datePosted: typeof candidate.datePosted === 'string' ? candidate.datePosted : null,
            }
        }
    }

    log.I('Did not find JobPosting ld+json', [[' ', [html]], 'extra-details'])
    return
}
