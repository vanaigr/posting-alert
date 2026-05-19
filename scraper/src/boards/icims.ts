import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Agent, interceptors, fetch as undiciFetch, Dispatcher, type Response as UndiciResponse } from 'undici'
import * as htmlparser2 from 'htmlparser2'
import JSON5 from 'json5'

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

    const oneTimeQuota = 5
    const maxQuota = 10

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false

        mainLog.I('Tick (', [companiesInProcess.size], ' pending)')
        sampler.count++
        const nextTick = T.Now.instant().add({ seconds: 1 })

        const toCheck = C.getCompaniesToCheck(db, Company, [...companiesInProcess, ...Tier.bannedCompanies], {
            quota: Math.min(Math.max(0, maxQuota - companiesInProcess.size), oneTimeQuota),
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

    const preliminaryResult = await (async(log) => {
        const url = `https://${company.name}.icims.com/jobs/search?ss=1&pr=0&in_iframe=1&needsRedirect=false`
        try {
            const response = await undiciFetch(url)
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
            if(response.redirected) {
                await response.text().catch(err => err)
                log.E('Not found')
                return U.status('not-found')
            }

            await response.text().catch(() => {})
            return U.result(
                'ok',
                response.headers.getSetCookie().map(it => it.slice(0, it.indexOf(';'))).join(';'),
            )
        }
        catch(err) {
            log.E([err])
            return U.status('error')
        }
    })(log.addedCtx('preliminary'))

    if(preliminaryResult.status === 'rate-limit') return preliminaryResult

    db.update(Company)
        .set({ checkedEpochMs: currentTime })
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
    for(let page = 0;; page++) {
        log.I('Fetching page ', [page])
        const result = await request(
            log.addedCtx('page ', [page]),
            `https://${company.name}.icims.com/jobs/search?ss=1&pr=${page}&in_iframe=1`,
            (url) => undiciFetch(url, {
                dispatcher: connection,
                headers: { cookie: preliminaryResult.data },
            }),
        )
        if(result.status === 'rate-limit') return result
        if(result.status !== 'ok') break

        const jobs = extractJobs(log, result.data.html)
        if(!jobs) break
        rawJobs.push(...jobs)
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
        const id = String(rawJob.idRaw)
        if(!id || rawJob.idRaw == null) continue
        if(existingJobs.has(id)) continue
        existingJobs.add(id)

        const jobInfo = parseJobInfo(rawJob)

        const jobDesired = Tier.isJobDesired(jobInfo.title, undefined)
        const locationDesired = isLocationDesired(db, { info: jobInfo, longInfo: null })

        toInsert.push({
            companyName: company.name,
            id,
            fetchedEpochMs: currentTime,
            info: JSON.stringify(rawJob),
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
    const job = parseJobInfo(JSON.parse(dbJob.info) as RawJob)

    const jobUrl = `https://${dbJob.companyName}.icims.com/jobs/${dbJob.id}/job`

    if(dbJob.longInfo === null) {
        log.I('Fetching job info')
        const responseResult = await request(
            log,
            jobUrl + '?in_iframe=1',
            (url) => undiciFetch(url, { dispatcher }),
            3,
        )
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

export type RawJob = {
    positionType?: string
    location?: { zip?: string, country?: string, city?: string, state?: string }
    company?: string
    id?: string
    idRaw: number
    position?: number
    title: string
    category?: string
    postedDate?: string
}

export type JobInfo = {
    title: string
    location: string
}

export type LongInfo = {
    description: string // html
    url: string | null
    datePosted: string | null
}

function parseJobInfo(raw: RawJob): JobInfo {
    const loc = raw.location
    const parts = [loc?.city, loc?.state, loc?.country]
        .filter((it): it is string => !!it && it !== 'not set')
    return {
        title: raw.title ?? '',
        location: parts.join(', '),
    }
}

async function request(log0: L.Log, url: string, fetch: (url: string) => Promise<UndiciResponse>, tries: number = 1) {
    for(let t = 0; t < tries; t++) {
        const log = t === 0 ? log0 : log0.addedCtx('try ', [t])

        try {
            const response = await fetch(url)

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
    const info = parseJobInfo(JSON.parse(job.info) as RawJob)
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

function extractJobs(log: L.Log, html: string): RawJob[] | undefined {
    const scripts: string[] = []
    let capturing = false
    let parts: string[] = []

    const parser = new htmlparser2.Parser({
        onopentag(name) {
            if(name === 'script') {
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

    const marker = 'var jobImpressions ='
    for(const script of scripts) {
        //console.log(script)

        const mi = script.indexOf(marker)
        if(mi === -1) continue

        const start = script.indexOf('[', mi + marker.length)
        if(start === -1) continue

        // Walk forward counting brackets, ignoring those inside string literals
        // (single, double or template quotes), respecting backslash escapes.
        let depth = 0
        let quote: string | null = null
        let end = -1
        for(let i = start; i < script.length; i++) {
            const ch = script[i]
            if(quote !== null) {
                if(ch === '\\') {
                    i++
                    continue
                }
                if(ch === quote) quote = null
                continue
            }
            if(ch === '"' || ch === "'" || ch === '`') {
                quote = ch
                continue
            }
            if(ch === '[') {
                depth++
            }
            else if(ch === ']') {
                depth--
                if(depth === 0) {
                    end = i
                    break
                }
            }
        }

        if(end === -1) {
            log.W('Could not find bounds of jobImpressions array')
            continue
        }

        try {
            return JSON5.parse(script.slice(start, end + 1))
        }
        catch(err) {
            log.W('Could not parse jobImpressions: ', [err])
            continue
        }
    }

    return undefined
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
